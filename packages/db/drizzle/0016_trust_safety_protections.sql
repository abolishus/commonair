-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Trust & safety protections (ADR 0006, docs/testing/e4c-selectors.md), enforced by the database
-- so that no application path, bug or compromised app credential can lose evidence, lift a
-- hold, skip the two-reviewer T0 dismissal, shorten the NCII deadline or switch moderation off:
--   1. moderation_flags and evidence_objects are append-only for every role.
--   2. legal_holds are never deleted; only the table owner (the operator CLI) can release one.
--   3. ncmec_reports are never deleted; snapshot and evidence are immutable; filed and withdrawn
--      are terminal, and a draft is withdrawn only for a dismissed case.
--   4. T0 cases move only open -> dismissal_pending -> dismissed (two different `legal` users,
--      neither the subject) or -> confirmed (`legal`). Cases are never deleted.
--   5. A T0 suspension (users.banned / channels.suspended_* with reason t0_hash_match) cannot be
--      lifted while the user has a T0 case that is not dismissed. Media removed by T0 stays removed.
--   6. ncii_requests: received_at is the database clock, deadline_at = received_at + 48 hours,
--      both immutable; undecided requests cannot be deleted; decisions are final.
--   7. channels.mature cannot be unset while an active moderation label exists.
--   8. moderation.thresholds is shape- and range-checked so no vote can switch tiers off.
-- Functions pin search_path and schema-qualify tables (ADR 0004).

