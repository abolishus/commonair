-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Hardening of 0001 after a second review (ADR 0004):
--  * Trigger-only tables are guarded by ownership, not pg_trigger_depth() (a caller could
--    raise the depth with its own temp-table trigger). The functions that write them are
--    SECURITY DEFINER, owned by the migration owner, and not executable by PUBLIC.
--  * Rule snapshots and the tally fail closed on missing or malformed fields.
--  * Ledger balance is also checked per entry at commit (SET CONSTRAINTS ALL IMMEDIATE could
--    fire the per-transaction check before later entries were added).
--  * governance.protections and governance.ordinary are bounded so no decision can lock out
--    future decisions.
--  * Applying a decision is all-or-nothing in one transaction, refused when a newer change
--    to the same key happened after its vote opened, and may record a no-op change.
--  * Votes take a share lock on the proposal, so the outcome waits for in-flight votes.
--  * Content edits during discussion restart the discussion period; content never changes
--    in the same statement as a status transition.
--  * commonair_configure_app_role() grants a least-privilege application role.

CREATE FUNCTION commonair_is_owner(rel oid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT pg_has_role(current_user, (SELECT relowner FROM pg_catalog.pg_class WHERE oid = rel), 'MEMBER')
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION commonair_trigger_only_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'table % is append-only (% rejected)', TG_TABLE_NAME, TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT public.commonair_is_owner(TG_RELID) THEN
    RAISE EXCEPTION 'rows in % are written by the database only', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- Validation ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION commonair_validate_protections(v jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  k text;
BEGIN
  IF jsonb_typeof(v) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'governance.protections must be an object' USING ERRCODE = 'check_violation';
  END IF;
  FOREACH k IN ARRAY ARRAY['memberWideThreshold', 'streamerClassThreshold', 'quorum', 'streamerClassQuorum',
                           'councilReviewSeconds', 'minVotingSeconds'] LOOP
    IF jsonb_typeof(v->k) IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'governance.protections.% must be a number', k USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF (v->>'memberWideThreshold')::numeric NOT BETWEEN 0.5 AND 1
     OR (v->>'streamerClassThreshold')::numeric < 0.5 OR (v->>'streamerClassThreshold')::numeric >= 1
     OR (v->>'quorum')::numeric NOT BETWEEN 0 AND 0.5
     OR (v->>'streamerClassQuorum')::numeric NOT BETWEEN 0 AND 0.5
     OR (v->>'councilReviewSeconds')::numeric NOT BETWEEN 0 AND 7776000
     OR (v->>'minVotingSeconds')::numeric NOT BETWEEN 0 AND 7776000 THEN
    RAISE EXCEPTION 'governance.protections values out of range' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(v->'protectedKeys') IS DISTINCT FROM 'array'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v->'protectedKeys') e WHERE jsonb_typeof(e) <> 'string')
     OR NOT (v->'protectedKeys' ? 'governance.protections') THEN
    RAISE EXCEPTION 'governance.protections.protectedKeys must be a string array that includes itself'
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
--> statement-breakpoint

