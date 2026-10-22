-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Co-op protections (E5, ADR 0020, docs/testing/e5-selectors.md), in addition to ADR 0004's
-- governance triggers (0001/0002). Designed, like those, against a caller with ordinary DML on
-- every table who does not own them:
--   1. tallies: append-only; a row is recorded only for a decided proposal, and its outcome,
--      reason and every count (member-wide and per class) must equal the database's own tally.
--   2. council_terms / council_members: append-only; seats are inserted only in the database
--      transaction that created their term.
--   3. council_responses: one per proposal, never changed; only while the proposal is in council
--      review, only by a member seated in the current term, published_at = the database clock.
--   4. membership_shares: inserted pending, one open (pending/held/refund_pending) share per user; pending -> held (payment succeeded and the
--      share-purchase posting exists) | cancelled; held -> refund_pending -> refunded (the
--      share-refund posting exists); amount, currency, user and payment never change; never deleted.
--   5. patronage_periods: draft/computed -> approved only by a treasurer or admin who is not the
--      person who computed it, with the allocation posted; approved periods are frozen (only
--      approved -> distributed); patronage inputs and allocations change only while the period is
--      draft or computed.
--   6. proposal_comments: only by active members, only while the proposal is open for comments;
--      author, proposal and body never change.
--   7. commonair_configure_app_role: the app loses UPDATE/DELETE on the append-only tables above.
-- Functions pin search_path and schema-qualify tables (ADR 0004).

