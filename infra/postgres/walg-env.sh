# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Sourced (not executed) by the entrypoint, commonair-backup and commonair-restore.
# Lets WAL-G use the platform's S3 settings (S3_*) unless AWS_* are given explicitly,
# so one env file serves compose, Quadlet and the backup scripts.
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-${S3_ACCESS_KEY_ID:-}}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-${S3_SECRET_ACCESS_KEY:-}}"
export AWS_REGION="${AWS_REGION:-${S3_REGION:-garage}}"
export AWS_ENDPOINT="${AWS_ENDPOINT:-${WALG_S3_ENDPOINT:-http://garage:3900}}"
export AWS_S3_FORCE_PATH_STYLE="${AWS_S3_FORCE_PATH_STYLE:-true}"
export WALG_S3_PREFIX="${WALG_S3_PREFIX:-s3://${S3_BUCKET_BACKUPS:-commonair-backups}/wal}"