CREATE FUNCTION commonair_validate_ordinary(v jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  k text;
BEGIN
  IF jsonb_typeof(v) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'governance.ordinary must be an object' USING ERRCODE = 'check_violation';
  END IF;
  FOREACH k IN ARRAY ARRAY['threshold', 'quorum', 'discussionSeconds', 'minVotingSeconds', 'votingSeconds'] LOOP
    IF jsonb_typeof(v->k) IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'governance.ordinary.% must be a number', k USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF (v->>'threshold')::numeric < 0.5 OR (v->>'threshold')::numeric >= 1
     OR (v->>'quorum')::numeric NOT BETWEEN 0 AND 0.5
     OR (v->>'discussionSeconds')::numeric NOT BETWEEN 0 AND 7776000
     OR (v->>'minVotingSeconds')::numeric NOT BETWEEN 0 AND 7776000
     OR (v->>'votingSeconds')::numeric NOT BETWEEN (v->>'minVotingSeconds')::numeric AND 7776000 THEN
    RAISE EXCEPTION 'governance.ordinary values out of range' USING ERRCODE = 'check_violation';
  END IF;
END $$;
--> statement-breakpoint

-- Rules and tally fail closed ------------------------------------------------------
CREATE FUNCTION commonair_rules_wellformed(r jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT COALESCE(
    jsonb_typeof(r) = 'object'
    AND jsonb_typeof(r->'protected') = 'boolean'
    AND jsonb_typeof(r->'councilReviewRequired') = 'boolean'
    AND jsonb_typeof(r->'memberWideThreshold') = 'number'
    AND jsonb_typeof(r->'streamerClassThreshold') = 'number'
    AND jsonb_typeof(r->'quorum') = 'number'
    AND jsonb_typeof(r->'streamerClassQuorum') = 'number', false)
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION commonair_rules_acceptable(r jsonb, protected boolean) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  s jsonb;
BEGIN
  IF NOT public.commonair_rules_wellformed(r) THEN RETURN false; END IF;
  IF (r->>'protected')::boolean IS DISTINCT FROM protected THEN RETURN false; END IF;
  IF protected THEN
    s := public.commonair_protections();
    RETURN COALESCE((r->>'memberWideThreshold')::numeric >= (s->>'memberWideThreshold')::numeric
       AND (r->>'streamerClassThreshold')::numeric >= (s->>'streamerClassThreshold')::numeric
       AND (r->>'quorum')::numeric >= (s->>'quorum')::numeric
       AND (r->>'streamerClassQuorum')::numeric >= (s->>'streamerClassQuorum')::numeric
       AND (r->>'councilReviewRequired')::boolean
       AND (r->>'memberWideThreshold')::numeric <= 1
       AND (r->>'streamerClassThreshold')::numeric < 1, false);
  END IF;
  s := public.commonair_setting('governance.ordinary');
  RETURN COALESCE((r->>'memberWideThreshold')::numeric >= (s->>'threshold')::numeric
     AND (r->>'quorum')::numeric >= (s->>'quorum')::numeric
     AND (r->>'memberWideThreshold')::numeric <= 1, false);
EXCEPTION WHEN others THEN
  RETURN false;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION commonair_governance_tally(p_id uuid, OUT passed boolean, OUT reason text)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  p public.proposals%ROWTYPE;
  r jsonb;
  eligible integer; yes integer; no integer; abstain integer;
  s_eligible integer; s_yes integer; s_no integer; s_abstain integer;
BEGIN
  passed := false;
  SELECT * INTO p FROM public.proposals WHERE id = p_id;
  IF NOT FOUND THEN reason := 'proposal not found'; RETURN; END IF;
  r := p.rules;
  IF p.voting_ends_at IS NULL THEN reason := 'voting never opened'; RETURN; END IF;
  IF NOT public.commonair_rules_wellformed(r) THEN reason := 'malformed rules'; RETURN; END IF;
  IF p.voting_ends_at > clock_timestamp() THEN reason := 'voting has not ended'; RETURN; END IF;

  SELECT count(*), count(*) FILTER (WHERE 'streamer' = ANY(classes)) INTO eligible, s_eligible
    FROM public.proposal_electorate WHERE proposal_id = p_id;
  SELECT count(*) FILTER (WHERE v.choice = 'yes'), count(*) FILTER (WHERE v.choice = 'no'),
         count(*) FILTER (WHERE v.choice = 'abstain'),
         count(*) FILTER (WHERE v.choice = 'yes' AND 'streamer' = ANY(e.classes)),
         count(*) FILTER (WHERE v.choice = 'no' AND 'streamer' = ANY(e.classes)),
         count(*) FILTER (WHERE v.choice = 'abstain' AND 'streamer' = ANY(e.classes))
    INTO yes, no, abstain, s_yes, s_no, s_abstain
    FROM public.votes v
    JOIN public.proposal_electorate e ON e.proposal_id = v.proposal_id AND e.user_id = v.user_id
    WHERE v.proposal_id = p_id AND v.cast_at <= p.voting_ends_at;

  IF NOT COALESCE(eligible > 0 AND (yes + no + abstain)::numeric / eligible >= (r->>'quorum')::numeric, false) THEN
    reason := 'member-wide quorum not met'; RETURN;
  END IF;
  IF NOT COALESCE(yes + no > 0 AND yes::numeric / (yes + no) >= (r->>'memberWideThreshold')::numeric, false) THEN
    reason := 'member-wide threshold not met'; RETURN;
  END IF;
  IF (r->>'protected')::boolean THEN
    IF NOT COALESCE(s_eligible > 0
                    AND (s_yes + s_no + s_abstain)::numeric / s_eligible >= (r->>'streamerClassQuorum')::numeric, false) THEN
      reason := 'streamer-class quorum not met'; RETURN;
    END IF;
    IF NOT COALESCE(s_yes + s_no > 0 AND s_yes::numeric / (s_yes + s_no) > (r->>'streamerClassThreshold')::numeric, false) THEN
      reason := 'streamer-class majority not met'; RETURN;
    END IF;
  END IF;
  passed := true; reason := 'passed';
END $$;
--> statement-breakpoint

-- Proposals ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION commonair_proposal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  touches_protected boolean;
  content_changed boolean;
  min_voting numeric;
  t record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN ('draft', 'withdrawn') THEN
      RAISE EXCEPTION 'only draft or withdrawn proposals can be deleted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'proposals start as drafts' USING ERRCODE = 'check_violation';
    END IF;
    NEW.council_review_started_at := NULL; NEW.council_review_ends_at := NULL;
    NEW.voting_starts_at := NULL; NEW.voting_ends_at := NULL; NEW.rules := NULL;
    NEW.decided_at := NULL; NEW.applied_at := NULL; NEW.discussion_ends_at := NULL;
    NEW.created_at := clock_timestamp();
  END IF;

  IF jsonb_typeof(NEW.changes) IS DISTINCT FROM 'array'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.changes) c
                WHERE jsonb_typeof(c) <> 'object' OR NOT (c ? 'key') OR NOT (c ? 'value')
                   OR jsonb_typeof(c->'key') <> 'string'
                   OR NOT EXISTS (SELECT 1 FROM public.governance_settings s WHERE s.key = c->>'key'))
     OR (SELECT count(*) FROM jsonb_array_elements(NEW.changes)) <>
        (SELECT count(DISTINCT c->>'key') FROM jsonb_array_elements(NEW.changes) c) THEN
    RAISE EXCEPTION 'proposal changes must name existing settings, each once' USING ERRCODE = 'check_violation';
  END IF;
  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.changes) c WHERE public.commonair_is_protected(c->>'key'))
    INTO touches_protected;
  IF touches_protected AND (NEW.kind <> 'protected' OR NOT NEW.affects_creators) THEN
    RAISE EXCEPTION 'a proposal changing protected settings must be kind=protected and affect creators'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'protected' AND NOT NEW.affects_creators THEN
    RAISE EXCEPTION 'protected proposals always go through creator council review' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;

  IF NEW.id <> OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a proposal''s id and creation time are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;

  content_changed := NEW.changes IS DISTINCT FROM OLD.changes OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.affects_creators IS DISTINCT FROM OLD.affects_creators OR NEW.title IS DISTINCT FROM OLD.title
       OR NEW.body IS DISTINCT FROM OLD.body OR NEW.author_id IS DISTINCT FROM OLD.author_id;
  IF content_changed AND (OLD.status NOT IN ('draft', 'discussion') OR NEW.status <> OLD.status) THEN
    RAISE EXCEPTION 'a proposal''s content is frozen once review or voting begins, and cannot change during a transition'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.status = OLD.status THEN
    IF NEW.rules IS DISTINCT FROM OLD.rules OR NEW.voting_starts_at IS DISTINCT FROM OLD.voting_starts_at
       OR NEW.voting_ends_at IS DISTINCT FROM OLD.voting_ends_at
       OR NEW.council_review_started_at IS DISTINCT FROM OLD.council_review_started_at
       OR NEW.council_review_ends_at IS DISTINCT FROM OLD.council_review_ends_at
       OR NEW.discussion_ends_at IS DISTINCT FROM OLD.discussion_ends_at
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.applied_at IS DISTINCT FROM OLD.applied_at THEN
      RAISE EXCEPTION 'timeline fields change only with a status transition' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Editing during discussion restarts the discussion period, so members see the final text.
    IF content_changed AND OLD.status = 'discussion' THEN
      NEW.discussion_ends_at := clock_timestamp()
        + make_interval(secs => (public.commonair_setting('governance.ordinary')->>'discussionSeconds')::numeric);
    END IF;
    RETURN NEW;
  END IF;

  IF NOT ((OLD.status, NEW.status) IN (
      ('draft', 'discussion'), ('draft', 'withdrawn'),
      ('discussion', 'council_review'), ('discussion', 'voting'), ('discussion', 'withdrawn'),
      ('council_review', 'voting'), ('council_review', 'withdrawn'),
      ('voting', 'passed'), ('voting', 'rejected'),
      ('passed', 'applied'))) THEN
    RAISE EXCEPTION 'proposal status cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status <> 'voting' THEN NEW.rules := OLD.rules; NEW.voting_ends_at := OLD.voting_ends_at; END IF;
  NEW.voting_starts_at := OLD.voting_starts_at;
  NEW.council_review_started_at := OLD.council_review_started_at;
  NEW.council_review_ends_at := OLD.council_review_ends_at;
  NEW.discussion_ends_at := OLD.discussion_ends_at;
  NEW.decided_at := OLD.decided_at;
  NEW.applied_at := OLD.applied_at;

  IF NEW.status = 'discussion' THEN
    NEW.discussion_ends_at := clock_timestamp()
      + make_interval(secs => (public.commonair_setting('governance.ordinary')->>'discussionSeconds')::numeric);
  ELSIF NEW.status IN ('council_review', 'voting') AND OLD.status = 'discussion'
        AND clock_timestamp() < OLD.discussion_ends_at THEN
    RAISE EXCEPTION 'the discussion period has not ended' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'council_review' THEN
    IF NOT NEW.affects_creators THEN
      RAISE EXCEPTION 'only proposals affecting creators go to council review' USING ERRCODE = 'check_violation';
    END IF;
    NEW.council_review_started_at := clock_timestamp();
    NEW.council_review_ends_at := NEW.council_review_started_at
      + make_interval(secs => (public.commonair_protections()->>'councilReviewSeconds')::numeric);
  END IF;

  IF NEW.status = 'voting' THEN
    IF NEW.affects_creators AND (OLD.status <> 'council_review' OR clock_timestamp() < OLD.council_review_ends_at) THEN
      RAISE EXCEPTION 'proposals affecting creators must complete creator council review before voting'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT COALESCE(public.commonair_rules_acceptable(NEW.rules, NEW.kind = 'protected'), false) THEN
      RAISE EXCEPTION 'voting rules are missing, malformed or weaker than the current governance settings'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.voting_starts_at := clock_timestamp();
    min_voting := CASE WHEN NEW.kind = 'protected'
                       THEN (public.commonair_protections()->>'minVotingSeconds')::numeric
                       ELSE (public.commonair_setting('governance.ordinary')->>'minVotingSeconds')::numeric END;
    IF min_voting IS NULL OR NEW.voting_ends_at IS NULL
       OR NEW.voting_ends_at < NEW.voting_starts_at + make_interval(secs => min_voting) THEN
      RAISE EXCEPTION 'the voting window is shorter than the minimum of % seconds', min_voting
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.status IN ('passed', 'rejected') THEN
    IF clock_timestamp() <= OLD.voting_ends_at THEN
      RAISE EXCEPTION 'voting has not ended' USING ERRCODE = 'check_violation';
    END IF;
    t := public.commonair_governance_tally(NEW.id);
    IF NEW.status = 'passed' AND NOT t.passed THEN
      RAISE EXCEPTION 'proposal % did not pass: %', NEW.id, t.reason USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'rejected' AND t.passed THEN
      RAISE EXCEPTION 'proposal % passed and cannot be marked rejected', NEW.id USING ERRCODE = 'check_violation';
    END IF;
    NEW.decided_at := clock_timestamp();
  END IF;

  IF NEW.status = 'applied' THEN
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.changes) c
               WHERE NOT EXISTS (SELECT 1 FROM public.governance_applications a
                                 WHERE a.proposal_id = NEW.id AND a.key = c->>'key')) THEN
      RAISE EXCEPTION 'apply every change of proposal % before marking it applied', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.applied_at := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION commonair_proposal_open_vote() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO public.proposal_electorate (proposal_id, user_id, classes)
  SELECT NEW.id, m.user_id, array_agg(DISTINCT m.class ORDER BY m.class)
    FROM public.memberships m
    JOIN public.users u ON u.id = m.user_id
   WHERE m.status = 'active' AND u.deleted_at IS NULL AND NOT u.banned
   GROUP BY m.user_id;
  RETURN NULL;
