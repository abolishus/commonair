-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- E7 protections (platform debts: DMCA and account actions), in addition to 0016's trust & safety
-- triggers, against a caller with ordinary DML on every table who does not own them:
--   1. account_actions: never deleted; only the reversal columns change, once, from NULL.
--   2. dmca_notice_items: never deleted; removal, hiding and restore are set once each.
--   3. No TRUNCATE on account_actions or any dmca_* table.
--   4. The app role cannot DELETE account actions or DMCA records. dmca_notices and
--      dmca_counter_notices stay updatable (status, suit, scrubbing).

-- 1-2. Revocable rows (the 0016 function) ---------------------------------------------
CREATE TRIGGER account_actions_guard BEFORE UPDATE OR DELETE ON public.account_actions
  FOR EACH ROW EXECUTE FUNCTION commonair_revocable_row_guard('reversed_at', 'reversed_by_id', 'reversed_reason', 'reversal_appeal_id');
--> statement-breakpoint
CREATE TRIGGER dmca_notice_items_guard BEFORE UPDATE OR DELETE ON public.dmca_notice_items
  FOR EACH ROW EXECUTE FUNCTION commonair_revocable_row_guard('removed_at', 'objects_hidden_at', 'restored_at');
--> statement-breakpoint

-- 3. No TRUNCATE ---------------------------------------------------------------------
CREATE TRIGGER account_actions_no_truncate BEFORE TRUNCATE ON public.account_actions
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER dmca_notice_items_no_truncate BEFORE TRUNCATE ON public.dmca_notice_items
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER dmca_notices_no_truncate BEFORE TRUNCATE ON public.dmca_notices
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER dmca_counter_notices_no_truncate BEFORE TRUNCATE ON public.dmca_counter_notices
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 4. App role (additions only to 0021's version) -------------------------------------
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
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION commonair_configure_app_role(name) FROM PUBLIC;
