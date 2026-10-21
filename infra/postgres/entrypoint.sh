#!/bin/sh
# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Exports WAL-G's settings before the stock entrypoint starts the server, so the
# archive_command (which inherits the postmaster's environment) can reach S3.
set -eu
. /usr/local/lib/commonair/walg-env.sh
# Postgres takes no env var for its connection limit; pass it as a server flag instead.
if [ "${1:-}" = postgres ] && [ -n "${POSTGRES_MAX_CONNECTIONS:-}" ]; then
  set -- "$@" -c "max_connections=${POSTGRES_MAX_CONNECTIONS}"
fi
exec docker-entrypoint.sh "$@"
