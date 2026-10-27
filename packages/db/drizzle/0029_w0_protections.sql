-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- W0 protections (ADR 0019, statements of reasons), in addition to 0016 and 0025, against a
-- caller with ordinary DML on every table who does not own them:
--   1. enforcement_statements is append-only for every role and cannot be truncated: a statement
--      is what the user was told (DSA Art. 17), never rewritten.
--   2. legal_documents: a published version (published_at <= now()) is immutable for every role,
--      so a statement's pinned notice and guidelines ids always name the text it was sent under.
--      An unpublished (future) version can be changed or deleted by the table owner only (the
--      operator CLI fixing a typo before it takes effect).
--   3. The app role cannot UPDATE or DELETE enforcement statements (the trigger already refuses;
--      this is the second layer). commonair_configure_app_role is redefined from 0025's version;
--      the migrate job re-runs it after every migration (infra/postgres/app-role.sql), which also
--      grants the new tables.

-- 1. Statements: append-only ---------------------------------------------------------
CREATE TRIGGER enforcement_statements_append_only BEFORE UPDATE OR DELETE ON public.enforcement_statements
  FOR EACH ROW EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER enforcement_statements_no_truncate BEFORE TRUNCATE ON public.enforcement_statements
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 2. Published legal documents are immutable -----------------------------------------
CREATE FUNCTION commonair_legal_document_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.published_at <= now() THEN
    RAISE EXCEPTION 'legal document % % is published and immutable (% rejected)', OLD.kind, OLD.version, TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT public.commonair_is_owner(TG_RELID) THEN
    RAISE EXCEPTION 'only the database owner can change an unpublished legal document'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER legal_documents_guard BEFORE UPDATE OR DELETE ON public.legal_documents
  FOR EACH ROW EXECUTE FUNCTION commonair_legal_document_guard();
--> statement-breakpoint

-- 3. App role (additions only to 0025's version) -------------------------------------
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
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION commonair_configure_app_role(name) FROM PUBLIC;
