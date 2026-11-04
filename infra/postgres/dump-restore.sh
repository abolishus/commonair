#!/bin/sh
# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Restores a commonair-dump (infra/postgres/dump.sh) into a fresh database as its owner, with no
# superuser: the owner-only order of ADR 0032 §4 (as amended) and infra/postgres/restore-owner.sql.
# The restore drill runs it into a throwaway container (dump-drill.sh); a real restore runs it
# against a new managed cluster (docs/self-hosting/managed-services.md).
#
#   RESTORE_TARGET_URL='postgres://owner:…@host/newdb?sslmode=verify-full' [PGSSLROOTCERT=…] \
#     commonair-dump-restore /path/commonair.dump
#
#   0. the roles the dump's grants name, commonair_app and commonair_monitor, NOLOGIN where
#      missing: roles belong to the cluster, not the dump. The migrate job (apply-app-role.ts)
#      gives them LOGIN and their passwords when the instance starts against the database.
#   1. pg_restore --section=pre-data --no-owner   (schemas, tables, functions; no triggers yet)
#   2. restore-owner.sql, commonair.restore_triggers=disable
#   3. pg_restore --section=data
#   4. restore-owner.sql, commonair.restore_triggers=enable
#   5. pg_restore --section=post-data             (indexes, constraints, triggers; FKs checked)
#
# Privileges are restored, not skipped: the migrations revoke EXECUTE on the SECURITY DEFINER
# functions from PUBLIC, and --no-privileges would hand those back to every role.
#
# The target database must exist, belong to the restoring role and hold no table yet. The URL
# reaches this script through the environment only. Errors print without DETAIL, CONTEXT or
# statement lines, which can quote row values.
set -eu

fail() {
  printf 'commonair-dump-restore: %s\n' "$*" >&2
  exit 1
}

: "${RESTORE_TARGET_URL:?RESTORE_TARGET_URL is not set (the owner URL of the database to restore into)}"
[ $# -eq 1 ] || fail "usage: commonair-dump-restore <dump file>"
dump=$1
OWNER_SQL=${RESTORE_OWNER_SQL:-/usr/local/share/commonair/restore-owner.sql}
[ -r "$dump" ] || fail "cannot read $dump"
[ -r "$OWNER_SQL" ] || fail "no $OWNER_SQL"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
trap 'exit 1' INT TERM

errors() { grep -Ev '^(psql:[^ ]* )?(DETAIL|CONTEXT|HINT|LINE [0-9]+|QUERY|STATEMENT|Command was):|^[[:space:]]' "$1" | head -n 5 >&2 || true; }

q() { psql -X -q -A -t -v ON_ERROR_STOP=1 --no-password -d "$RESTORE_TARGET_URL" "$@"; }

step() { printf 'commonair-dump-restore: %s\n' "$*" >&2; }

tables=$(q -c "SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'drizzle')" 2>"$work/err") || {
  errors "$work/err"
  fail "cannot connect to the target database"
}
[ "$tables" = 0 ] || fail "the target database already has $tables tables: restore into a new, empty database"

step "0/5 roles the grants name"
q -c "DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'commonair_app') THEN CREATE ROLE commonair_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'commonair_monitor') THEN CREATE ROLE commonair_monitor NOLOGIN; END IF;
END \$\$" 2>"$work/err" || {
  errors "$work/err"
  fail "could not create the roles commonair_app and commonair_monitor (the owner needs CREATEROLE)"
}

section() {
  pg_restore --exit-on-error --no-owner --no-password --section="$1" -d "$RESTORE_TARGET_URL" "$dump" 2>"$work/err" || {
    errors "$work/err"
    fail "pg_restore --section=$1 failed"
  }
}

triggers() {
  PGOPTIONS="-c commonair.restore_triggers=$1" q -f "$OWNER_SQL" 2>"$work/err" || {
    errors "$work/err"
    fail "restore-owner.sql ($1) failed"
  }
}

step "1/5 pre-data"
section pre-data
step "2/5 user triggers off"
triggers disable
step "3/5 data"
section data
step "4/5 user triggers on"
triggers enable
step "5/5 post-data"
section post-data
step "done"