-- 1. Tallies -------------------------------------------------------------------------
CREATE FUNCTION commonair_tally_counts(p_id uuid, cls text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  -- cls NULL = member-wide. Counts votes cast up to the deadline by the frozen electorate.
  SELECT jsonb_build_object(
    'eligible', (SELECT count(*) FROM public.proposal_electorate e
                  WHERE e.proposal_id = p_id AND (cls IS NULL OR cls = ANY(e.classes::text[]))),
    'yes', count(*) FILTER (WHERE v.choice = 'yes'),
    'no', count(*) FILTER (WHERE v.choice = 'no'),
    'abstain', count(*) FILTER (WHERE v.choice = 'abstain'))
  FROM public.votes v
  JOIN public.proposal_electorate e ON e.proposal_id = v.proposal_id AND e.user_id = v.user_id
  JOIN public.proposals p ON p.id = v.proposal_id
  WHERE v.proposal_id = p_id AND v.cast_at <= p.voting_ends_at
    AND (cls IS NULL OR cls = ANY(e.classes::text[]))
$$;
--> statement-breakpoint

CREATE FUNCTION commonair_counts_match(claimed jsonb, actual jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RETURN (claimed->>'eligible')::bigint = (actual->>'eligible')::bigint
     AND (claimed->>'yes')::bigint = (actual->>'yes')::bigint
     AND (claimed->>'no')::bigint = (actual->>'no')::bigint
     AND (claimed->>'abstain')::bigint = (actual->>'abstain')::bigint;
EXCEPTION WHEN others THEN
  RETURN false;
END $$;
--> statement-breakpoint

CREATE FUNCTION commonair_tally_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  st public.proposal_status;
  t record;
  cls text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'tallies are append-only (% rejected)', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT status INTO st FROM public.proposals WHERE id = NEW.proposal_id FOR SHARE;
  IF st IS NULL OR st NOT IN ('passed', 'rejected') THEN
    RAISE EXCEPTION 'a tally is recorded only for a decided proposal' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO t FROM public.commonair_governance_tally(NEW.proposal_id);
  IF NEW.passed IS DISTINCT FROM t.passed OR NEW.passed IS DISTINCT FROM (st = 'passed')
     OR NEW.reason IS DISTINCT FROM t.reason THEN
    RAISE EXCEPTION 'tally disagrees with the database tally (%)', t.reason USING ERRCODE = 'check_violation';
  END IF;
  IF NOT public.commonair_counts_match(NEW.breakdown->'memberWide', public.commonair_tally_counts(NEW.proposal_id, NULL)) THEN
    RAISE EXCEPTION 'tally counts disagree with the recorded votes' USING ERRCODE = 'check_violation';
  END IF;
  FOREACH cls IN ARRAY ARRAY['streamer', 'viewer', 'worker'] LOOP
    IF NOT public.commonair_counts_match(NEW.breakdown->'byClass'->cls, public.commonair_tally_counts(NEW.proposal_id, cls)) THEN
      RAISE EXCEPTION 'tally counts for the % class disagree with the recorded votes', cls USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  NEW.computed_at := clock_timestamp();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER tallies_guard BEFORE INSERT OR UPDATE OR DELETE ON public.tallies
  FOR EACH ROW EXECUTE FUNCTION commonair_tally_guard();
--> statement-breakpoint
CREATE TRIGGER tallies_no_truncate BEFORE TRUNCATE ON public.tallies
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 2. Council terms and seats ---------------------------------------------------------
CREATE FUNCTION commonair_council_term_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'council terms are append-only (% rejected)', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (NEW.starts_at < NEW.ends_at) THEN
    RAISE EXCEPTION 'a council term must end after it starts' USING ERRCODE = 'check_violation';
  END IF;
  NEW.txid := txid_current();
  NEW.computed_at := clock_timestamp();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER council_terms_guard BEFORE INSERT OR UPDATE OR DELETE ON public.council_terms
  FOR EACH ROW EXECUTE FUNCTION commonair_council_term_guard();
--> statement-breakpoint
CREATE TRIGGER council_terms_no_truncate BEFORE TRUNCATE ON public.council_terms
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

CREATE FUNCTION commonair_council_member_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'council seats are append-only (% rejected)', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.council_terms t WHERE t.id = NEW.term_id AND t.txid = txid_current()) THEN
    RAISE EXCEPTION 'council seats are added only with their term' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER council_members_guard BEFORE INSERT OR UPDATE OR DELETE ON public.council_members
  FOR EACH ROW EXECUTE FUNCTION commonair_council_member_guard();
--> statement-breakpoint
CREATE TRIGGER council_members_no_truncate BEFORE TRUNCATE ON public.council_members
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 3. Council responses ---------------------------------------------------------------
CREATE FUNCTION commonair_current_council_term() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT t.id FROM public.council_terms t
   WHERE t.starts_at <= clock_timestamp() AND t.ends_at > clock_timestamp()
   ORDER BY t.computed_at DESC, t.id DESC
   LIMIT 1
$$;
--> statement-breakpoint

CREATE FUNCTION commonair_council_response_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  st public.proposal_status;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'council responses are final (% rejected)', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT status INTO st FROM public.proposals WHERE id = NEW.proposal_id FOR SHARE;
  IF st IS DISTINCT FROM 'council_review' THEN
    RAISE EXCEPTION 'the council responds only while a proposal is in council review' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.term_id IS DISTINCT FROM public.commonair_current_council_term() THEN
    RAISE EXCEPTION 'only the current council term can respond' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.council_members m
                  WHERE m.term_id = NEW.term_id AND m.user_id = NEW.published_by_id) THEN
    RAISE EXCEPTION 'only a seated council member can publish the response' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.published_at := clock_timestamp();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER council_responses_guard BEFORE INSERT OR UPDATE OR DELETE ON public.council_responses
  FOR EACH ROW EXECUTE FUNCTION commonair_council_response_guard();
