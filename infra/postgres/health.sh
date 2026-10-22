#!/bin/sh
# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Postgres health check, aware of WAL replay. Installed as commonair-pg-health.
#
#   commonair-pg-health            ready check (HealthCmd, compose healthcheck)
#   commonair-pg-health --startup  startup check (HealthStartupCmd)
#
# Exit 0: ready, meaning Postgres accepts connections and is out of recovery (a hot standby
# that is still replaying accepts read-only connections, which migrate cannot use).
# Exit 1: not ready yet. Exit 2 (--startup only): stuck, and this script has stopped the server
# so the unit's Restart= starts a fresh container.
#
# Why the startup check does the stopping: Podman counts every failed check towards a fixed
# limit, so no retry setting can tell "replaying for an hour, still advancing" from "hung".
# This script can. While Postgres starts it tracks a progress marker: the postmaster's
# identity plus the startup process's title, which names the WAL segment being fetched or
# replayed ("startup recovering 0000000100000000000000A3"). That title moves before the
# database is consistent, when no SQL works yet. The server is stopped when the marker has
# not changed for
#   COMMONAIR_PG_STALL_SECONDS (default 600) while a startup process exists (replay), or
#   COMMONAIR_PG_START_SECONDS (default 120) while none does (a normal start that never
#   comes up, as the plain pg_isready check allowed before).
# COMMONAIR_PG_HEALTH_STATE (default /tmp/commonair-pg-health.state) holds the marker between
# runs. The environment overrides exist for tests.
set -eu

mode="${1:-ready}"
pgdata="${PGDATA:-/var/lib/postgresql/data}"
stall_seconds="${COMMONAIR_PG_STALL_SECONDS:-600}"
start_seconds="${COMMONAIR_PG_START_SECONDS:-120}"
state="${COMMONAIR_PG_HEALTH_STATE:-/tmp/commonair-pg-health.state}"

# The control file, not recovery.signal: Postgres removes the signal file before recovery ends,
# while a hot standby still refuses writes. Reading it needs no connection slot.
ready() {
  LC_ALL=C pg_controldata "$pgdata" 2>/dev/null | grep -q '^Database cluster state: *in production$' &&
    pg_isready -q -t 3 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}"
}

# The title of the startup (recovery) process, if one runs.
startup_title() {
  for f in /proc/[0-9]*/cmdline; do
    title=$(tr '\0' ' ' <"$f" 2>/dev/null) || continue
    case "$title" in
      postgres:*startup*)
        printf '%s' "$title" | sed 's/ *$//'
        return 0
        ;;
    esac
  done
}

# Postmaster PID and start time from postmaster.pid (lines 1 and 3): a restarted server is a
# new marker even when it waits on the same segment.
postmaster() {
  [ -r "$pgdata/postmaster.pid" ] && sed -n '1p;3p' "$pgdata/postmaster.pid" | tr '\n' ' '
}

if ready; then
  rm -f "$state"
  exit 0
fi
[ "$mode" = --startup ] || exit 1

title=$(startup_title)
marker="pm=$(postmaster || true) title=$title"
now=$(date +%s)
since="$now"
if [ -r "$state" ] && [ "$(sed -n 1p "$state")" = "$marker" ]; then
  since=$(sed -n 2p "$state")
else
  printf '%s\n%s\n' "$marker" "$now" >"$state.tmp" && mv "$state.tmp" "$state"
fi

limit="$start_seconds"
[ -n "$title" ] && limit="$stall_seconds"
idle=$((now - since))
if [ "$idle" -lt "$limit" ]; then
  [ -n "$title" ] && echo "commonair-pg-health: replaying (${title#postgres: }), last progress ${idle}s ago"
  exit 1
fi

echo "commonair-pg-health: no progress for ${idle}s (limit ${limit}s); stopping Postgres so it restarts" >&2
rm -f "$state"
pid=$(sed -n 1p "$pgdata/postmaster.pid" 2>/dev/null || true)
# SIGQUIT is an immediate shutdown: safe here, the next start replays WAL from the last
# restartpoint. A stale postmaster.pid can name another process, so check it is a postmaster.
# Without one, stop whatever PID 1 runs (catatonit forwards the signal).
if [ -n "$pid" ] && tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q '^postgres '; then
  kill -QUIT "$pid"
else
  kill -TERM 1
fi
exit 2
