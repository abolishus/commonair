-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- W2 protections (batch 6; ADR 0013, ADR 0014, decisions (f), (g)), in addition to 0001, 0016,
-- 0021, 0025, 0029, 0034 and 0038, against a caller with ordinary DML on every table who does not
-- own them (AGENTS.md rule 9):
--   1. Rehearsals (decision (f)): `broadcasts.kind` never changes; a rehearsal broadcast is refused
--      in `channels.live_broadcast_id`, `stream_hours`, ledger postings that reference a broadcast,
--      the audience rollup tables and `integrity_attestations`. Patronage inputs carry no broadcast:
--      their streaming hours come from `stream_hours` (refused here); their viewer hours read
--      `playback_sessions` and must filter `broadcasts.kind` in the query (packages/patronage).
--      `rehearsal_invitees`: at most five per arm, never the owner, only on the channel's rehearsal.
--   2. Revenue splits (ADR 0013 decision 8): a version's channel, number, basis and start never
--      change; proposed -> accepted (every recipient accepted, and the bps of overlapping accepted
--      versions covering each payment kind total at most 10,000) | rejected (a recipient refused)
--      | ended; accepted -> ended, never backdated; once a payment links to a version only the end
--      changes it; versions are never deleted. Shares are written only while the version is
--      proposed, never name the channel owner, and never change; acceptances once per recipient of
--      a proposed version, never changed. A posting link must be a `payment` whose metadata
--      `splitVersionId` is the version, and is append-only.
--   3. Split suspense and write-offs (ADR 0013 decisions 6, 7): a debit of a
--      `liability:split-suspense:*` account only by `split_suspense_release` or
--      `split_suspense_forfeit`, with an `audit_log` row for that ledger transaction written before
--      commit; a `split_shortfall_writeoff` posting only for an approved write-off proposal; a
--      proposal is made by a treasurer or admin and decided by a different treasurer or admin, never
--      by the owner; decided proposals are frozen; never deleted.
--   4. Attestations (ADR 0014 decisions 1, 4, 5): signing keys are append-only except setting
--      `retired_at` and `compromised_at` once each; attestations are append-only, serialized per
--      channel by the advisory lock the worker takes too, and refuse a `seq` that is not head + 1, a
--      `prev_hash` that is not the head's `entry_hash`, a retired or compromised `kid`, a broadcast of
--      another channel and a second `broadcast` entry for one broadcast.
--   5. commonair_configure_app_role: the app loses UPDATE/DELETE on the append-only tables above
--      (redefined from 0038's version; the migrate job re-runs it after every migration).
-- Functions pin search_path and schema-qualify tables (ADR 0004).

-- 1. Rehearsals ---------------------------------------------------------------------------
CREATE FUNCTION commonair_broadcast_kind_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'a broadcast''s kind never changes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER broadcasts_kind_frozen BEFORE UPDATE OF kind ON public.broadcasts
  FOR EACH ROW EXECUTE FUNCTION commonair_broadcast_kind_frozen();
--> statement-breakpoint

CREATE FUNCTION commonair_is_rehearsal(b uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.broadcasts WHERE id = b AND kind = 'rehearsal')
$$;
--> statement-breakpoint

-- Every table below names the broadcast in `broadcast_id`.
CREATE FUNCTION commonair_refuse_rehearsal_broadcast() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF public.commonair_is_rehearsal(NEW.broadcast_id) THEN
    RAISE EXCEPTION 'a rehearsal broadcast never reaches %', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER stream_hours_no_rehearsal BEFORE INSERT OR UPDATE ON public.stream_hours
  FOR EACH ROW EXECUTE FUNCTION commonair_refuse_rehearsal_broadcast();
--> statement-breakpoint
CREATE TRIGGER broadcast_audience_minutes_no_rehearsal BEFORE INSERT OR UPDATE ON public.broadcast_audience_minutes
  FOR EACH ROW EXECUTE FUNCTION commonair_refuse_rehearsal_broadcast();
--> statement-breakpoint
CREATE TRIGGER broadcast_audience_totals_no_rehearsal BEFORE INSERT OR UPDATE ON public.broadcast_audience_totals
  FOR EACH ROW EXECUTE FUNCTION commonair_refuse_rehearsal_broadcast();
--> statement-breakpoint
CREATE TRIGGER broadcast_costs_no_rehearsal BEFORE INSERT OR UPDATE ON public.broadcast_costs
  FOR EACH ROW EXECUTE FUNCTION commonair_refuse_rehearsal_broadcast();
--> statement-breakpoint

CREATE FUNCTION commonair_ledger_no_rehearsal() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.ref_type = 'broadcast' AND public.commonair_is_rehearsal(NEW.ref_id) THEN
    RAISE EXCEPTION 'a rehearsal broadcast is never posted to the ledger' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_no_rehearsal BEFORE INSERT ON public.ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION commonair_ledger_no_rehearsal();
--> statement-breakpoint

CREATE FUNCTION commonair_channel_live_not_rehearsal() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.live_broadcast_id IS NOT NULL AND public.commonair_is_rehearsal(NEW.live_broadcast_id) THEN
    RAISE EXCEPTION 'a rehearsal is never a channel''s live broadcast' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER channels_live_not_rehearsal BEFORE INSERT OR UPDATE OF live_broadcast_id ON public.channels
  FOR EACH ROW EXECUTE FUNCTION commonair_channel_live_not_rehearsal();
--> statement-breakpoint

CREATE FUNCTION commonair_rehearsal_invitee_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n integer;
BEGIN
  IF EXISTS (SELECT 1 FROM public.channels c WHERE c.id = NEW.channel_id AND c.owner_id = NEW.user_id) THEN
    RAISE EXCEPTION 'the channel owner is never a rehearsal invitee' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.broadcast_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.broadcasts b
       WHERE b.id = NEW.broadcast_id AND b.channel_id = NEW.channel_id AND b.kind = 'rehearsal') THEN
    RAISE EXCEPTION 'invitees belong to the channel''s rehearsal broadcast' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.arm_id IS DISTINCT FROM OLD.arm_id OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
                           OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    RAISE EXCEPTION 'an invitee row only gains its broadcast' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- Serializes concurrent invites of one arm, so two cannot both see four.
    PERFORM pg_advisory_xact_lock(hashtext('rehearsal-invitees:' || NEW.arm_id::text));
    SELECT count(*) INTO n FROM public.rehearsal_invitees WHERE arm_id = NEW.arm_id;
    IF n >= 5 THEN
      RAISE EXCEPTION 'a rehearsal has at most 5 invitees' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER rehearsal_invitees_guard BEFORE INSERT OR UPDATE ON public.rehearsal_invitees
  FOR EACH ROW EXECUTE FUNCTION commonair_rehearsal_invitee_guard();
