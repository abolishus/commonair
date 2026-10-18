-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Least-privilege application role (ADR 0004). Applied by the `migrate` job as the
-- database owner, after migrations, in one transaction. Idempotent.
--
-- The grants themselves are defined by the schema owner in
-- packages/db/drizzle/0002_protections_hardening.sql (commonair_configure_app_role);
-- this file only makes sure the role exists, is powerless outside those grants, and
-- cannot create temporary tables (the search_path shadowing vector in ADR 0004).
--
-- The password arrives as the transaction-local setting `commonair.app_password`
-- (set with set_config(..., true) by infra/postgres/apply-app-role.ts), so it is never
-- spliced into SQL text by the client.

DO $$
DECLARE
  pw text := current_setting('commonair.app_password', true);
BEGIN
  IF pw IS NULL OR length(pw) < 12 THEN
    RAISE EXCEPTION 'POSTGRES_APP_PASSWORD must be set (at least 12 characters)';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'commonair_app') THEN
    EXECUTE format('CREATE ROLE commonair_app LOGIN PASSWORD %L', pw);
  ELSE
    EXECUTE format('ALTER ROLE commonair_app WITH LOGIN PASSWORD %L', pw);
  END IF;
END $$;

-- No attribute that could bypass triggers, row security or grants.
ALTER ROLE commonair_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;

-- The role must never own objects (owners can disable triggers) nor inherit another role.
DO $$
DECLARE
  m record;
BEGIN
  IF EXISTS (
    SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
    WHERE r.rolname = 'commonair_app'
  ) THEN
    RAISE EXCEPTION 'commonair_app owns relations; reassign them to the schema owner first';
  END IF;
  FOR m IN
    SELECT g.rolname AS grp FROM pg_catalog.pg_auth_members am
    JOIN pg_catalog.pg_roles g ON g.oid = am.roleid
    JOIN pg_catalog.pg_roles u ON u.oid = am.member
    WHERE u.rolname = 'commonair_app'
  LOOP
    EXECUTE format('REVOKE %I FROM commonair_app', m.grp);
  END LOOP;
END $$;

-- Database level: CONNECT only. TEMP is revoked from PUBLIC (granted to it by default)
-- as defense in depth on top of the pinned search_path in every trigger function.
DO $$
DECLARE
  db text := current_database();
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', db);
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM commonair_app', db);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO commonair_app', db);
END $$;

-- Migration bookkeeping is the owner's business.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_namespace WHERE nspname = 'drizzle') THEN
    REVOKE ALL ON SCHEMA drizzle FROM commonair_app;
  END IF;
END $$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

SELECT commonair_configure_app_role('commonair_app');
