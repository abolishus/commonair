-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Integrity protections enforced by the database itself, so that no application
-- code path, admin role, or bug holding ordinary DML rights can bypass them:
--   1. Append-only tables: ledger, audit log, governance and membership history.
--   2. Double-entry: every ledger transaction balances to zero per currency, and
--      entries can only be added in the database transaction that created it.
--   3. Governance: a strict proposal state machine; the electorate is built from
--      active memberships when voting opens; votes are time-boxed by the wall
--      clock; every governance setting changes only by applying a passed proposal
--      exactly once, re-tallied here from the raw votes; protected settings need
--      a protected decision (member-wide supermajority AND streamer-class majority
--      after creator-council review).
--
-- Every function pins search_path (pg_temp last) and schema-qualifies tables, so
-- temporary tables cannot shadow the real ones. The application role must not
-- own these tables or hold TRIGGER/TRUNCATE (see docs/self-hosting).
--
-- Residual risk (documented in ADR 0004): a role with unrestricted DML can still
-- fabricate the underlying facts (memberships, stream hours) or overwrite a vote
-- while voting is open; those writes leave append-only history rows.

-- Helpers ------------------------------------------------------------------------
CREATE FUNCTION commonair_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% rejected)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint

-- Rows that only triggers may insert (history, applications, electorate).
CREATE FUNCTION commonair_trigger_only_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'table % is append-only (% rejected)', TG_TABLE_NAME, TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'rows in % are written by the database only', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE FUNCTION commonair_protections() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT value FROM public.governance_settings WHERE key = 'governance.protections'
$$;
--> statement-breakpoint

