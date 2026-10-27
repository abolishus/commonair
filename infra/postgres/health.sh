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
# The marker starts with this container run's identity (the host's boot id and PID 1's start
# time), so a state file an earlier run left behind (podman restart keeps the writable layer)
# never matches a fresh start and cannot make it look stalled.
# COMMONAIR_PG_HEALTH_STATE (default /run/commonair-pg-health.state) holds the marker between
# runs: /run, not the world-writable /tmp, where another user could plant a file or a symlink
# at the predictable name this check (root) writes.
#
# A stop that does not take (a postmaster that ignores SIGQUIT, an entrypoint that ignores the
# forwarded SIGTERM) is escalated: a detached watcher sends SIGKILL after
# COMMONAIR_PG_KILL_GRACE_SECONDS (default 30). Detached, because the check itself must return
# within HealthStartupTimeout. The environment overrides exist for tests.
set -eu

mode="${1:-ready}"
pgdata="${PGDATA:-/var/lib/postgresql/data}"
stall_seconds="${COMMONAIR_PG_STALL_SECONDS:-600}"
start_seconds="${COMMONAIR_PG_START_SECONDS:-120}"
state="${COMMONAIR_PG_HEALTH_STATE:-/run/commonair-pg-health.state}"
kill_grace="${COMMONAIR_PG_KILL_GRACE_SECONDS:-30}"

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

# This container run: the host's boot id and PID 1's start time (field 22 of /proc/1/stat,
# the 20th after the parenthesised command name, which may contain spaces).
instance() {
  boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || true)
  init=$(sed 's/.*) //' /proc/1/stat 2>/dev/null | cut -d' ' -f20)
  printf '%s/%s' "$boot" "$init"
}

# Whether PID $1 runs a postgres server process: a stale postmaster.pid, or a PID reused since,
# can name another process.
is_postgres() {
  [ -n "$1" ] && tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null | grep -q '^postgres '
}

if ready; then
  rm -f "$state"
  exit 0
fi
[ "$mode" = --startup ] || exit 1

title=$(startup_title)
marker="run=$(instance) pm=$(postmaster || true) title=$title"
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
# restartpoint. Without a postmaster, stop whatever PID 1 runs (catatonit forwards the signal).
if is_postgres "$pid"; then
  kill -QUIT "$pid"
else
  pid=""
  kill -TERM 1
fi

# The watcher. Its output goes to the container log (PID 1's stderr); it must not hold the exec
# session's pipes open, or the check would not return until it ends.
(
  trap '' HUP
  sleep "$kill_grace"
  if [ -n "$pid" ]; then
    is_postgres "$pid" || exit 0
    printf 'commonair-pg-health: postmaster %s still running %ss after SIGQUIT; sending SIGKILL\n' "$pid" "$kill_grace" >/proc/1/fd/2 2>/dev/null || true
    kill -9 "$pid" 2>/dev/null || true
  else
    # Still here, so PID 1's child ignored SIGTERM. SIGKILL to PID 1 from inside its namespace
    # is ignored, so kill everything else (kill -1 spares PID 1 and this process): catatonit
    # exits when its child does.
    printf 'commonair-pg-health: container still running %ss after SIGTERM; sending SIGKILL\n' "$kill_grace" >/proc/1/fd/2 2>/dev/null || true
    # -9, not -s KILL: dash reads the -1 after -s KILL as an option.
    kill -9 -1 2>/dev/null || true
  fi
) </dev/null >/dev/null 2>&1 &
exit 2