END $$;
--> statement-breakpoint

-- Votes --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION commonair_vote_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  p public.proposals%ROWTYPE;
  now_ts timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'votes cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.user_id <> OLD.user_id OR NEW.proposal_id <> OLD.proposal_id OR NEW.id <> OLD.id) THEN
    RAISE EXCEPTION 'a vote''s voter and proposal are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Share lock: the passed/rejected transition waits for votes still in flight.
  SELECT * INTO p FROM public.proposals WHERE id = NEW.proposal_id FOR SHARE;
  IF NOT FOUND OR p.status <> 'voting' OR now_ts < p.voting_starts_at OR now_ts > p.voting_ends_at THEN
    RAISE EXCEPTION 'voting is not open for proposal %', NEW.proposal_id USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.proposal_electorate WHERE proposal_id = NEW.proposal_id AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'user % is not in the electorate for proposal %', NEW.user_id, NEW.proposal_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.cast_at := now_ts;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION commonair_vote_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO public.vote_history (id, proposal_id, user_id, choice, cast_at)
  VALUES (gen_random_uuid(), NEW.proposal_id, NEW.user_id, NEW.choice, NEW.cast_at);
  RETURN NULL;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION commonair_membership_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'memberships are never deleted; set status = exited' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.membership_history (id, membership_id, user_id, class, status, basis, op, at)
  VALUES (gen_random_uuid(), NEW.id, NEW.user_id, NEW.class, NEW.status, NEW.basis, TG_OP, clock_timestamp());
  RETURN NULL;