--> statement-breakpoint

-- 2. Revenue splits -----------------------------------------------------------------------
-- The crew bps of the channel's accepted (or ended) versions whose window overlaps `s` and whose
-- basis covers payment kind `k` (`tips` or `subs`), `s` included.
CREATE FUNCTION commonair_split_bps_covering(s public.revenue_splits, k text) RETURNS bigint
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(sum(sh.bps), 0)
    FROM public.revenue_splits o
    JOIN public.revenue_split_shares sh ON sh.split_id = o.id
   WHERE o.channel_id = s.channel_id
     AND (o.id = s.id OR o.status IN ('accepted', 'ended'))
     AND o.basis::text IN (k, 'all')
     AND tstzrange(o.starts_at, o.ends_at) && tstzrange(s.starts_at, s.ends_at)
$$;
--> statement-breakpoint

CREATE FUNCTION commonair_revenue_split_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  k text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'revenue split versions are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Serializes version changes per channel, so two accepts cannot both pass the bps cap.
  PERFORM pg_advisory_xact_lock(hashtext('revenue-splits:' || NEW.channel_id::text));
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'proposed' OR NEW.accepted_at IS NOT NULL OR NEW.rejected_at IS NOT NULL
       OR NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'a split version starts proposed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.channel_id IS DISTINCT FROM OLD.channel_id OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.basis IS DISTINCT FROM OLD.basis OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a split version''s channel, number, basis and start never change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = OLD.status THEN
    IF (to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
      RAISE EXCEPTION 'a split version changes only by its status' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'proposed' AND NEW.status = 'accepted' THEN
    IF NEW.accepted_at IS NULL OR NEW.rejected_at IS NOT NULL OR NEW.ended_at IS NOT NULL
       OR NEW.ends_at IS DISTINCT FROM OLD.ends_at THEN
      RAISE EXCEPTION 'an acceptance sets accepted_at only' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.revenue_split_shares WHERE split_id = NEW.id) THEN
      RAISE EXCEPTION 'a split version has at least one recipient' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.revenue_split_shares sh
               WHERE sh.split_id = NEW.id AND NOT EXISTS (
                 SELECT 1 FROM public.revenue_split_acceptances a
                 WHERE a.split_id = sh.split_id AND a.recipient_user_id = sh.recipient_user_id
                   AND a.decision = 'accepted')) THEN
      RAISE EXCEPTION 'every recipient must accept a split version' USING ERRCODE = 'check_violation';
    END IF;
    FOREACH k IN ARRAY ARRAY['tips', 'subs'] LOOP
      IF public.commonair_split_bps_covering(NEW, k) > 10000 THEN
        RAISE EXCEPTION 'split shares covering % exceed 10000 basis points', k USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;
  IF OLD.status = 'proposed' AND NEW.status = 'rejected' THEN
    IF NEW.rejected_at IS NULL OR NEW.accepted_at IS NOT NULL OR NEW.ended_at IS NOT NULL
       OR NEW.ends_at IS DISTINCT FROM OLD.ends_at THEN
      RAISE EXCEPTION 'a rejection sets rejected_at only' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.revenue_split_acceptances a
                   WHERE a.split_id = NEW.id AND a.decision = 'rejected') THEN
      RAISE EXCEPTION 'a split version is rejected only by a recipient''s refusal' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('proposed', 'accepted') AND NEW.status = 'ended' THEN
    -- Ending takes effect for payments after the end; it is never backdated (a minute of clock skew allowed).
    IF NEW.ended_at IS NULL OR NEW.ends_at IS NULL OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
       OR NEW.rejected_at IS NOT NULL
       OR NEW.ends_at < now() - interval '1 minute'
       OR (OLD.ends_at IS NOT NULL AND NEW.ends_at > OLD.ends_at) THEN
      RAISE EXCEPTION 'an end sets ended_at and an end time not in the past' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'split version status % cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER revenue_splits_guard BEFORE INSERT OR UPDATE OR DELETE ON public.revenue_splits
  FOR EACH ROW EXECUTE FUNCTION commonair_revenue_split_guard();