--> statement-breakpoint
CREATE TRIGGER council_responses_no_truncate BEFORE TRUNCATE ON public.council_responses
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 4. Member shares -------------------------------------------------------------------
CREATE FUNCTION commonair_share_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'member shares are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status::text <> 'pending' OR NEW.purchased_at IS NOT NULL OR NEW.refunded_at IS NOT NULL THEN
      RAISE EXCEPTION 'a member share starts pending' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.amount_cents <= 0 OR NEW.currency !~ '^[a-z]{3}$' THEN
      RAISE EXCEPTION 'a member share needs a positive amount and a currency' USING ERRCODE = 'check_violation';
    END IF;
    -- One open share per user. The unique index covers pending/held; refund_pending is checked
    -- here, serialized per user so two concurrent inserts cannot both pass.
    PERFORM pg_advisory_xact_lock(hashtext('commonair:share:' || NEW.user_id::text));
    IF EXISTS (SELECT 1 FROM public.membership_shares m
                WHERE m.user_id = NEW.user_id AND m.status::text IN ('pending', 'held', 'refund_pending')) THEN
      RAISE EXCEPTION 'this member already has an open share' USING ERRCODE = 'unique_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.amount_cents <> OLD.amount_cents
     OR NEW.currency <> OLD.currency OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a member share''s user, amount, currency and payment never change' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = OLD.status THEN
    IF NEW.purchased_at IS DISTINCT FROM OLD.purchased_at OR NEW.refunded_at IS DISTINCT FROM OLD.refunded_at THEN
      RAISE EXCEPTION 'share dates change only with a status transition' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status::text = 'pending' AND NEW.status::text = 'held' THEN
    IF NEW.purchased_at IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.payments p WHERE p.id = NEW.payment_id AND p.status = 'succeeded'
                        AND p.kind = 'membership_share' AND p.amount_cents = NEW.amount_cents)
       OR NOT EXISTS (SELECT 1 FROM public.ledger_transactions t
                       WHERE t.idempotency_key = 'share-purchase:' || NEW.id::text) THEN
      RAISE EXCEPTION 'a share is held only once its payment succeeded and the purchase is posted' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.status::text = 'pending' AND NEW.status::text = 'cancelled' THEN
    NULL;
  ELSIF OLD.status::text = 'held' AND NEW.status::text = 'refund_pending' THEN
    NULL;
  ELSIF OLD.status::text = 'refund_pending' AND NEW.status::text = 'refunded' THEN
    IF NEW.refunded_at IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.ledger_transactions t
                       WHERE t.idempotency_key = 'share-refund:' || NEW.id::text) THEN
      RAISE EXCEPTION 'a share is refunded only once the refund is posted' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'a member share cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.purchased_at IS DISTINCT FROM OLD.purchased_at AND NOT (OLD.status::text = 'pending' AND NEW.status::text = 'held') THEN
    RAISE EXCEPTION 'purchased_at is set only when the share becomes held' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.refunded_at IS DISTINCT FROM OLD.refunded_at AND NOT (NEW.status::text = 'refunded') THEN
    RAISE EXCEPTION 'refunded_at is set only when the share is refunded' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER membership_shares_guard BEFORE INSERT OR UPDATE OR DELETE ON public.membership_shares
  FOR EACH ROW EXECUTE FUNCTION commonair_share_guard();
