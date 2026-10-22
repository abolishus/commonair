#!/bin/sh
# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Push a full base backup of the running server to WALG_S3_PREFIX, then optionally
# prune old ones. Run inside the postgres container:
#   podman compose exec postgres commonair-backup
# Env: WALG_* / AWS_* (from the container), WALG_RETAIN_FULL (keep N full backups; unset = keep all).
set -eu
# shellcheck source=infra/postgres/walg-env.sh
. /usr/local/lib/commonair/walg-env.sh

# wal-g must read the data directory as its owner.
if [ "$(id -u)" = 0 ]; then
  exec gosu postgres "$0" "$@"
fi

: "${PGDATA:?PGDATA is not set}"
: "${WALG_S3_PREFIX:?WALG_S3_PREFIX is not set}"
export PGUSER="${PGUSER:-${POSTGRES_USER:-postgres}}"
export PGDATABASE="${PGDATABASE:-${POSTGRES_DB:-postgres}}"

echo "commonair-backup: base backup of $PGDATA to $WALG_S3_PREFIX" >&2
wal-g backup-push "$PGDATA"

if [ -n "${WALG_RETAIN_FULL:-}" ]; then
  echo "commonair-backup: keeping the newest $WALG_RETAIN_FULL full backups" >&2
  wal-g delete retain FULL "$WALG_RETAIN_FULL" --confirm
fi

wal-g backup-list >&2