CREATE FUNCTION commonair_setting(p_key text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT value FROM public.governance_settings WHERE key = p_key
$$;
--> statement-breakpoint

CREATE FUNCTION commonair_is_protected(p_key text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_key = 'governance.protections'
      OR COALESCE(public.commonair_protections()->'protectedKeys' ? p_key, false)
$$;
--> statement-breakpoint

-- Shape and range checks for governance.protections; a malformed value could
-- otherwise make every future protected vote impossible.
CREATE FUNCTION commonair_validate_protections(v jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  k text;
BEGIN
  IF jsonb_typeof(v) <> 'object' THEN RAISE EXCEPTION 'governance.protections must be an object'; END IF;
  FOREACH k IN ARRAY ARRAY['memberWideThreshold', 'streamerClassThreshold', 'quorum', 'streamerClassQuorum',
                           'councilReviewSeconds', 'minVotingSeconds'] LOOP
    IF jsonb_typeof(v->k) IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'governance.protections.% must be a number', k USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF (v->>'memberWideThreshold')::numeric NOT BETWEEN 0.5 AND 1
     OR (v->>'streamerClassThreshold')::numeric < 0.5 OR (v->>'streamerClassThreshold')::numeric >= 1
     OR (v->>'quorum')::numeric NOT BETWEEN 0 AND 1
     OR (v->>'streamerClassQuorum')::numeric NOT BETWEEN 0 AND 1
     OR (v->>'councilReviewSeconds')::numeric < 0 OR (v->>'minVotingSeconds')::numeric < 0 THEN
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

-- 1. Append-only -----------------------------------------------------------------
CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON public.ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON public.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON public.audit_log
  FOR EACH ROW EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER governance_settings_history_guard BEFORE INSERT OR UPDATE OR DELETE ON public.governance_settings_history
  FOR EACH ROW EXECUTE FUNCTION commonair_trigger_only_insert();
--> statement-breakpoint
CREATE TRIGGER governance_applications_guard BEFORE INSERT OR UPDATE OR DELETE ON public.governance_applications
  FOR EACH ROW EXECUTE FUNCTION commonair_trigger_only_insert();
--> statement-breakpoint
CREATE TRIGGER vote_history_guard BEFORE INSERT OR UPDATE OR DELETE ON public.vote_history
  FOR EACH ROW EXECUTE FUNCTION commonair_trigger_only_insert();
--> statement-breakpoint
CREATE TRIGGER membership_history_guard BEFORE INSERT OR UPDATE OR DELETE ON public.membership_history
  FOR EACH ROW EXECUTE FUNCTION commonair_trigger_only_insert();
--> statement-breakpoint
CREATE TRIGGER proposal_electorate_guard BEFORE INSERT OR UPDATE OR DELETE ON public.proposal_electorate
  FOR EACH ROW EXECUTE FUNCTION commonair_trigger_only_insert();
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_no_truncate BEFORE TRUNCATE ON public.ledger_transactions FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON public.ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_accounts_no_truncate BEFORE TRUNCATE ON public.ledger_accounts FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON public.audit_log FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER governance_settings_no_truncate BEFORE TRUNCATE ON public.governance_settings FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER governance_settings_history_no_truncate BEFORE TRUNCATE ON public.governance_settings_history FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER governance_applications_no_truncate BEFORE TRUNCATE ON public.governance_applications FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER proposals_no_truncate BEFORE TRUNCATE ON public.proposals FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER proposal_electorate_no_truncate BEFORE TRUNCATE ON public.proposal_electorate FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER votes_no_truncate BEFORE TRUNCATE ON public.votes FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER vote_history_no_truncate BEFORE TRUNCATE ON public.vote_history FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER memberships_no_truncate BEFORE TRUNCATE ON public.memberships FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER membership_history_no_truncate BEFORE TRUNCATE ON public.membership_history FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- Ledger accounts may be renamed, and may lose their owner link (account deletion),
-- but are never deleted, retyped, or reassigned to another owner.
CREATE FUNCTION commonair_ledger_account_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger accounts cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.code IS DISTINCT FROM OLD.code OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'ledger account code, type and currency are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id AND NEW.owner_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'ledger account owners can only be cleared, never reassigned' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ledger_accounts_guard BEFORE UPDATE OR DELETE ON public.ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION commonair_ledger_account_guard();
--> statement-breakpoint

-- 2. Double-entry ----------------------------------------------------------------
CREATE FUNCTION commonair_ledger_tx_stamp() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW.txid := txid_current();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_stamp BEFORE INSERT ON public.ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION commonair_ledger_tx_stamp();
--> statement-breakpoint

CREATE FUNCTION commonair_ledger_entry_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ledger_transactions t WHERE t.id = NEW.transaction_id AND t.txid = txid_current()) THEN
    RAISE EXCEPTION 'ledger entries can only be added in the database transaction that created ledger transaction %',
      NEW.transaction_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_same_tx BEFORE INSERT ON public.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION commonair_ledger_entry_guard();
--> statement-breakpoint

-- One check per ledger transaction, at commit (entries are all present by then).
CREATE FUNCTION commonair_ledger_balance_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  n integer;
  bad record;
BEGIN
  SELECT count(*) INTO n FROM public.ledger_entries WHERE transaction_id = NEW.id;
  IF n < 2 THEN
    RAISE EXCEPTION 'ledger transaction % has % entries; at least 2 required', NEW.id, n
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT e.currency, sum(e.amount_cents) AS total INTO bad
    FROM public.ledger_entries e WHERE e.transaction_id = NEW.id
    GROUP BY e.currency HAVING sum(e.amount_cents) <> 0 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced in %: % cents', NEW.id, bad.currency, bad.total
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ledger_entries e JOIN public.ledger_accounts a ON a.id = e.account_id
             WHERE e.transaction_id = NEW.id AND a.currency <> e.currency) THEN
    RAISE EXCEPTION 'ledger transaction % posts to an account in a different currency', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_transactions_balanced AFTER INSERT ON public.ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION commonair_ledger_balance_check();
--> statement-breakpoint

-- 3. Memberships -----------------------------------------------------------------
CREATE FUNCTION commonair_membership_history() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'memberships are never deleted; set status = exited' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.membership_history (id, membership_id, user_id, class, status, basis, op, at)
  VALUES (gen_random_uuid(), NEW.id, NEW.user_id, NEW.class, NEW.status, NEW.basis, TG_OP, clock_timestamp());
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER memberships_history AFTER INSERT OR UPDATE OR DELETE ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION commonair_membership_history();
--> statement-breakpoint

-- 4. Governance: tally -----------------------------------------------------------

-- Re-tally a proposal from raw votes and the frozen electorate using its frozen rules.
CREATE FUNCTION commonair_governance_tally(p_id uuid, OUT passed boolean, OUT reason text)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  p public.proposals%ROWTYPE;
  r jsonb;
  eligible integer; yes integer; no integer; abstain integer;
  s_eligible integer; s_yes integer; s_no integer; s_abstain integer;
BEGIN
  SELECT * INTO p FROM public.proposals WHERE id = p_id;
  IF NOT FOUND THEN passed := false; reason := 'proposal not found'; RETURN; END IF;
  r := p.rules;
  IF r IS NULL OR p.voting_ends_at IS NULL THEN passed := false; reason := 'voting never opened'; RETURN; END IF;
  IF p.voting_ends_at > clock_timestamp() THEN passed := false; reason := 'voting has not ended'; RETURN; END IF;

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

  IF eligible = 0 OR (yes + no + abstain)::numeric / eligible < (r->>'quorum')::numeric THEN
    passed := false; reason := 'member-wide quorum not met'; RETURN;
  END IF;
  IF yes + no = 0 OR yes::numeric / (yes + no) < (r->>'memberWideThreshold')::numeric THEN
    passed := false; reason := 'member-wide threshold not met'; RETURN;
  END IF;
  IF (r->>'protected')::boolean THEN
    IF s_eligible = 0 OR (s_yes + s_no + s_abstain)::numeric / s_eligible < (r->>'streamerClassQuorum')::numeric THEN
      passed := false; reason := 'streamer-class quorum not met'; RETURN;
    END IF;
    IF s_yes + s_no = 0 OR s_yes::numeric / (s_yes + s_no) <= (r->>'streamerClassThreshold')::numeric THEN
      passed := false; reason := 'streamer-class majority not met'; RETURN;
    END IF;
  END IF;
  passed := true; reason := 'passed';
END $$;
--> statement-breakpoint

-- Frozen rules must be at least as strict as the current settings for their kind.
CREATE FUNCTION commonair_rules_acceptable(r jsonb, protected boolean) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  s jsonb;
BEGIN
  IF r IS NULL OR jsonb_typeof(r) <> 'object' THEN RETURN false; END IF;
  IF (r->>'protected')::boolean IS DISTINCT FROM protected THEN RETURN false; END IF;
  IF protected THEN
    s := public.commonair_protections();
    RETURN (r->>'memberWideThreshold')::numeric >= (s->>'memberWideThreshold')::numeric
       AND (r->>'streamerClassThreshold')::numeric >= (s->>'streamerClassThreshold')::numeric
       AND (r->>'quorum')::numeric >= (s->>'quorum')::numeric
       AND (r->>'streamerClassQuorum')::numeric >= (s->>'streamerClassQuorum')::numeric
       AND (r->>'councilReviewRequired')::boolean;
  END IF;
  s := public.commonair_setting('governance.ordinary');
  RETURN (r->>'memberWideThreshold')::numeric >= (s->>'threshold')::numeric
     AND (r->>'quorum')::numeric >= (s->>'quorum')::numeric;
EXCEPTION WHEN others THEN
  RETURN false;
END $$;
--> statement-breakpoint

-- 5. Governance: proposal state machine ------------------------------------------
CREATE FUNCTION commonair_proposal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  touches_protected boolean;
  min_voting numeric;
  t record;
  frozen boolean;
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
  END IF;

  -- Changes must name existing settings, each at most once.
  IF jsonb_typeof(NEW.changes) <> 'array'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.changes) c
                WHERE jsonb_typeof(c) <> 'object' OR NOT (c ? 'key') OR NOT (c ? 'value')
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

  -- Content is editable only before review/voting; after that everything is frozen.
  frozen := OLD.status NOT IN ('draft', 'discussion');
  IF frozen AND (NEW.changes IS DISTINCT FROM OLD.changes OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.affects_creators IS DISTINCT FROM OLD.affects_creators OR NEW.title IS DISTINCT FROM OLD.title
       OR NEW.body IS DISTINCT FROM OLD.body OR NEW.author_id IS DISTINCT FROM OLD.author_id) THEN
    RAISE EXCEPTION 'a proposal''s content is frozen once review or voting begins' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.status = OLD.status THEN
    -- Timeline fields are owned by the state machine.
    IF NEW.rules IS DISTINCT FROM OLD.rules OR NEW.voting_starts_at IS DISTINCT FROM OLD.voting_starts_at
       OR NEW.voting_ends_at IS DISTINCT FROM OLD.voting_ends_at
       OR NEW.council_review_started_at IS DISTINCT FROM OLD.council_review_started_at
       OR NEW.council_review_ends_at IS DISTINCT FROM OLD.council_review_ends_at
       OR NEW.discussion_ends_at IS DISTINCT FROM OLD.discussion_ends_at
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at OR NEW.applied_at IS DISTINCT FROM OLD.applied_at THEN
      RAISE EXCEPTION 'timeline fields change only with a status transition' USING ERRCODE = 'insufficient_privilege';
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

  -- Fields set by the state machine; callers may supply only rules and voting_ends_at when opening a vote.
  IF NEW.status <> 'voting' THEN NEW.rules := OLD.rules; NEW.voting_ends_at := OLD.voting_ends_at; END IF;
  NEW.voting_starts_at := OLD.voting_starts_at;
  NEW.council_review_started_at := OLD.council_review_started_at;
  NEW.council_review_ends_at := OLD.council_review_ends_at;
  NEW.discussion_ends_at := OLD.discussion_ends_at;
  NEW.decided_at := OLD.decided_at;
  NEW.applied_at := OLD.applied_at;

  IF NEW.status = 'discussion' THEN
    NEW.discussion_ends_at := clock_timestamp()
      + make_interval(secs => COALESCE((public.commonair_setting('governance.ordinary')->>'discussionSeconds')::numeric, 0));
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
    IF NOT public.commonair_rules_acceptable(NEW.rules, NEW.kind = 'protected') THEN
      RAISE EXCEPTION 'voting rules are missing or weaker than the current governance settings'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.voting_starts_at := clock_timestamp();
    min_voting := CASE WHEN NEW.kind = 'protected'
                       THEN (public.commonair_protections()->>'minVotingSeconds')::numeric
                       ELSE (public.commonair_setting('governance.ordinary')->>'minVotingSeconds')::numeric END;
    IF NEW.voting_ends_at IS NULL OR NEW.voting_ends_at < NEW.voting_starts_at + make_interval(secs => COALESCE(min_voting, 0)) THEN
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
CREATE TRIGGER proposals_guard BEFORE INSERT OR UPDATE OR DELETE ON public.proposals
  FOR EACH ROW EXECUTE FUNCTION commonair_proposal_guard();
