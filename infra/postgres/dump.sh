#!/bin/sh
# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Logical dump of the CommonAir database (ADR 0032 §4; `selfhost.sh backup --dump`): pg_dump in
# custom format on stdout, and the drill's counts (restore-check.sql) of the very same snapshot
# in $DUMP_COUNTS_OUT. A restore is then compared with exactly what was dumped, on a live
# instance whose rows change while the dump runs.
#
#   DUMP_PG_URL='postgres://owner:…@host/db?sslmode=verify-full' [PGSSLROOTCERT=…] \
#     commonair-dump > commonair.dump
#
# The URL (with the owner's password) comes from the environment, a Podman secret, never argv.
# Runs in the postgres image (its pg_dump and psql); nothing is staged on disk but the counts.
#
# One session opens a REPEATABLE READ transaction and exports its snapshot; the counts and
# pg_dump both run in that snapshot (SET TRANSACTION SNAPSHOT, pg_dump --snapshot), and the
# session ends only after pg_dump has finished with it.
set -eu

: "${DUMP_PG_URL:?DUMP_PG_URL is not set (the owner URL of the database to dump)}"
COUNTS_OUT=${DUMP_COUNTS_OUT:-/out/counts.json}
CHECK_SQL=${RESTORE_CHECK_SQL:-/usr/local/share/commonair/restore-check.sql}
SNAPSHOT_WAIT=${DUMP_SNAPSHOT_WAIT:-120}

fail() {
  printf 'commonair-dump: %s\n' "$*" >&2
  exit 1
}

[ -r "$CHECK_SQL" ] || fail "no $CHECK_SQL"
[ ! -t 1 ] || fail "stdout is a terminal: send the dump to a file or a pipe"
case "$SNAPSHOT_WAIT" in '' | *[!0-9]*) fail "DUMP_SNAPSHOT_WAIT is not a number of seconds" ;; esac

work=$(mktemp -d)
holder=""
cleanup() {
  exec 3>&-
  if [ -n "$holder" ]; then kill "$holder" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# Only the first lines of an error, and never a DETAIL, CONTEXT or statement line: those can
# quote row values, and this output reaches the journal.
errors() { grep -Ev '^(DETAIL|CONTEXT|HINT|LINE [0-9]+|QUERY|STATEMENT|Command was):|^[[:space:]]' "$1" | head -n 5 >&2 || true; }

# 1. The snapshot holder. `\g file` closes the file once written, and the rename marks it done.
mkfifo "$work/ctl"
psql -X -q -A -t -v ON_ERROR_STOP=1 --no-password -d "$DUMP_PG_URL" <"$work/ctl" >"$work/holder.out" 2>"$work/holder.err" &
holder=$!
exec 3>"$work/ctl"
printf '%s\n' \
  'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;' \
  "SELECT pg_catalog.pg_export_snapshot() \\g $work/snapshot.tmp" \
  "\\! mv $work/snapshot.tmp $work/snapshot" >&3

waited=0
while [ ! -s "$work/snapshot" ]; do
  if ! kill -0 "$holder" 2>/dev/null; then
    errors "$work/holder.err"
    fail "could not open a snapshot of the database"
  fi
  waited=$((waited + 1))
  [ "$waited" -le $((SNAPSHOT_WAIT * 10)) ] || fail "no snapshot after ${SNAPSHOT_WAIT}s"
  sleep 0.1
done
snapshot=$(head -n 1 "$work/snapshot")
printf '%s' "$snapshot" | grep -Eq '^[0-9A-Fa-f-]+$' || fail "unexpected snapshot id"

# 2. The counts, in that snapshot.
if ! {
  printf '%s\n' 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;' "SET TRANSACTION SNAPSHOT '$snapshot';"
  cat "$CHECK_SQL"
  printf '%s\n' 'COMMIT;'
} | psql -X -q -A -t -F ' ' -v ON_ERROR_STOP=1 --no-password -d "$DUMP_PG_URL" >"$work/counts.txt" 2>"$work/counts.err"; then
  errors "$work/counts.err"
  fail "counting the rows failed"
fi
mkdir -p "$(dirname "$COUNTS_OUT")"
awk '
  BEGIN { print "{"; print "  \"format\": \"commonair-dump-counts/1\","; print "  \"checks\": {" }
  NF == 0 { next }
  NF == 2 && $1 ~ /^[A-Za-z0-9_.-]+$/ && $2 ~ /^-?[0-9]+$/ {
    if (n++) printf ",\n"
    printf "    \"%s\": %s", $1, $2
    next
  }
  { bad = 1 }
  END { if (bad || n == 0) exit 1; printf "\n  }\n}\n" }
' "$work/counts.txt" >"$COUNTS_OUT.tmp" || fail "restore-check.sql gave output this script cannot read"
mv "$COUNTS_OUT.tmp" "$COUNTS_OUT"

# 3. The dump, in the same snapshot. Not verbose: its messages would name every table, and a
# failure's are filtered as above.
rc=0
pg_dump -d "$DUMP_PG_URL" --format=custom --snapshot="$snapshot" --no-password 2>"$work/dump.err" || rc=$?
if [ "$rc" -ne 0 ]; then
  errors "$work/dump.err"
  fail "pg_dump failed (exit $rc)"
fi

# 4. Release the snapshot.
printf '%s\n' 'COMMIT;' >&3
exec 3>&-
wait "$holder" || true
holder=""
