#!/bin/sh
# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# The restore drill's side inside its throwaway container (`selfhost.sh backup --drill`, and
# `--drill --walg`). selfhost.sh starts the container from the stack's Postgres image with no
# network and runs every step with `podman exec`, so nothing here can reach another server:
#
#   commonair-dump-drill serve            the container's command (as postgres): a fresh cluster
#                                         in $PGDATA, its marker file, then the server, on a Unix
#                                         socket only (listen_addresses='', host logins rejected)
#   commonair-dump-drill ready            exit 0 once the server takes connections, out of recovery
#   commonair-dump-drill restore <dump>   an owner with LOGIN and CREATEROLE only (no superuser),
#                                         its database, then commonair-dump-restore as that owner
#   commonair-dump-drill check [<file>|-] the counts against the dump's counts.json (stdin for -)
#   commonair-dump-drill check-walg       the same checks, without a counts file (a WAL-G restore)
#
# Every mode but serve first proves its target is this container's server (drill_guard): no
# host, URL or service in the environment, PGHOST a socket directory, the marker file in $PGDATA
# holding $COMMONAIR_DRILL_TOKEN, and the server it reaches reporting that data directory, a
# socket connection and no TCP listener. A live database never has the marker.
#
# Output is check names and numbers only (table names, counts, balances), never row data.
set -eu

SOCKET_DIR=/var/run/postgresql
MARKER=commonair-drill.token
OWNER=commonair_drill_owner
DB=commonair
CHECK_SQL=${RESTORE_CHECK_SQL:-/usr/local/share/commonair/restore-check.sql}
RESTORE=${COMMONAIR_DUMP_RESTORE:-/usr/local/bin/commonair-dump-restore}
# The cluster's superuser: postgres in the drill's own cluster, POSTGRES_USER in a WAL-G restore.
SU=${DRILL_SUPERUSER:-${POSTGRES_USER:-postgres}}

fail() {
  printf 'commonair-dump-drill: %s\n' "$*" >&2
  exit 1
}
refuse() {
  printf 'commonair-dump-drill: refused: %s\n' "$*" >&2
  exit 2
}

# Environment only, before any connection: what could point libpq anywhere but the local socket.
env_guard() {
  for _v in DATABASE_URL DUMP_PG_URL RESTORE_TARGET_URL PGHOSTADDR PGSERVICE PGSERVICEFILE PGSSLMODE PGPASSWORD; do
    eval "_val=\${$_v:-}"
    [ -z "$_val" ] || refuse "$_v is set: the drill connects to its own container's socket only"
  done
  case "${PGHOST:-}" in
    "" | "$SOCKET_DIR") ;;
    *) refuse "PGHOST=${PGHOST} is not this container's socket directory ($SOCKET_DIR)" ;;
  esac
  : "${PGDATA:?PGDATA is not set}"
  [ -n "${COMMONAIR_DRILL_TOKEN:-}" ] || refuse "COMMONAIR_DRILL_TOKEN is not set: this is not a drill container"
  [ -f "$PGDATA/$MARKER" ] || refuse "no $MARKER in $PGDATA: this is not the drill's cluster"
  [ "$(cat "$PGDATA/$MARKER")" = "$COMMONAIR_DRILL_TOKEN" ] || refuse "$PGDATA/$MARKER does not hold this drill's token"
  export PGHOST="$SOCKET_DIR"
  unset PGPORT 2>/dev/null || true
}

# The server must be the one whose data directory holds the marker. As the cluster's superuser:
# only superusers (and pg_read_all_settings) may read data_directory.
drill_guard() {
  env_guard
  _facts=$(psql -X -q -A -t -F '|' --no-password -U "$SU" -d postgres -c \
    "SELECT current_setting('data_directory'), inet_server_addr() IS NULL, current_setting('listen_addresses')" 2>/dev/null) ||
    fail "the drill's server does not answer on $SOCKET_DIR"
  [ "$_facts" = "$PGDATA|t|" ] || refuse "the server on $SOCKET_DIR is not the drill's (data directory, socket and no TCP: got '$_facts')"
}

sql() { psql -X -q -A -t -F ' ' -v ON_ERROR_STOP=1 --no-password "$@"; }

# The drill's checks, as "name value" lines: restore-check.sql, plus each ledger transaction
# balancing per currency and no SECURITY DEFINER function executable by PUBLIC (privileges
# restored, not dropped).
checks() {
  {
    cat "$CHECK_SQL"
    cat <<'SQL'
SELECT 'ledger.unbalanced_transactions', count(*) FROM (
  SELECT 1 FROM public.ledger_entries GROUP BY transaction_id, currency HAVING sum(amount_cents) <> 0
) t;
SELECT 'acl.public_definer_functions', count(*)
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef AND pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE');
SQL
  } | sql -U "$1" -d "$2"
}

