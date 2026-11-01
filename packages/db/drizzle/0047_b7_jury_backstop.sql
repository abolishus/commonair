-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Batch 7 jury backstop (decision (u), ADR 0038; W3-jury review), in addition to 0046 §5. The
-- worker's sampler already refuses all of these; the triggers make the database refuse them too
-- (AGENTS.md rule 9):
--   1. A seat is never a bot account.
--   2. `labelled` is still open (a T2 label awaiting review), so a labelled case is never sampled.
--   3. A `chat_message` report's author and a `message_set` report's senders are parties: each
--      must be a known adult with no active legal hold. An author that can no longer be found, or
--      a set naming no sender, fails closed.

CREATE OR REPLACE FUNCTION commonair_jury_seat_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.panel_id IS DISTINCT FROM OLD.panel_id OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    RAISE EXCEPTION 'a jury seat never changes hands' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.memberships m JOIN public.users u ON u.id = m.user_id
                  WHERE m.user_id = NEW.user_id AND m.status = 'active' AND u.deleted_at IS NULL AND NOT u.banned) THEN
    RAISE EXCEPTION 'a juror is an active member' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.users u WHERE u.id = NEW.user_id AND u.role <> 'user') THEN
    RAISE EXCEPTION 'staff never sit on the jury' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.users u WHERE u.id = NEW.user_id AND u.account_type = 'bot') THEN
    RAISE EXCEPTION 'bot accounts never sit on the jury' USING ERRCODE = 'check_violation';
  END IF;
  IF public.commonair_age_band(NEW.user_id) IS DISTINCT FROM 'adult' THEN
    RAISE EXCEPTION 'a juror is a known adult' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.jury_optins o WHERE o.user_id = NEW.user_id AND o.opted_out_at IS NULL) THEN
    RAISE EXCEPTION 'a juror has opted in' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION commonair_jury_case_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  mc public.moderation_cases;
  rp public.reports;
  ch_owner uuid;
  -- A report's message author or set senders (none for other subjects).
  senders uuid[] := '{}';
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Eligibility is checked once, at sampling; afterwards a case can only be withdrawn (once)
    -- or have its pseudonyms and clause reference written.
    IF NEW.panel_id IS DISTINCT FROM OLD.panel_id OR NEW.subject_kind IS DISTINCT FROM OLD.subject_kind
       OR NEW.subject_id IS DISTINCT FROM OLD.subject_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'a jury case''s subject never changes' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.withdrawn_at IS NOT NULL AND (NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at
                                         OR NEW.withdrawn_reason IS DISTINCT FROM OLD.withdrawn_reason) THEN
      RAISE EXCEPTION 'a jury case is withdrawn once' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'a jury case is sampled before it is withdrawn' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.subject_kind = 'moderation_case' THEN
    SELECT * INTO mc FROM public.moderation_cases WHERE id = NEW.subject_id;
    IF mc.id IS NULL THEN
      RAISE EXCEPTION 'a jury case names a moderation case' USING ERRCODE = 'foreign_key_violation';
    END IF;
    -- NCII and minor safety by clause too: a report-origin T1 case carries no list category.
    IF mc.tier = 't0' OR mc.list_category IS NOT NULL
       OR split_part(mc.rule_ref, '@', 1) IN ('decency.intimate-images', 'illegal.ncii', 'safety.minors') THEN
      RAISE EXCEPTION 'T0, hash-list, NCII and minor-safety cases are never sampled' USING ERRCODE = 'check_violation';
    END IF;
    IF mc.status NOT IN ('cleared', 'actioned', 'dismissed', 'confirmed') THEN
      RAISE EXCEPTION 'only decided cases are sampled' USING ERRCODE = 'check_violation';
    END IF;
    SELECT c.owner_id INTO ch_owner FROM public.channels c WHERE c.id = mc.channel_id;
    IF public.commonair_not_known_adult(mc.user_id) OR public.commonair_not_known_adult(ch_owner) THEN
      RAISE EXCEPTION 'cases involving a minor (or an unknown age) are never sampled' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.legal_holds h WHERE h.released_at IS NULL
                AND (h.case_id = mc.id OR h.user_id = mc.user_id OR h.user_id = ch_owner)) THEN
      RAISE EXCEPTION 'cases under legal hold are never sampled' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT * INTO rp FROM public.reports WHERE id = NEW.subject_id;
    IF rp.id IS NULL THEN
      RAISE EXCEPTION 'a jury case names a report' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF rp.status = 'open' THEN
      RAISE EXCEPTION 'only resolved reports are sampled' USING ERRCODE = 'check_violation';
    END IF;
    IF rp.subject_type = 'watch_room' OR rp.reason IN ('ncii', 'minor_safety') THEN
      RAISE EXCEPTION 'watch-room, NCII and minor-safety reports are never sampled' USING ERRCODE = 'check_violation';
    END IF;
    IF rp.subject_type = 'chat_message' THEN
      SELECT array_remove(array_agg(m.user_id), NULL) INTO senders FROM public.chat_messages m WHERE m.id = rp.subject_id;
    ELSIF rp.subject_type = 'message_set' THEN
      -- The wave's senders as the report copied them (`evidence.messages[].userId`).
      SELECT coalesce(array_agg(DISTINCT (e ->> 'userId')::uuid), '{}') INTO senders
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(rp.evidence -> 'messages') = 'array'
                                       THEN rp.evidence -> 'messages' ELSE '[]'::jsonb END) e
       WHERE (e ->> 'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    END IF;
    IF rp.subject_type IN ('chat_message', 'message_set') AND coalesce(cardinality(senders), 0) = 0 THEN
      RAISE EXCEPTION 'a reported message whose sender is unknown is never sampled' USING ERRCODE = 'check_violation';
    END IF;
    SELECT c.owner_id INTO ch_owner FROM public.channels c WHERE c.id = rp.channel_id;
    IF public.commonair_not_known_adult(rp.reporter_id) OR public.commonair_not_known_adult(ch_owner)
       OR (rp.subject_type = 'user' AND public.commonair_not_known_adult(rp.subject_id))
       OR EXISTS (SELECT 1 FROM unnest(senders) p WHERE public.commonair_not_known_adult(p)) THEN
      RAISE EXCEPTION 'reports involving a minor (or an unknown age) are never sampled' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.legal_holds h WHERE h.released_at IS NULL
                AND (h.user_id = rp.reporter_id
                     OR (rp.subject_type = 'user' AND h.user_id = rp.subject_id)
                     OR h.user_id = ch_owner
                     OR h.user_id = ANY (senders))) THEN
      RAISE EXCEPTION 'reports under legal hold are never sampled' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