-- 1. Append-only ---------------------------------------------------------------------
CREATE TRIGGER moderation_flags_append_only BEFORE UPDATE OR DELETE ON public.moderation_flags
  FOR EACH ROW EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER moderation_flags_no_truncate BEFORE TRUNCATE ON public.moderation_flags
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER evidence_objects_append_only BEFORE UPDATE OR DELETE ON public.evidence_objects
  FOR EACH ROW EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER evidence_objects_no_truncate BEFORE TRUNCATE ON public.evidence_objects
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER evidence_audit_runs_no_truncate BEFORE TRUNCATE ON public.evidence_audit_runs
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- Helpers ----------------------------------------------------------------------------
CREATE FUNCTION commonair_is_legal(u uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT COALESCE((SELECT role::text = 'legal' FROM public.users WHERE id = u), false)
$$;
--> statement-breakpoint

-- 2. Holds ---------------------------------------------------------------------------
CREATE FUNCTION commonair_legal_hold_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'legal holds cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.released_at IS NOT NULL OR NEW.release_reason IS NOT NULL OR NEW.eligible_for_release_at IS NOT NULL THEN
      RAISE EXCEPTION 'a hold starts active' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'a released hold is final' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.reason_code <> OLD.reason_code
     OR NEW.reason <> OLD.reason OR NEW.case_id IS DISTINCT FROM OLD.case_id
     OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a hold''s subject and reason are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.filed_at IS NOT NULL AND NEW.filed_at IS DISTINCT FROM OLD.filed_at THEN
    RAISE EXCEPTION 'legal_holds.filed_at is set once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.eligible_for_release_at IS NOT NULL AND NEW.eligible_for_release_at IS DISTINCT FROM OLD.eligible_for_release_at THEN
    RAISE EXCEPTION 'legal_holds.eligible_for_release_at is set once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.eligible_for_release_at IS NOT NULL AND OLD.eligible_for_release_at IS NULL
     AND (NEW.filed_at IS NULL OR NEW.eligible_for_release_at < NEW.filed_at + interval '1 year') THEN
    RAISE EXCEPTION 'a hold becomes eligible for release one year after filing at the earliest'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.released_at IS NOT NULL OR NEW.release_reason IS NOT NULL THEN
    IF NOT public.commonair_is_owner(TG_RELID) THEN
      RAISE EXCEPTION 'only the database owner can release a legal hold' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.released_at IS NULL OR coalesce(length(trim(NEW.release_reason)), 0) = 0 THEN
      RAISE EXCEPTION 'releasing a hold needs released_at and a reason' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER legal_holds_guard BEFORE INSERT OR UPDATE OR DELETE ON public.legal_holds
  FOR EACH ROW EXECUTE FUNCTION commonair_legal_hold_guard();
--> statement-breakpoint
CREATE TRIGGER legal_holds_no_truncate BEFORE TRUNCATE ON public.legal_holds
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 3. NCMEC drafts --------------------------------------------------------------------
CREATE FUNCTION commonair_ncmec_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'NCMEC reports cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.filed_at IS NOT NULL OR NEW.withdrawn_at IS NOT NULL THEN
      RAISE EXCEPTION 'an NCMEC report starts as a draft' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.case_id <> OLD.case_id OR NEW.hold_id <> OLD.hold_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
     OR NEW.incident_at <> OLD.incident_at OR NEW.list_category IS DISTINCT FROM OLD.list_category
     OR NEW.snapshot_sealed <> OLD.snapshot_sealed OR NEW.key_id <> OLD.key_id
     OR NEW.evidence_ids <> OLD.evidence_ids OR NEW.target <> OLD.target OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'an NCMEC report''s contents are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'draft' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'a % NCMEC report is final', OLD.status USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'filed' THEN
    IF coalesce(length(trim(NEW.external_report_id)), 0) = 0 OR NEW.filed_at IS NULL OR NEW.filed_by_id IS NULL
       OR NOT public.commonair_is_legal(NEW.filed_by_id) THEN
      RAISE EXCEPTION 'filing needs the report id, the time and a legal user' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status = 'withdrawn' THEN
    IF NEW.withdrawn_at IS NULL OR NEW.withdrawn_by_id IS NULL OR NOT public.commonair_is_legal(NEW.withdrawn_by_id)
       OR NOT EXISTS (SELECT 1 FROM public.moderation_cases c WHERE c.id = NEW.case_id AND c.status = 'dismissed') THEN
      RAISE EXCEPTION 'a draft is withdrawn only by a legal user for a dismissed case' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.filed_at IS NOT NULL OR NEW.withdrawn_at IS NOT NULL OR NEW.external_report_id IS NOT NULL THEN
    RAISE EXCEPTION 'filing and withdrawal fields go with their status' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ncmec_reports_guard BEFORE INSERT OR UPDATE OR DELETE ON public.ncmec_reports
  FOR EACH ROW EXECUTE FUNCTION commonair_ncmec_guard();
--> statement-breakpoint
CREATE TRIGGER ncmec_reports_no_truncate BEFORE TRUNCATE ON public.ncmec_reports
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 4. Cases ---------------------------------------------------------------------------
CREATE FUNCTION commonair_moderation_case_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'moderation cases cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT (NEW.status = 'open' OR (NEW.tier = 't2' AND NEW.status = 'labelled'))
       OR NEW.first_reviewer_id IS NOT NULL OR NEW.resolved_at IS NOT NULL THEN
      RAISE EXCEPTION 'a moderation case starts undecided' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.subject_type <> OLD.subject_type OR NEW.subject_id <> OLD.subject_id
     OR NEW.channel_id IS DISTINCT FROM OLD.channel_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a case''s subject is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.tier = 't0' AND NEW.tier <> 't0' THEN
    RAISE EXCEPTION 'a T0 case stays T0' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.tier = 't0' AND OLD.tier <> 't0' THEN
    -- Escalation to legal (human origin) reopens the case for `legal` only.
    IF NEW.status <> 'open' OR NEW.origin <> 'human' OR OLD.status NOT IN ('open', 'labelled') THEN
      RAISE EXCEPTION 'escalation to T0 opens a human-origin case' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tier <> 't0' THEN
    RETURN NEW;
  END IF;
  -- T0 lifecycle.
  IF NEW.origin <> OLD.origin OR NEW.list_category IS DISTINCT FROM OLD.list_category THEN
    RAISE EXCEPTION 'a T0 case''s origin is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IN ('confirmed', 'dismissed') THEN
    IF NEW.status <> OLD.status OR NEW.resolved_by_id IS DISTINCT FROM OLD.resolved_by_id
       OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at OR NEW.first_reviewer_id IS DISTINCT FROM OLD.first_reviewer_id THEN
      RAISE EXCEPTION 'a % T0 case is final', OLD.status USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'dismissal_pending' AND (NEW.first_reviewer_id IS DISTINCT FROM OLD.first_reviewer_id
     OR NEW.first_reviewed_at IS DISTINCT FROM OLD.first_reviewed_at) THEN
    RAISE EXCEPTION 'the first reviewer is fixed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = OLD.status THEN
    IF NEW.first_reviewer_id IS DISTINCT FROM OLD.first_reviewer_id OR NEW.resolved_by_id IS DISTINCT FROM OLD.resolved_by_id THEN
      RAISE EXCEPTION 'reviews go with a status change' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'open' AND NEW.status = 'dismissal_pending' THEN
    IF NEW.first_reviewer_id IS NULL OR NEW.first_reviewed_at IS NULL OR coalesce(length(trim(NEW.first_review_note)), 0) = 0
       OR NOT public.commonair_is_legal(NEW.first_reviewer_id) OR NEW.first_reviewer_id = NEW.user_id THEN
      RAISE EXCEPTION 'the first dismissal needs a legal reviewer other than the subject, and a note'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.status = 'dismissal_pending' AND NEW.status = 'dismissed' THEN
    IF NEW.resolved_by_id IS NULL OR NEW.resolved_at IS NULL OR coalesce(length(trim(NEW.resolution_note)), 0) = 0
       OR NOT public.commonair_is_legal(NEW.resolved_by_id)
       OR NEW.resolved_by_id = NEW.first_reviewer_id OR NEW.resolved_by_id = NEW.user_id THEN
      RAISE EXCEPTION 'dismissing a T0 case needs a second, different legal reviewer and a note'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.status IN ('open', 'dismissal_pending') AND NEW.status = 'confirmed' THEN
    IF NEW.resolved_by_id IS NULL OR NEW.resolved_at IS NULL OR NOT public.commonair_is_legal(NEW.resolved_by_id)
       OR NEW.resolved_by_id = NEW.user_id THEN
      RAISE EXCEPTION 'confirming a T0 case needs a legal reviewer' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'T0 case cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER moderation_cases_guard BEFORE INSERT OR UPDATE OR DELETE ON public.moderation_cases
  FOR EACH ROW EXECUTE FUNCTION commonair_moderation_case_guard();
--> statement-breakpoint
CREATE TRIGGER moderation_cases_no_truncate BEFORE TRUNCATE ON public.moderation_cases
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 5. T0 suspension and removal stick ----------------------------------------------------
CREATE FUNCTION commonair_t0_case_active(u uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.moderation_cases c
                 WHERE c.user_id = u AND c.tier = 't0' AND c.status IN ('open', 'dismissal_pending', 'confirmed'))
$$;
--> statement-breakpoint
CREATE FUNCTION commonair_users_t0_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.banned AND OLD.ban_reason = 't0_hash_match'
     AND (NOT NEW.banned OR NEW.ban_reason IS DISTINCT FROM OLD.ban_reason OR NEW.ban_expires IS NOT NULL)
     AND public.commonair_t0_case_active(OLD.id) AND NOT public.commonair_is_owner(TG_RELID) THEN
    RAISE EXCEPTION 'a T0 suspension is lifted only by dismissing its case' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER users_t0_guard BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION commonair_users_t0_guard();
--> statement-breakpoint
CREATE FUNCTION commonair_channels_t0_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.suspended_at IS NOT NULL AND OLD.suspended_reason = 't0_hash_match'
     AND (NEW.suspended_at IS NULL OR NEW.suspended_reason IS DISTINCT FROM OLD.suspended_reason)
     AND public.commonair_t0_case_active(OLD.owner_id) AND NOT public.commonair_is_owner(TG_RELID) THEN
    RAISE EXCEPTION 'a T0 suspension is lifted only by dismissing its case' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- 7. The mature-label lock.
  IF OLD.mature AND NOT NEW.mature AND EXISTS (
       SELECT 1 FROM public.content_labels l WHERE l.channel_id = OLD.id AND l.label = 'mature' AND l.removed_at IS NULL) THEN
    RAISE EXCEPTION 'the channel carries an active mature label; it is removed by moderation or an appeal'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER channels_t0_guard BEFORE UPDATE ON public.channels
  FOR EACH ROW EXECUTE FUNCTION commonair_channels_t0_guard();
--> statement-breakpoint
CREATE FUNCTION commonair_t0_removed_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.removed_reason = 't0_hash_match' AND (NEW.status <> 'deleted' OR NEW.removed_reason IS DISTINCT FROM OLD.removed_reason)
     AND NOT public.commonair_is_owner(TG_RELID) THEN
    RAISE EXCEPTION 'content removed by a T0 match stays removed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER vods_t0_removed_guard BEFORE UPDATE ON public.vods
  FOR EACH ROW EXECUTE FUNCTION commonair_t0_removed_guard();
--> statement-breakpoint
CREATE TRIGGER clips_t0_removed_guard BEFORE UPDATE ON public.clips
  FOR EACH ROW EXECUTE FUNCTION commonair_t0_removed_guard();
--> statement-breakpoint

-- 6. NCII requests -----------------------------------------------------------------
CREATE FUNCTION commonair_ncii_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.decided_at IS NULL THEN
      RAISE EXCEPTION 'an undecided NCII request cannot be deleted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.received_at := clock_timestamp();
    NEW.deadline_at := NEW.received_at + interval '48 hours';
    IF NEW.status <> 'received' OR NEW.decided_at IS NOT NULL OR NEW.auto_hidden_at IS NOT NULL
       OR NEW.escalated24_at IS NOT NULL OR NEW.escalated36_at IS NOT NULL THEN
      RAISE EXCEPTION 'an NCII request starts received' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.received_at <> OLD.received_at OR NEW.deadline_at <> OLD.deadline_at THEN
    RAISE EXCEPTION 'the NCII clock is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (OLD.decided_at IS NOT NULL AND (NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.status <> OLD.status))
     OR (OLD.auto_hidden_at IS NOT NULL AND NEW.auto_hidden_at IS DISTINCT FROM OLD.auto_hidden_at)
     OR (OLD.escalated24_at IS NOT NULL AND NEW.escalated24_at IS DISTINCT FROM OLD.escalated24_at)
     OR (OLD.escalated36_at IS NOT NULL AND NEW.escalated36_at IS DISTINCT FROM OLD.escalated36_at) THEN
    RAISE EXCEPTION 'NCII decisions and clock marks are final' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IN ('removed', 'rejected') AND (NEW.decided_at IS NULL OR NEW.decided_by_id IS NULL) THEN
    RAISE EXCEPTION 'a decision needs decided_at and decided_by_id' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'auto_hidden' AND (NEW.auto_hidden_at IS NULL OR NEW.auto_hidden_at < NEW.deadline_at) THEN
    RAISE EXCEPTION 'auto-hide happens at the deadline' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'received' AND OLD.status <> 'received' THEN
    RAISE EXCEPTION 'an NCII request cannot go back to received' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ncii_requests_guard BEFORE INSERT OR UPDATE OR DELETE ON public.ncii_requests
  FOR EACH ROW EXECUTE FUNCTION commonair_ncii_guard();
--> statement-breakpoint
CREATE TRIGGER ncii_requests_no_truncate BEFORE TRUNCATE ON public.ncii_requests
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 7. Labels, local block list --------------------------------------------------------
CREATE FUNCTION commonair_revocable_row_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  o jsonb := to_jsonb(OLD);
  n jsonb := to_jsonb(NEW);
  k text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'rows in % are never deleted', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Only the removal columns (TG_ARGV) may change, once, from NULL.
  FOR k IN SELECT jsonb_object_keys(o) LOOP
    IF k = ANY (TG_ARGV) THEN
      IF o->k <> 'null'::jsonb AND n->k IS DISTINCT FROM o->k THEN
        RAISE EXCEPTION '%.% is set once', TG_TABLE_NAME, k USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF n->k IS DISTINCT FROM o->k THEN
      RAISE EXCEPTION '%.% is immutable', TG_TABLE_NAME, k USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER content_labels_guard BEFORE UPDATE OR DELETE ON public.content_labels
  FOR EACH ROW EXECUTE FUNCTION commonair_revocable_row_guard('removed_at', 'removed_by_id', 'removed_reason');
--> statement-breakpoint
CREATE TRIGGER local_hash_list_guard BEFORE UPDATE OR DELETE ON public.local_hash_list
  FOR EACH ROW EXECUTE FUNCTION commonair_revocable_row_guard('revoked_at', 'revoked_by_id');
--> statement-breakpoint
CREATE TRIGGER local_hash_list_no_truncate BEFORE TRUNCATE ON public.local_hash_list
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 8. moderation.thresholds ------------------------------------------------------------
CREATE FUNCTION commonair_validate_moderation(v jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  k text;
BEGIN
  IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR jsonb_typeof(v->'t1') IS DISTINCT FROM 'object'
     OR jsonb_typeof(v->'t2') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'moderation.thresholds must be an object with t1 and t2 objects' USING ERRCODE = 'check_violation';
  END IF;
  FOREACH k IN ARRAY ARRAY['sexual', 'graphic_violence', 'weapons', 'self_harm'] LOOP
    IF jsonb_typeof(v->'t1'->k) IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'moderation.thresholds.t1.% must be a number', k USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF jsonb_typeof(v->'t2'->'sexual') IS DISTINCT FROM 'number' OR jsonb_typeof(v->'sampleSeconds') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'moderation.thresholds.t2.sexual and sampleSeconds must be numbers' USING ERRCODE = 'check_violation';
  END IF;
  IF (v->'t1'->>'sexual')::numeric NOT BETWEEN 0.85 AND 0.995
     OR (v->'t1'->>'graphic_violence')::numeric NOT BETWEEN 0.5 AND 0.995
     OR (v->'t1'->>'weapons')::numeric NOT BETWEEN 0.5 AND 0.995
     OR (v->'t1'->>'self_harm')::numeric NOT BETWEEN 0.5 AND 0.995
     OR (v->'t2'->>'sexual')::numeric NOT BETWEEN 0.5 AND 0.95
     OR (v->'t2'->>'sexual')::numeric >= (v->'t1'->>'sexual')::numeric
     OR (v->>'sampleSeconds')::numeric NOT BETWEEN 5 AND 60
     OR (v->>'sampleSeconds')::numeric <> trunc((v->>'sampleSeconds')::numeric) THEN
    RAISE EXCEPTION 'moderation.thresholds values out of range' USING ERRCODE = 'check_violation';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION commonair_settings_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  p public.proposals%ROWTYPE;
  t record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'governance settings cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT public.commonair_is_owner(TG_RELID) THEN
      RAISE EXCEPTION 'governance settings are defined by migrations' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.key = 'governance.protections' THEN
      PERFORM public.commonair_validate_protections(NEW.value);
      NEW.protected := true;
    ELSIF public.commonair_protections() IS NULL THEN
      RAISE EXCEPTION 'seed governance.protections before other settings' USING ERRCODE = 'check_violation';
    ELSE
      NEW.protected := public.commonair_is_protected(NEW.key);
    END IF;
    IF NEW.key = 'governance.ordinary' THEN PERFORM public.commonair_validate_ordinary(NEW.value); END IF;
    IF NEW.key = 'moderation.thresholds' THEN PERFORM public.commonair_validate_moderation(NEW.value); END IF;
    NEW.updated_by_proposal_id := NULL;
    RETURN NEW;
  END IF;

  IF NEW.key <> OLD.key OR NEW.description <> OLD.description THEN
    RAISE EXCEPTION 'a setting''s key and description are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.updated_by_proposal_id IS NOT DISTINCT FROM OLD.updated_by_proposal_id THEN
    -- Only the protected-flag re-sync (run as the owner) may touch a row without a new decision.
    IF NEW.value IS DISTINCT FROM OLD.value OR NOT public.commonair_is_owner(TG_RELID) THEN
      RAISE EXCEPTION 'setting % can only change by applying a passed proposal', NEW.key
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.updated_by_proposal_id IS NULL THEN
    RAISE EXCEPTION 'setting % can only change by applying a passed proposal', NEW.key USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO p FROM public.proposals WHERE id = NEW.updated_by_proposal_id;
  IF NOT FOUND OR p.status <> 'passed' THEN
    RAISE EXCEPTION 'proposal % is not a passed, unapplied decision', NEW.updated_by_proposal_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF public.commonair_is_protected(NEW.key) AND p.kind <> 'protected' THEN
    RAISE EXCEPTION 'protected setting % needs a protected decision', NEW.key USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p.changes) c WHERE c->>'key' = NEW.key AND c->'value' = NEW.value) THEN
    RAISE EXCEPTION 'proposal % does not contain this change to %', p.id, NEW.key USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM public.governance_applications a WHERE a.proposal_id = p.id AND a.key = NEW.key) THEN
    RAISE EXCEPTION 'proposal % was already applied to %', p.id, NEW.key USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM public.governance_settings_history h
             WHERE h.key = NEW.key AND h.changed_at > p.voting_starts_at) THEN
    RAISE EXCEPTION 'setting % changed after proposal % opened for voting; the decision is superseded', NEW.key, p.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  t := public.commonair_governance_tally(p.id);
  IF NOT t.passed THEN
    RAISE EXCEPTION 'proposal % fails re-tally: %', p.id, t.reason USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.key = 'governance.protections' THEN PERFORM public.commonair_validate_protections(NEW.value); END IF;
  IF NEW.key = 'governance.ordinary' THEN PERFORM public.commonair_validate_ordinary(NEW.value); END IF;
  IF NEW.key = 'moderation.thresholds' THEN PERFORM public.commonair_validate_moderation(NEW.value); END IF;
  NEW.protected := public.commonair_is_protected(NEW.key);
  RETURN NEW;
END $$;
--> statement-breakpoint

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
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION commonair_configure_app_role(name) FROM PUBLIC;