# Compares "name value" lines ($1: expected from counts.json, or empty) with the actual ones
# ($2). Every expected check must match; a table the dump did not count is a mismatch; the
# invariants hold whatever the source said. The files are told apart by name, not FNR == NR:
# with an empty expected file (check-walg) that test holds for every actual line.
compare() {
  awk -v have_expected="$3" '
    FILENAME == ARGV[1] { if (NF == 2) want[$1] = $2; next }
    NF == 2 { act[$1] = $2 }
    END {
      bad = 0
      for (k in want) {
        if (!(k in act)) { printf "  %s: dump %s, missing after the restore\n", k, want[k]; bad++ }
        else if (act[k] != want[k]) { printf "  %s: dump %s, restored %s\n", k, want[k], act[k]; bad++ }
      }
      for (k in act) {
        if (have_expected == "yes" && k ~ /^rows\./ && !(k in want)) { printf "  %s: restored %s, not in the dump\n", k, act[k]; bad++ }
        if ((k == "follows.count_mismatch" || k ~ /^ledger\.balance\./ || k == "ledger.unbalanced_transactions" || k == "acl.public_definer_functions") && act[k] != 0) {
          printf "  %s: %s, must be 0\n", k, act[k]; bad++
        }
      }
      n = 0; for (k in act) n++
      if (bad) { printf "%d of the checks failed (of %d)\n", bad, n; exit 1 }
      printf "all %d checks match\n", n
    }
  ' "$1" "$2"
}

mode=${1:-}
[ $# -gt 0 ] && shift
case "$mode" in
  serve)
    [ "$(id -u)" != 0 ] || fail "serve runs as postgres (podman run --user postgres)"
    : "${PGDATA:?PGDATA is not set}"
    [ -n "${COMMONAIR_DRILL_TOKEN:-}" ] || fail "COMMONAIR_DRILL_TOKEN is not set"
    mkdir -p "$PGDATA"
    [ -z "$(ls -A "$PGDATA")" ] || fail "$PGDATA is not empty"
    initdb -D "$PGDATA" -U postgres --auth-local=trust --auth-host=reject >/dev/null
    printf '%s\n' "$COMMONAIR_DRILL_TOKEN" >"$PGDATA/$MARKER"
    # A scratch copy: durability buys nothing, and no TCP listener at all.
    exec postgres -D "$PGDATA" -c listen_addresses= -c "unix_socket_directories=$SOCKET_DIR" \
      -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c archive_mode=off -c max_wal_size=4GB
    ;;
  ready)
    env_guard
    _r=$(psql -X -q -A -t --no-password -U "$SU" -d postgres -c 'SELECT pg_is_in_recovery()' 2>/dev/null) || exit 1
    [ "$_r" = f ]
    ;;
  restore)
    [ $# -eq 1 ] || fail "usage: commonair-dump-drill restore <dump file>"
    drill_guard
    # The provider's side: an owner with what a managed database's owner has at most, and a fresh
    # database it owns. Then the restore runs as that owner, never as the superuser.
    sql -U "$SU" -d postgres -c "CREATE ROLE $OWNER LOGIN CREATEROLE NOSUPERUSER NOREPLICATION NOBYPASSRLS"
    sql -U "$SU" -d postgres -c "CREATE DATABASE $DB OWNER $OWNER"
    RESTORE_TARGET_URL="host=$SOCKET_DIR dbname=$DB user=$OWNER" "$RESTORE" "$1"
    ;;
  check)
    src=${1:--}
    drill_guard
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    if [ "$src" = - ]; then cat >"$work/counts.json"; else cp "$src" "$work/counts.json"; fi
    grep -q '"format": "commonair-dump-counts/1"' "$work/counts.json" || fail "not a commonair-dump counts file"
    sed -n 's/^ *"\([A-Za-z0-9_.-]*\)": *\(-\{0,1\}[0-9][0-9]*\),\{0,1\}$/\1 \2/p' "$work/counts.json" >"$work/expected"
    [ -s "$work/expected" ] || fail "the counts file holds no checks"
    checks "$OWNER" "$DB" >"$work/actual" || fail "the checks did not run"
    compare "$work/expected" "$work/actual" yes
    ;;
  check-walg)
    _db=${POSTGRES_DB:-$SU}
    drill_guard
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    : >"$work/expected"
    checks "$SU" "$_db" >"$work/actual" || fail "the checks did not run"
    _migrations=$(sed -n 's/^rows\.drizzle\.__drizzle_migrations \([0-9]*\)$/\1/p' "$work/actual")
    [ "${_migrations:-0}" -gt 0 ] || fail "the restored database has no migrations: not a CommonAir database"
    compare "$work/expected" "$work/actual" no
    ;;
  *) fail "usage: commonair-dump-drill serve | ready | restore <dump> | check [<file>|-] | check-walg" ;;
esac