--> statement-breakpoint

-- When voting opens, the database builds the electorate from active memberships.
CREATE FUNCTION commonair_proposal_open_vote() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
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
CREATE TRIGGER proposals_open_vote AFTER UPDATE ON public.proposals
  FOR EACH ROW WHEN (NEW.status = 'voting' AND OLD.status IS DISTINCT FROM 'voting')
  EXECUTE FUNCTION commonair_proposal_open_vote();
--> statement-breakpoint

-- 6. Governance: votes -----------------------------------------------------------
CREATE FUNCTION commonair_vote_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  p public.proposals%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'votes cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.user_id <> OLD.user_id OR NEW.proposal_id <> OLD.proposal_id) THEN
    RAISE EXCEPTION 'a vote''s voter and proposal are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO p FROM public.proposals WHERE id = NEW.proposal_id;
  IF NOT FOUND OR p.status <> 'voting' OR clock_timestamp() < p.voting_starts_at OR clock_timestamp() > p.voting_ends_at THEN
    RAISE EXCEPTION 'voting is not open for proposal %', NEW.proposal_id USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.proposal_electorate WHERE proposal_id = NEW.proposal_id AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'user % is not in the electorate for proposal %', NEW.user_id, NEW.proposal_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.cast_at := clock_timestamp();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER votes_guard BEFORE INSERT OR UPDATE OR DELETE ON public.votes
  FOR EACH ROW EXECUTE FUNCTION commonair_vote_guard();