--> statement-breakpoint
CREATE TRIGGER membership_shares_no_truncate BEFORE TRUNCATE ON public.membership_shares
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 5. Patronage -----------------------------------------------------------------------
CREATE FUNCTION commonair_patronage_period_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  total bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('approved', 'distributed') THEN
      RAISE EXCEPTION 'an approved patronage period is never deleted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('draft', 'computed') OR NEW.approved_by_id IS NOT NULL OR NEW.approved_at IS NOT NULL
       OR NEW.ledger_transaction_id IS NOT NULL THEN
      RAISE EXCEPTION 'a patronage period starts as a draft or computed, unapproved' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('approved', 'distributed') THEN
    IF NOT (OLD.status = 'approved' AND NEW.status = 'distributed')
       OR (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
      RAISE EXCEPTION 'an approved patronage period is frozen' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  -- OLD is draft or computed.
  IF NEW.status IN ('draft', 'computed') THEN
    IF NEW.approved_by_id IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.ledger_transaction_id IS NOT NULL THEN
      RAISE EXCEPTION 'approval fields are set only by approving' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'distributed' THEN
    RAISE EXCEPTION 'a patronage period is approved before it is distributed' USING ERRCODE = 'check_violation';
  END IF;

  -- NEW.status = 'approved'
  IF OLD.status <> 'computed' THEN
    RAISE EXCEPTION 'only a computed patronage period can be approved' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'approved_at', 'approved_by_id', 'ledger_transaction_id'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'approved_at', 'approved_by_id', 'ledger_transaction_id']) THEN
    RAISE EXCEPTION 'approving a patronage period changes nothing else' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.computed_by_id IS NULL OR NEW.approved_by_id IS NULL OR NEW.approved_at IS NULL THEN
    RAISE EXCEPTION 'a patronage approval needs the person who ran it and the approver' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.approved_by_id = NEW.computed_by_id THEN
    RAISE EXCEPTION 'a patronage period must be approved by someone other than the person who ran it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = NEW.approved_by_id
                    AND u.role::text IN ('treasurer', 'admin') AND NOT u.banned) THEN
    RAISE EXCEPTION 'a patronage period is approved by a treasurer or an admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT coalesce(sum(a.amount_cents), 0) INTO total FROM public.patronage_allocations a WHERE a.period_id = NEW.id;
  IF total > NEW.surplus_cents THEN
    RAISE EXCEPTION 'allocations exceed the period surplus' USING ERRCODE = 'check_violation';
  END IF;
  IF total > 0 AND NOT EXISTS (SELECT 1 FROM public.ledger_transactions t
                                WHERE t.id = NEW.ledger_transaction_id
                                  AND t.idempotency_key = 'patronage-allocation:' || NEW.id::text) THEN
    RAISE EXCEPTION 'a patronage period is approved only with its allocation posted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER patronage_periods_guard BEFORE INSERT OR UPDATE OR DELETE ON public.patronage_periods
  FOR EACH ROW EXECUTE FUNCTION commonair_patronage_period_guard();
--> statement-breakpoint
CREATE TRIGGER patronage_periods_no_truncate BEFORE TRUNCATE ON public.patronage_periods
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

CREATE FUNCTION commonair_patronage_lines_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  st public.patronage_status;
BEGIN
  -- A row that moves between periods must be writable in both.
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status INTO st FROM public.patronage_periods WHERE id = OLD.period_id FOR SHARE;
    IF st IN ('approved', 'distributed') THEN
      RAISE EXCEPTION 'patronage figures of an approved period are frozen' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status INTO st FROM public.patronage_periods WHERE id = NEW.period_id FOR SHARE;
    IF st IN ('approved', 'distributed') THEN
      RAISE EXCEPTION 'patronage figures of an approved period are frozen' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER patronage_inputs_guard BEFORE INSERT OR UPDATE OR DELETE ON public.patronage_inputs
  FOR EACH ROW EXECUTE FUNCTION commonair_patronage_lines_guard();
--> statement-breakpoint
CREATE TRIGGER patronage_allocations_guard BEFORE INSERT OR UPDATE OR DELETE ON public.patronage_allocations
  FOR EACH ROW EXECUTE FUNCTION commonair_patronage_lines_guard();
--> statement-breakpoint
CREATE TRIGGER patronage_inputs_no_truncate BEFORE TRUNCATE ON public.patronage_inputs
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER patronage_allocations_no_truncate BEFORE TRUNCATE ON public.patronage_allocations
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 6. Proposal comments ---------------------------------------------------------------
CREATE FUNCTION commonair_proposal_comment_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  st public.proposal_status;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.proposal_id <> OLD.proposal_id OR NEW.author_id <> OLD.author_id
       OR NEW.body <> OLD.body OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'proposal comments are not edited' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO st FROM public.proposals WHERE id = NEW.proposal_id FOR SHARE;
  IF st IS NULL OR st NOT IN ('discussion', 'council_review', 'voting') THEN
    RAISE EXCEPTION 'comments are open only during discussion, council review and voting' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = NEW.author_id AND m.status = 'active') THEN
    RAISE EXCEPTION 'only members comment on proposals' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER proposal_comments_guard BEFORE INSERT OR UPDATE OR DELETE ON public.proposal_comments
  FOR EACH ROW EXECUTE FUNCTION commonair_proposal_comment_guard();
--> statement-breakpoint

-- 7. App role (additions only to 0016's version) -------------------------------------
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
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION commonair_configure_app_role(name) FROM PUBLIC;
