#!/bin/sh
# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Container entrypoint for every CommonAir Bun image (see service.Containerfile).
set -eu
cd /app
case "${SERVICE:?SERVICE is not set}" in
  tools)
    # One-shot jobs pass their own command (compose `command:`).
    [ "$#" -gt 0 ] || { echo "tools image: pass a command, e.g. bun infra/garage/bootstrap.ts" >&2; exit 2; }
    exec "$@"
    ;;
  web)
    # apps/web owns how its build output is served (`start` script).
    cd apps/web
    exec bun run start "$@"
    ;;
  *)
    # Test instances only (docs/operators/capacity.md, "CPU profiles"): a quadlet drop-in sets
    # COMMONAIR_CPU_PROFILE to a mounted directory, and Bun writes a CPU profile there when the
    # service exits on SIGTERM. selfhost's render-env.sh never copies it from commonair.env.
    # Unset or empty, the command is exactly the one at the end.
    if [ -n "${COMMONAIR_CPU_PROFILE:-}" ]; then
      if [ ! -d "$COMMONAIR_CPU_PROFILE" ] || [ ! -w "$COMMONAIR_CPU_PROFILE" ]; then
        echo "COMMONAIR_CPU_PROFILE=$COMMONAIR_CPU_PROFILE is not a writable directory" >&2
        exit 64
      fi
      echo "CPU profiler on for $SERVICE: profiles go to $COMMONAIR_CPU_PROFILE on exit (test instances only)" >&2
      exec bun --cpu-prof --cpu-prof-md --cpu-prof-dir="$COMMONAIR_CPU_PROFILE" "services/${SERVICE}/src/main.ts" "$@"
    fi
    exec bun "services/${SERVICE}/src/main.ts" "$@"
    ;;
esac