--> statement-breakpoint
CREATE TRIGGER revenue_splits_no_truncate BEFORE TRUNCATE ON public.revenue_splits
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

CREATE FUNCTION commonair_revenue_split_share_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  sp public.revenue_splits;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'split shares never change: propose a new version' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO sp FROM public.revenue_splits WHERE id = (CASE TG_OP WHEN 'DELETE' THEN OLD.split_id ELSE NEW.split_id END)
    FOR SHARE;
  IF sp.status IS DISTINCT FROM 'proposed' THEN
    RAISE EXCEPTION 'split shares are frozen once the version leaves proposed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM public.channels c WHERE c.id = sp.channel_id AND c.owner_id = NEW.recipient_user_id) THEN
    RAISE EXCEPTION 'the channel owner is never a crew recipient' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER revenue_split_shares_guard BEFORE INSERT OR UPDATE OR DELETE ON public.revenue_split_shares
  FOR EACH ROW EXECUTE FUNCTION commonair_revenue_split_share_guard();
--> statement-breakpoint
CREATE TRIGGER revenue_split_shares_no_truncate BEFORE TRUNCATE ON public.revenue_split_shares
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

CREATE FUNCTION commonair_revenue_split_acceptance_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'split acceptances are append-only (% rejected)', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.revenue_splits WHERE id = NEW.split_id AND status = 'proposed') THEN
    RAISE EXCEPTION 'only a proposed split version is accepted or refused' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.revenue_split_shares
                 WHERE split_id = NEW.split_id AND recipient_user_id = NEW.recipient_user_id) THEN
    RAISE EXCEPTION 'only a recipient answers a split version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER revenue_split_acceptances_guard BEFORE INSERT OR UPDATE OR DELETE ON public.revenue_split_acceptances
  FOR EACH ROW EXECUTE FUNCTION commonair_revenue_split_acceptance_guard();
