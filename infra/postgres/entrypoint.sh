#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Exports WAL-G's settings before the stock entrypoint starts the server, so the
# archive_command (which inherits the postmaster's environment) can reach S3.
#
# The stock entrypoint is sourced, not exec'd, so the temporary server it runs for initdb
# starts with archive_mode=off. With archiving on, stopping that server waits for the
# archiver to push the init WAL; on a first install S3 (Garage, its bucket and key) is often
# not ready yet, pg_ctl gives up after 60 s and the first start fails. The init WAL is worth
# nothing to a restore: no base backup can exist before the first start.
set -eu
# shellcheck source=infra/postgres/walg-env.sh
. /usr/local/lib/commonair/walg-env.sh

# The stock functions read variables that may be unset (DATABASE_ALREADY_EXISTS).
set +u
# shellcheck source=/dev/null
. /usr/local/bin/docker-entrypoint.sh

if [ "${1:-}" = postgres ] && [ "$(id -u)" = 0 ]; then
  # The stock _main re-execs its own file as postgres, which would drop the override below:
  # prepare the directories as it does, then re-exec this script instead.
  docker_setup_env
  docker_create_db_directories
  exec gosu postgres "$0" "$@"
fi

# Postgres takes no env var for its connection limit; pass it as a server flag instead.
if [ "${1:-}" = postgres ] && [ -n "${POSTGRES_MAX_CONNECTIONS:-}" ]; then
  set -- "$@" -c "max_connections=${POSTGRES_MAX_CONNECTIONS}"
fi

# A later -c wins, so this overrides the archive_mode=on the real server keeps.
eval "_stock_$(declare -f docker_temp_server_start)"
docker_temp_server_start() {
  _stock_docker_temp_server_start "$@" -c archive_mode=off
}

_main "$@"
