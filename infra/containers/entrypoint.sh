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
    exec bun "services/${SERVICE}/src/main.ts" "$@"
    ;;
esac
