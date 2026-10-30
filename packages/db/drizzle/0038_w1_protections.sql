-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- W1 protections (ADR 0036, payment fraud floor), in addition to 0001, 0016, 0021, 0025, 0029 and
-- 0034, against a caller with ordinary DML on every table who does not own them:
--   1. payment_fraud_flags: inserted open, undecided and unreleased; open -> reviewed by a
--      treasurer or an admin; reviewed -> cleared | confirmed by a different person who is a
--      treasurer or an admin (four eyes); nobody reviews, decides or releases a flag on their own
--      payouts; decided rows are frozen except one release of a confirmed flag by an admin (ADR
--      0036 decision 3); never deleted or truncated.
--   2. payouts: while the payee has a holding fraud flag (open, reviewed, or confirmed and not
--      released), no payout is inserted or moved into pending, scheduled or paid.
--   3. The app role cannot DELETE or TRUNCATE fraud flags (the trigger already refuses; this is the
--      second layer). commonair_configure_app_role is redefined from 0034's version; the migrate
--      job re-runs it after every migration (infra/postgres/app-role.sql), which also grants the
--      new tables.

-- 1. payment_fraud_flags (ADR 0036): inserted open, undecided and unreleased; open -> reviewed by
--    a treasurer or an admin; reviewed -> cleared | confirmed by a different person who is a
--    treasurer or an admin (four eyes); nobody reviews, decides or releases a flag on their own
--    payouts; decided rows are frozen except one release of a confirmed flag by an admin; never
--    deleted.
CREATE FUNCTION commonair_payment_fraud_flag_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment fraud flags are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.reviewed_by_id IS NOT NULL OR NEW.recommendation IS NOT NULL
       OR NEW.reviewed_at IS NOT NULL OR NEW.decided_by_id IS NOT NULL OR NEW.decision IS NOT NULL
       OR NEW.decided_at IS NOT NULL OR NEW.released_by_id IS NOT NULL OR NEW.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'a fraud flag starts open and undecided' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- ADR 0036 decision 3: the one change a decided flag allows, an admin releasing a confirmed one.
  IF OLD.status = 'confirmed' AND OLD.released_at IS NULL AND NEW.released_by_id IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['released_by_id','released_at'])
         IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['released_by_id','released_at']) THEN
    IF NEW.released_at IS NULL THEN
      RAISE EXCEPTION 'a release sets the admin and the time' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.released_by_id = OLD.payee_user_id OR NOT EXISTS (
         SELECT 1 FROM public.users u WHERE u.id = NEW.released_by_id
         AND u.role::text = 'admin' AND NOT u.banned) THEN
      RAISE EXCEPTION 'only an admin other than the payee releases a confirmed fraud flag' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('cleared', 'confirmed') THEN
    RAISE EXCEPTION 'a decided fraud flag is frozen' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.released_by_id IS NOT NULL OR NEW.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'only a confirmed fraud flag is released' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','reviewed_by_id','recommendation','reviewed_at','decided_by_id','decision','decided_at','note'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','reviewed_by_id','recommendation','reviewed_at','decided_by_id','decision','decided_at','note']) THEN
    RAISE EXCEPTION 'a fraud flag changes only by review and decision' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'open' AND NEW.status = 'reviewed' THEN
    IF NEW.reviewed_by_id IS NULL OR NEW.recommendation IS NULL OR NEW.reviewed_at IS NULL
       OR NEW.decided_by_id IS NOT NULL OR NEW.decision IS NOT NULL OR NEW.decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'a review sets the reviewer, the recommendation and the time only' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.reviewed_by_id = OLD.payee_user_id THEN
      RAISE EXCEPTION 'nobody reviews a fraud flag on their own payouts' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = NEW.reviewed_by_id
                   AND u.role::text IN ('treasurer', 'admin') AND NOT u.banned) THEN
      RAISE EXCEPTION 'only a treasurer or an admin reviews a fraud flag' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'reviewed' AND NEW.status IN ('cleared', 'confirmed') THEN
    IF NEW.decided_by_id IS NULL OR NEW.decision IS NULL OR NEW.decided_at IS NULL
       -- Parenthesized: PL/pgSQL ends an IF condition at the first THEN outside parentheses.
       OR NEW.decision::text <> (CASE NEW.status WHEN 'cleared' THEN 'clear' ELSE 'confirm' END)
       OR NEW.reviewed_by_id IS DISTINCT FROM OLD.reviewed_by_id
       OR NEW.recommendation IS DISTINCT FROM OLD.recommendation THEN
      RAISE EXCEPTION 'a decision sets the decider, a matching decision and the time only' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.decided_by_id = OLD.reviewed_by_id OR NEW.decided_by_id IS NOT DISTINCT FROM OLD.raised_by_id
       OR NEW.decided_by_id = OLD.payee_user_id THEN
      RAISE EXCEPTION 'the second review needs a different person' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = NEW.decided_by_id
                   AND u.role::text IN ('treasurer', 'admin') AND NOT u.banned) THEN
      RAISE EXCEPTION 'only a treasurer or an admin decides a fraud flag' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = OLD.status AND NEW.status IN ('open', 'reviewed')
     AND (to_jsonb(NEW) - 'note') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'note') THEN
    RETURN NEW; -- a note edit
  END IF;
  RAISE EXCEPTION 'fraud flag status % cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER payment_fraud_flags_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payment_fraud_flags
  FOR EACH ROW EXECUTE FUNCTION commonair_payment_fraud_flag_guard();
--> statement-breakpoint
CREATE TRIGGER payment_fraud_flags_no_truncate BEFORE TRUNCATE ON public.payment_fraud_flags
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 2. payouts: while the payee has a holding fraud flag (open, reviewed, or confirmed and not
--    released by an admin), no payout is inserted or moved into pending, scheduled or paid (the
--    fraud floor blocks release, it does not merely flag; ADR 0036 decision 3).
CREATE FUNCTION commonair_payout_fraud_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.status::text IN ('pending', 'scheduled', 'paid')
     AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status)
     AND EXISTS (SELECT 1 FROM public.payment_fraud_flags f
                 WHERE f.payee_user_id = NEW.user_id
                   AND (f.status IN ('open', 'reviewed') OR (f.status = 'confirmed' AND f.released_at IS NULL))) THEN
    RAISE EXCEPTION 'payouts to a payee under fraud review stay held' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payouts_fraud_guard BEFORE INSERT OR UPDATE ON public.payouts
  FOR EACH ROW EXECUTE FUNCTION commonair_payout_fraud_guard();
--> statement-breakpoint

-- 3. App role (additions only to 0034's version) -------------------------------------
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
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION commonair_configure_app_role(name) FROM PUBLIC;