END $$;
--> statement-breakpoint

-- Settings -----------------------------------------------------------------------
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
  NEW.protected := public.commonair_is_protected(NEW.key);
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION commonair_settings_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.updated_by_proposal_id IS DISTINCT FROM OLD.updated_by_proposal_id THEN
    -- The primary key makes each (proposal, key) application happen exactly once.
    INSERT INTO public.governance_applications (proposal_id, key, applied_at)
    VALUES (NEW.updated_by_proposal_id, NEW.key, clock_timestamp());
  END IF;
  IF TG_OP = 'INSERT' OR NEW.value IS DISTINCT FROM OLD.value THEN
    INSERT INTO public.governance_settings_history (id, key, old_value, new_value, proposal_id, changed_at)
    VALUES (gen_random_uuid(), NEW.key, CASE WHEN TG_OP = 'UPDATE' THEN OLD.value END, NEW.value,
            NEW.updated_by_proposal_id, clock_timestamp());
  END IF;
  IF NEW.key = 'governance.protections' AND TG_OP = 'UPDATE' AND NEW.value IS DISTINCT FROM OLD.value THEN
    UPDATE public.governance_settings s SET protected = public.commonair_is_protected(s.key)
     WHERE s.protected IS DISTINCT FROM public.commonair_is_protected(s.key);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint

-- A decision applies all-or-nothing: by commit, its proposal must be marked applied.
CREATE FUNCTION commonair_application_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.proposals WHERE id = NEW.proposal_id AND status = 'applied') THEN
    RAISE EXCEPTION 'proposal % must be marked applied in the transaction that applies it', NEW.proposal_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER governance_applications_complete AFTER INSERT ON public.governance_applications
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commonair_application_complete();
--> statement-breakpoint

-- Ledger: also check balance per entry, at commit ----------------------------------
CREATE FUNCTION commonair_ledger_entry_balance_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  bad record;
BEGIN
  SELECT e.currency, sum(e.amount_cents) AS total INTO bad
    FROM public.ledger_entries e WHERE e.transaction_id = NEW.transaction_id
    GROUP BY e.currency HAVING sum(e.amount_cents) <> 0 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced in %: % cents', NEW.transaction_id, bad.currency, bad.total
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ledger_accounts a WHERE a.id = NEW.account_id AND a.currency <> NEW.currency) THEN
    RAISE EXCEPTION 'ledger entry posts % to an account in a different currency', NEW.currency
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON public.ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commonair_ledger_entry_balance_check();
--> statement-breakpoint

-- Privileges ---------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION commonair_proposal_open_vote() FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION commonair_vote_history() FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION commonair_membership_history() FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION commonair_settings_after() FROM PUBLIC;
--> statement-breakpoint

-- Grant the least-privilege application role (run by the owner after migrations).
CREATE FUNCTION commonair_configure_app_role(r name) RETURNS void
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
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION commonair_configure_app_role(name) FROM PUBLIC;
