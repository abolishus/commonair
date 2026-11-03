-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Read-only metrics role `commonair_monitor` (ADR 0032 §6, contract step §1.2). The collector's
-- `postgresql` receiver logs in as it, locally for the bundled stack and over verified TLS for a
-- managed database. Applied by the `migrate` job as the database owner, after app-role.sql, in
-- the same transaction. Idempotent.
--
-- The password arrives as the transaction-local setting `commonair.monitor_password` (set with
-- set_config(..., true) by infra/postgres/apply-app-role.ts), never in SQL text.
--
-- `pg_monitor` is granted where the applying role may grant it: a superuser (the bundled stack)
-- can. On Postgres 16 and later a CREATEROLE role grants only roles it holds with ADMIN OPTION,
-- and a managed provider's owner (DigitalOcean's `doadmin`) does not hold pg_monitor that way, so
-- the grant is refused and the role is still created. Without pg_monitor the role still reads
-- pg_stat_database, pg_stat_user_tables, pg_statio_user_tables, pg_stat_bgwriter,
-- pg_stat_checkpointer, pg_stat_wal, pg_locks, pg_settings' common values, pg_database_size and
-- pg_relation_size. It loses what needs pg_read_all_stats or pg_monitor (ADR 0032 §4):
-- other roles' state, wait events and query text in pg_stat_activity, the client and lag columns
-- of pg_stat_replication, and pg_ls_waldir() (WAL size and file count).
-- packages/db/tests/external-owner.int.test.ts checks both branches.

DO $$
DECLARE
  pw text := current_setting('commonair.monitor_password', true);
BEGIN
  IF pw IS NULL OR length(pw) < 12 THEN
    RAISE EXCEPTION 'POSTGRES_MONITOR_PASSWORD must be set (at least 12 characters)';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'commonair_monitor') THEN
    EXECUTE format('CREATE ROLE commonair_monitor LOGIN PASSWORD %L', pw);
  ELSE
    EXECUTE format('ALTER ROLE commonair_monitor WITH LOGIN PASSWORD %L', pw);
  END IF;
END $$;

-- INHERIT so pg_monitor's privileges apply without SET ROLE; nothing that could write or bypass.
-- As in app-role.sql, a non-superuser may not name SUPERUSER, REPLICATION or BYPASSRLS at all,
-- so it switches off only what is on.
DO $$
DECLARE
  r record;
BEGIN
  IF (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
    ALTER ROLE commonair_monitor NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
  ELSE
    SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname = 'commonair_monitor';
    IF r.rolsuper THEN ALTER ROLE commonair_monitor NOSUPERUSER; END IF;
    IF r.rolreplication THEN ALTER ROLE commonair_monitor NOREPLICATION; END IF;
    IF r.rolbypassrls THEN ALTER ROLE commonair_monitor NOBYPASSRLS; END IF;
    IF r.rolcreatedb THEN ALTER ROLE commonair_monitor NOCREATEDB; END IF;
    IF r.rolcreaterole THEN ALTER ROLE commonair_monitor NOCREATEROLE; END IF;
    IF NOT r.rolinherit THEN ALTER ROLE commonair_monitor INHERIT; END IF;
  END IF;
END $$;
ALTER ROLE commonair_monitor CONNECTION LIMIT 5;
-- A scrape never writes, even where a grant would let it.
ALTER ROLE commonair_monitor SET default_transaction_read_only = on;

-- It must own nothing and belong to nothing but pg_monitor.
DO $$
DECLARE
  m record;
BEGIN
  IF EXISTS (
    SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
    WHERE r.rolname = 'commonair_monitor'
  ) THEN
    RAISE EXCEPTION 'commonair_monitor owns relations; reassign them to the schema owner first';
  END IF;
  FOR m IN
    SELECT g.rolname AS grp FROM pg_catalog.pg_auth_members am
    JOIN pg_catalog.pg_roles g ON g.oid = am.roleid
    JOIN pg_catalog.pg_roles u ON u.oid = am.member
    WHERE u.rolname = 'commonair_monitor' AND g.rolname <> 'pg_monitor'
  LOOP
    EXECUTE format('REVOKE %I FROM commonair_monitor', m.grp);
  END LOOP;
END $$;

-- CONNECT only; no schema or table grants. The statistics views it reads are public.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO commonair_monitor', current_database());
END $$;

DO $$
BEGIN
  IF NOT pg_catalog.pg_has_role('commonair_monitor', 'pg_monitor', 'MEMBER') THEN
    BEGIN
      GRANT pg_monitor TO commonair_monitor;
    EXCEPTION WHEN insufficient_privilege THEN
      -- Expected on a managed database: the role works with the reduced set above.
      RAISE NOTICE 'commonair_monitor: pg_monitor not granted (%)', SQLERRM;
    END;
  END IF;
END $$;
