-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- E8 protections (ADR 0026, channel points), in addition to 0016, 0021, 0025 and 0029, against a
-- caller with ordinary DML on every table who does not own them:
--   1. loyalty_transactions is the points ledger: append-only for every role and cannot be
--      truncated (ADR 0026 decision 2).
--   2. loyalty_balances is written by the loyalty_transactions trigger only (SECURITY DEFINER,
--      owner rights). The update locks the balance row, so concurrent spends serialize, and the
--      loyalty_balances_points_nonneg CHECK fails an overdraw in the inserting transaction.
--   3. The interact.points.accrual governance setting is shape- and range-checked, with the same
--      bounds as PointsAccrualSetting in @commonair/contracts.
--   4. The app role cannot UPDATE or DELETE loyalty_transactions, nor write loyalty_balances (the
--      triggers already refuse; this is the second layer). commonair_configure_app_role is
--      redefined from 0029's version; the migrate job re-runs it after every migration
--      (infra/postgres/app-role.sql), which also grants the new tables.

-- 1. loyalty_transactions is append-only (ADR 0026 decision 2). ---------------------------
CREATE TRIGGER loyalty_transactions_append_only BEFORE UPDATE OR DELETE ON public.loyalty_transactions
  FOR EACH ROW EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER loyalty_transactions_no_truncate BEFORE TRUNCATE ON public.loyalty_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 2. loyalty_balances is written by this trigger only (owner rights, as 0002's history writers).
--    The UPDATE locks the balance row, so concurrent spends serialize; the CHECK fails an overdraw.
--    Not INSERT ... ON CONFLICT DO UPDATE: Postgres checks the proposed insert row (points = delta)
--    against the CHECK before it looks for the conflict, so every spend would fail. A first
--    credit inserts; if a concurrent first credit won the race, the loop updates instead.
CREATE FUNCTION commonair_loyalty_apply() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  LOOP
    UPDATE public.loyalty_balances SET points = points + NEW.delta, updated_at = clock_timestamp()
      WHERE channel_id = NEW.channel_id AND user_id = NEW.user_id;
    IF FOUND THEN RETURN NULL; END IF;
    BEGIN
      INSERT INTO public.loyalty_balances (channel_id, user_id, points, updated_at)
      VALUES (NEW.channel_id, NEW.user_id, NEW.delta, clock_timestamp());
      RETURN NULL;
    EXCEPTION WHEN unique_violation THEN
      NULL; -- a concurrent first credit created the row: update it on the next pass
    END;
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION commonair_loyalty_apply() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER loyalty_transactions_apply AFTER INSERT ON public.loyalty_transactions
  FOR EACH ROW EXECUTE FUNCTION commonair_loyalty_apply();
--> statement-breakpoint
CREATE FUNCTION commonair_loyalty_balance_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT public.commonair_is_owner(TG_RELID) THEN
    RAISE EXCEPTION 'loyalty balances are written by the database only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
--> statement-breakpoint
CREATE TRIGGER loyalty_balances_guard BEFORE INSERT OR UPDATE OR DELETE ON public.loyalty_balances
  FOR EACH ROW EXECUTE FUNCTION commonair_loyalty_balance_guard();
--> statement-breakpoint
CREATE TRIGGER loyalty_balances_no_truncate BEFORE TRUNCATE ON public.loyalty_balances
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 3. interact.points.accrual is shape- and range-checked (same bounds as PointsAccrualSetting).
CREATE FUNCTION commonair_validate_points_accrual() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb := NEW.value;
BEGIN
  IF jsonb_typeof(v->'pointsPerBlock') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v->'blockMinutes') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v->'dailyCapPerChannel') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'interact.points.accrual needs numeric pointsPerBlock, blockMinutes, dailyCapPerChannel'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (v->>'pointsPerBlock')::numeric NOT BETWEEN 1 AND 1000
     OR (v->>'blockMinutes')::numeric NOT BETWEEN 1 AND 60
     OR (v->>'dailyCapPerChannel')::numeric NOT BETWEEN 0 AND 100000
     OR (v->>'pointsPerBlock')::numeric <> trunc((v->>'pointsPerBlock')::numeric)
     OR (v->>'blockMinutes')::numeric <> trunc((v->>'blockMinutes')::numeric)
     OR (v->>'dailyCapPerChannel')::numeric <> trunc((v->>'dailyCapPerChannel')::numeric) THEN
    RAISE EXCEPTION 'interact.points.accrual values out of range' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER governance_settings_points_accrual_ck BEFORE INSERT OR UPDATE ON public.governance_settings
  FOR EACH ROW WHEN (NEW.key = 'interact.points.accrual') EXECUTE FUNCTION commonair_validate_points_accrual();
--> statement-breakpoint

-- 4. App role (additions only to 0029's version) -------------------------------------
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
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION commonair_configure_app_role(name) FROM PUBLIC;