--> statement-breakpoint
CREATE FUNCTION commonair_vote_history() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO public.vote_history (id, proposal_id, user_id, choice, cast_at)
  VALUES (gen_random_uuid(), NEW.proposal_id, NEW.user_id, NEW.choice, NEW.cast_at);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER votes_history AFTER INSERT OR UPDATE ON public.votes
  FOR EACH ROW EXECUTE FUNCTION commonair_vote_history();
--> statement-breakpoint

-- 7. Governance: settings --------------------------------------------------------
CREATE FUNCTION commonair_settings_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  p public.proposals%ROWTYPE;
  t record;
  is_protected boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'governance settings cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- New keys are defined by migrations/seed; their protection is derived, never chosen.
    IF NEW.key = 'governance.protections' THEN
      PERFORM public.commonair_validate_protections(NEW.value);
      NEW.protected := true;
    ELSIF public.commonair_protections() IS NULL THEN
      RAISE EXCEPTION 'seed governance.protections before other settings' USING ERRCODE = 'check_violation';
    ELSE
      NEW.protected := public.commonair_is_protected(NEW.key);
    END IF;
    NEW.updated_by_proposal_id := NULL;
    RETURN NEW;
  END IF;

  IF NEW.key <> OLD.key OR NEW.description <> OLD.description THEN
    RAISE EXCEPTION 'a setting''s key and description are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Flag re-sync after governance.protections changes (only from the trigger below).
  IF NEW.value = OLD.value THEN
    IF pg_trigger_depth() < 2 OR NEW.updated_by_proposal_id IS DISTINCT FROM OLD.updated_by_proposal_id THEN
      RAISE EXCEPTION 'settings change only by applying a passed proposal' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  is_protected := public.commonair_is_protected(NEW.key);
  NEW.protected := is_protected;
  IF NEW.updated_by_proposal_id IS NULL THEN
    RAISE EXCEPTION 'setting % can only change by applying a passed proposal', NEW.key USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO p FROM public.proposals WHERE id = NEW.updated_by_proposal_id;
  IF NOT FOUND OR p.status <> 'passed' THEN
    RAISE EXCEPTION 'proposal % is not a passed, unapplied decision', NEW.updated_by_proposal_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF is_protected AND p.kind <> 'protected' THEN
    RAISE EXCEPTION 'protected setting % needs a protected decision', NEW.key USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p.changes) c WHERE c->>'key' = NEW.key AND c->'value' = NEW.value) THEN
    RAISE EXCEPTION 'proposal % does not contain this change to %', p.id, NEW.key USING ERRCODE = 'insufficient_privilege';
  END IF;
  t := public.commonair_governance_tally(p.id);
  IF NOT t.passed THEN
    RAISE EXCEPTION 'proposal % fails re-tally: %', p.id, t.reason USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.key = 'governance.protections' THEN
    PERFORM public.commonair_validate_protections(NEW.value);
  END IF;
  -- Exactly once: the primary key on governance_applications rejects a second application.
  INSERT INTO public.governance_applications (proposal_id, key, applied_at) VALUES (p.id, NEW.key, clock_timestamp());
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER governance_settings_guard BEFORE INSERT OR UPDATE OR DELETE ON public.governance_settings
  FOR EACH ROW EXECUTE FUNCTION commonair_settings_guard();
--> statement-breakpoint

CREATE FUNCTION commonair_settings_after() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
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
CREATE TRIGGER governance_settings_after AFTER INSERT OR UPDATE ON public.governance_settings
  FOR EACH ROW EXECUTE FUNCTION commonair_settings_after();
