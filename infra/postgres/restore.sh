#!/bin/sh
# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Restore a base backup into an EMPTY data directory and prepare WAL replay from the
# archive. The next `postgres` start replays every archived segment, then promotes
# (or stops at RECOVERY_TARGET_TIME if set).
#
#   commonair-restore [target-dir] [backup-name]
#     target-dir    default $PGDATA; must be empty or absent; the server must not be using it
#     backup-name   default LATEST (see `wal-g backup-list`)
#   RECOVERY_TARGET_TIME  optional, e.g. "2026-10-18 12:00:00+00" (point-in-time recovery)
set -eu
. /usr/local/lib/commonair/walg-env.sh

if [ "$(id -u)" = 0 ]; then
  target="${1:-${PGDATA:?PGDATA is not set}}"
  mkdir -p "$target"
  chown postgres:postgres "$target"
  exec gosu postgres "$0" "$@"
fi

target="${1:-${PGDATA:?PGDATA is not set}}"
backup="${2:-LATEST}"
: "${WALG_S3_PREFIX:?WALG_S3_PREFIX is not set}"

mkdir -p "$target"
if [ -n "$(ls -A "$target" 2>/dev/null)" ]; then
  echo "commonair-restore: $target is not empty; refusing to overwrite a data directory" >&2
  exit 1
fi
chmod 0700 "$target"

echo "commonair-restore: fetching $backup from $WALG_S3_PREFIX into $target" >&2
wal-g backup-fetch "$target" "$backup"

{
  echo "# added by commonair-restore"
  # Sourcing the env file makes replay work however the server is started.
  echo "restore_command = '. /usr/local/lib/commonair/walg-env.sh && wal-g wal-fetch %f %p'"
  if [ -n "${RECOVERY_TARGET_TIME:-}" ]; then
    echo "recovery_target_time = '$RECOVERY_TARGET_TIME'"
    echo "recovery_target_action = 'promote'"
  fi
} >>"$target/postgresql.auto.conf"
touch "$target/recovery.signal"

echo "commonair-restore: ready; start postgres on $target to replay WAL" >&2