--> statement-breakpoint
CREATE TRIGGER revenue_split_acceptances_no_truncate BEFORE TRUNCATE ON public.revenue_split_acceptances
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

CREATE FUNCTION commonair_revenue_split_posting_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'split posting links are append-only (% rejected)', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ledger_transactions t
                 WHERE t.id = NEW.ledger_transaction_id AND t.kind = 'payment'
                   AND t.metadata->>'splitVersionId' = NEW.split_id::text) THEN
    RAISE EXCEPTION 'a split link names a payment posting whose splitVersionId is the version' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.revenue_splits WHERE id = NEW.split_id AND status IN ('accepted', 'ended')) THEN
    RAISE EXCEPTION 'only an accepted split version applies to a payment' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER revenue_split_postings_guard BEFORE INSERT OR UPDATE OR DELETE ON public.revenue_split_postings
  FOR EACH ROW EXECUTE FUNCTION commonair_revenue_split_posting_guard();
--> statement-breakpoint
CREATE TRIGGER revenue_split_postings_no_truncate BEFORE TRUNCATE ON public.revenue_split_postings
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 3. Split suspense and write-offs --------------------------------------------------------
-- At commit (entries and the audit row are all present by then): a debit of a split-suspense
-- account is a release or a forfeit, and the transaction carries its audit row. The ledger
-- transaction's id is new in this database transaction, so a row naming it is this transaction's.
CREATE FUNCTION commonair_split_suspense_debit_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  k text;
BEGIN
  IF NEW.amount_cents <= 0 OR NOT EXISTS (
       SELECT 1 FROM public.ledger_accounts a
       WHERE a.id = NEW.account_id AND a.code LIKE 'liability:split-suspense:%') THEN
    RETURN NULL;
  END IF;
  SELECT t.kind INTO k FROM public.ledger_transactions t WHERE t.id = NEW.transaction_id;
  IF k IS NULL OR k NOT IN ('split_suspense_release', 'split_suspense_forfeit') THEN
    RAISE EXCEPTION 'split suspense is debited only by a release or a forfeit (not %)', k
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audit_log l
                 WHERE l.subject_type = 'ledger_transaction' AND l.subject_id = NEW.transaction_id::text) THEN
    RAISE EXCEPTION 'a split suspense % needs its audit_log row in the same transaction', k
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_split_suspense AFTER INSERT ON public.ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.amount_cents > 0) EXECUTE FUNCTION commonair_split_suspense_debit_check();
--> statement-breakpoint

CREATE FUNCTION commonair_split_writeoff_posting_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.split_writeoff_proposals p
                 WHERE p.ledger_transaction_id = NEW.id AND p.status = 'approved') THEN
    RAISE EXCEPTION 'a split shortfall write-off is posted only for an approved proposal' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_transactions_split_writeoff AFTER INSERT ON public.ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.kind = 'split_shortfall_writeoff')
  EXECUTE FUNCTION commonair_split_writeoff_posting_check();
--> statement-breakpoint

CREATE FUNCTION commonair_is_finance(u uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.users WHERE id = u AND role::text IN ('treasurer', 'admin') AND NOT banned)
$$;
--> statement-breakpoint

