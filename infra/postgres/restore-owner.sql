-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- Owner-only dump restore (ADR 0032 §4, contract step §1.3). `pg_restore --disable-triggers`
-- and `SET session_replication_role` both need a superuser, which a managed database does not
-- give. The restoring role owns the tables it creates, and an owner may disable their user
-- triggers, which leaves the internal foreign-key triggers alone. The procedure, as the owner,
-- into a fresh database:
--
--   1. pg_restore --section=pre-data --no-owner   (schemas, tables, functions; no triggers yet)
--   2. this file with commonair.restore_triggers=disable
--   3. pg_restore --section=data
--   4. this file with commonair.restore_triggers=enable
--   5. pg_restore --section=post-data             (indexes, constraints, triggers; FKs checked)
--   6. infra/postgres/apply-app-role.ts, then infra/postgres/restore-check.sql against the source
--
-- pg_dump puts triggers in post-data, so in a full restore steps 2 and 4 find none to switch.
-- They matter for a data-only restore into a schema that already has them (a migrated database),
-- where the follows trigger would count every follower a second time and the guards would refuse
-- rows of ended rooms, closed giveaways and closed jury panels. The drill keeps them so one
-- script covers both. Run it as:
--
--   PGOPTIONS='-c commonair.restore_triggers=disable' psql -X -v ON_ERROR_STOP=1 -f restore-owner.sql
--
-- It refuses when a table in the schemas is not the current role's: that would be the
-- superuser-only case (decision (a) in .claude/briefs/batch8/README.md).

DO $$
DECLARE
  mode text := current_setting('commonair.restore_triggers', true);
  t record;
  done_count int := 0;
BEGIN
  IF mode IS NULL OR mode NOT IN ('disable', 'enable') THEN
    RAISE EXCEPTION 'set commonair.restore_triggers to disable or enable (it is %)', coalesce(mode, 'unset');
  END IF;
  FOR t IN
    SELECT n.nspname, c.relname, pg_catalog.pg_get_userbyid(c.relowner) AS owner
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'drizzle')
    ORDER BY 1, 2
  LOOP
    IF NOT pg_catalog.pg_has_role(current_user, t.owner, 'USAGE') THEN
      RAISE EXCEPTION 'table %.% belongs to %, not %: restore as the role that owns every table',
        t.nspname, t.relname, t.owner, current_user;
    END IF;
    EXECUTE format('ALTER TABLE %I.%I %s TRIGGER USER', t.nspname, t.relname, upper(mode));
    done_count := done_count + 1;
  END LOOP;
  RAISE NOTICE 'restore-owner: % user triggers on % tables', mode, done_count;
END $$;
