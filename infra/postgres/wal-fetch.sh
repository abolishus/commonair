#!/bin/sh
# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# restore_command for WAL replay after commonair-restore. Installed as commonair-wal-fetch.
#
#   commonair-wal-fetch %f %p
#
# Postgres reads any exit status from 1 to 125 as "this segment is not in the archive": it ends
# archive recovery there and promotes. `wal-g wal-fetch` exits 74 for a missing segment but 1
# for every other failure (bucket unreachable, bad key, wrong region), so calling it directly
# would turn an outage of the backup bucket into an early promotion at the wrong point, silently
# dropping the rest of the archive. Here only "not found" ends the replay. Any other failure
# exits 126, which Postgres treats as FATAL: the server stops, the unit's Restart= starts it
# again and the replay resumes from its last restartpoint once the bucket answers.
set -u
. /usr/local/lib/commonair/walg-env.sh

# WAL-G's exit status for a segment the archive does not have (ExIoError).
not_found=74

wal-g wal-fetch "$1" "$2"
rc=$?
case "$rc" in
  0) exit 0 ;;
  "$not_found") exit 1 ;;
  *)
    echo "commonair-wal-fetch: wal-g wal-fetch $1 failed (exit $rc); stopping recovery instead of promoting early" >&2
    exit 126
    ;;
esac