-- The two-person rule (ADR 0013 decision 6, modeled on 0021's patronage approval).
CREATE FUNCTION commonair_split_writeoff_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'write-off proposals are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'proposed' OR NEW.decided_by_id IS NOT NULL OR NEW.decided_at IS NOT NULL
       OR NEW.ledger_transaction_id IS NOT NULL THEN
      RAISE EXCEPTION 'a write-off starts proposed and undecided' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.proposed_by_id = NEW.owner_user_id OR NOT public.commonair_is_finance(NEW.proposed_by_id) THEN
      RAISE EXCEPTION 'only a treasurer or an admin other than the owner proposes a write-off'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'proposed' THEN
    RAISE EXCEPTION 'a decided write-off is frozen' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','decided_by_id','decided_at','ledger_transaction_id'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','decided_by_id','decided_at','ledger_transaction_id']) THEN
    RAISE EXCEPTION 'a write-off changes only by its decision' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status NOT IN ('approved', 'rejected') OR NEW.decided_by_id IS NULL OR NEW.decided_at IS NULL THEN
    RAISE EXCEPTION 'a decision sets approved or rejected, the decider and the time' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.decided_by_id = OLD.proposed_by_id OR NEW.decided_by_id = OLD.owner_user_id
     OR NOT public.commonair_is_finance(NEW.decided_by_id) THEN
    RAISE EXCEPTION 'a write-off is decided by a second treasurer or admin, not the proposer or the owner'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = 'approved' AND NOT EXISTS (
       SELECT 1 FROM public.ledger_transactions t
       WHERE t.id = NEW.ledger_transaction_id AND t.kind = 'split_shortfall_writeoff') THEN
    RAISE EXCEPTION 'an approval names its split_shortfall_writeoff posting' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'rejected' AND NEW.ledger_transaction_id IS NOT NULL THEN
    RAISE EXCEPTION 'a rejected write-off posts nothing' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER split_writeoff_proposals_guard BEFORE INSERT OR UPDATE OR DELETE ON public.split_writeoff_proposals
  FOR EACH ROW EXECUTE FUNCTION commonair_split_writeoff_guard();
--> statement-breakpoint
CREATE TRIGGER split_writeoff_proposals_no_truncate BEFORE TRUNCATE ON public.split_writeoff_proposals
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 4. Attestations -------------------------------------------------------------------------
CREATE FUNCTION commonair_integrity_signing_key_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'signing keys are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.retired_at IS NOT NULL OR NEW.compromised_at IS NOT NULL THEN
      RAISE EXCEPTION 'a signing key starts active' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['retired_at','compromised_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['retired_at','compromised_at'])
     OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at)
     OR (OLD.compromised_at IS NOT NULL AND NEW.compromised_at IS DISTINCT FROM OLD.compromised_at) THEN
    RAISE EXCEPTION 'a signing key only gains retired_at and compromised_at, once each' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER integrity_signing_keys_guard BEFORE INSERT OR UPDATE OR DELETE ON public.integrity_signing_keys
  FOR EACH ROW EXECUTE FUNCTION commonair_integrity_signing_key_guard();
--> statement-breakpoint
CREATE TRIGGER integrity_signing_keys_no_truncate BEFORE TRUNCATE ON public.integrity_signing_keys
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

CREATE FUNCTION commonair_integrity_attestation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  head public.integrity_attestations;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'attestations are append-only (% rejected)', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The worker takes the same lock before it reads the head (ADR 0014 decision 5); taking it here
  -- serializes appends even for a caller that forgot to.
  PERFORM pg_advisory_xact_lock(hashtext('integrity:attestation:' || NEW.channel_id::text));
  IF NOT EXISTS (SELECT 1 FROM public.broadcasts b WHERE b.id = NEW.broadcast_id AND b.channel_id = NEW.channel_id) THEN
    RAISE EXCEPTION 'an attestation names a broadcast of its own channel' USING ERRCODE = 'check_violation';
  END IF;
  IF public.commonair_is_rehearsal(NEW.broadcast_id) THEN
    RAISE EXCEPTION 'a rehearsal broadcast is never attested' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.integrity_signing_keys k
                 WHERE k.kid = NEW.kid AND k.retired_at IS NULL AND k.compromised_at IS NULL) THEN
    RAISE EXCEPTION 'attestations are signed only by the active, uncompromised key' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO head FROM public.integrity_attestations
   WHERE channel_id = NEW.channel_id ORDER BY seq DESC LIMIT 1;
  IF NEW.seq IS DISTINCT FROM coalesce(head.seq, 0) + 1 THEN
    RAISE EXCEPTION 'attestation seq must be the head + 1 (%)', coalesce(head.seq, 0) + 1 USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.prev_hash IS DISTINCT FROM head.entry_hash THEN
    RAISE EXCEPTION 'attestation prev_hash must be the head''s entry_hash' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'broadcast' AND EXISTS (SELECT 1 FROM public.integrity_attestations
                                        WHERE broadcast_id = NEW.broadcast_id AND kind = 'broadcast') THEN
    RAISE EXCEPTION 'a broadcast has exactly one broadcast entry; append a supersede' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind <> 'broadcast' AND NOT EXISTS (SELECT 1 FROM public.integrity_attestations
                                             WHERE broadcast_id = NEW.broadcast_id AND entry_hash = NEW.supersedes) THEN
    RAISE EXCEPTION 'a supersede or reissue names an entry of the same broadcast' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER integrity_attestations_guard BEFORE INSERT OR UPDATE OR DELETE ON public.integrity_attestations
  FOR EACH ROW EXECUTE FUNCTION commonair_integrity_attestation_guard();
--> statement-breakpoint
CREATE TRIGGER integrity_attestations_no_truncate BEFORE TRUNCATE ON public.integrity_attestations
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 5. App role (additions only to 0038's version) -------------------------------------------
CREATE OR REPLACE FUNCTION commonair_configure_app_role(r name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r);
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', r);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', r);
  EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM %I', r);
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.governance_settings_history, public.governance_applications,
    public.vote_history, public.membership_history, public.proposal_electorate FROM %I', r);
  EXECUTE format('REVOKE INSERT, DELETE ON public.governance_settings FROM %I', r);
  EXECUTE format('REVOKE UPDATE, DELETE ON public.ledger_transactions, public.ledger_entries, public.audit_log FROM %I', r);
  EXECUTE format('REVOKE DELETE ON public.ledger_accounts, public.votes, public.memberships FROM %I', r);
  -- Trust & safety (0016): evidence and flags are append-only; holds, drafts, cases, labels,
  -- the local block list and undecided NCII requests are never deleted by the app.
  EXECUTE format('REVOKE UPDATE, DELETE ON public.moderation_flags, public.evidence_objects FROM %I', r);
  EXECUTE format('REVOKE DELETE ON public.legal_holds, public.ncmec_reports, public.moderation_cases,
    public.content_labels, public.local_hash_list FROM %I', r);
  -- Co-op (0021): tallies, council terms, seats and responses are append-only; shares are never deleted.
  EXECUTE format('REVOKE UPDATE, DELETE ON public.tallies, public.council_terms, public.council_members,
    public.council_responses FROM %I', r);
  EXECUTE format('REVOKE DELETE ON public.membership_shares FROM %I', r);
  -- E7 (0025): account actions and DMCA records are never deleted by the app.
  EXECUTE format('REVOKE DELETE ON public.account_actions, public.dmca_notices, public.dmca_counter_notices, public.dmca_notice_items FROM %I', r);
  -- W0 (0029): statements of reasons are append-only.
  EXECUTE format('REVOKE UPDATE, DELETE ON public.enforcement_statements FROM %I', r);
  -- E8 (0034): points are a ledger; balances are trigger-written.
  EXECUTE format('REVOKE UPDATE, DELETE ON public.loyalty_transactions FROM %I', r);
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.loyalty_balances FROM %I', r);
  -- W1 (0038): fraud flags are never deleted.
  EXECUTE format('REVOKE DELETE, TRUNCATE ON public.payment_fraud_flags FROM %I', r);
  -- W2 (0043): attestations, split links and answers are append-only; split versions, write-offs
  -- and signing keys are never deleted.
  EXECUTE format('REVOKE UPDATE, DELETE ON public.integrity_attestations, public.revenue_split_postings,
    public.revenue_split_acceptances FROM %I', r);
  EXECUTE format('REVOKE DELETE ON public.integrity_signing_keys, public.revenue_splits,
    public.split_writeoff_proposals FROM %I', r);
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION commonair_configure_app_role(name) FROM PUBLIC;
