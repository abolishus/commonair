#!/bin/sh
# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Places the status monitor's alert settings on the monitoring droplet, over SSH, so the relay
# password never passes through tofu, cloud-init or droplet metadata (docs/operators/status-page.md).
#
#   infra/status/place-secret.sh root@<monitoring-ip> < alert.env
#
# alert.env holds KEY=VALUE lines, only these keys:
#   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD, MAIL_FROM,
#   ALERT_EMAIL_TO (comma-separated), ALERT_WEBHOOK_URL (optional)
# It lands as /etc/commonair-status/alert.env, mode 0400, owned by the renderer's uid (65534),
# and the renderer runs once so the route is checked at once (its journal says "alert route").
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <ssh destination> < alert.env" >&2
  exit 2
fi

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
cat >"$tmp"

# Comments and blank lines are fine; any other line must be one of the known keys.
bad=$(grep -Ev '^[[:space:]]*(#.*)?$' "$tmp" |
  grep -Ev '^(SMTP_HOST|SMTP_PORT|SMTP_SECURE|SMTP_USER|SMTP_PASSWORD|MAIL_FROM|ALERT_EMAIL_TO|ALERT_WEBHOOK_URL)=' |
  sed 's/=.*//' || true)
if [ -n "$bad" ]; then
  echo "unknown keys in alert.env: $bad" >&2
  exit 1
fi
grep -q '^ALERT_EMAIL_TO=.' "$tmp" || echo "warning: no ALERT_EMAIL_TO, so no alert mail (webhook only)" >&2

# shellcheck disable=SC2029 # the remote command is a fixed string
ssh "$1" 'set -eu
umask 077
d=/etc/commonair-status
cat >"$d/alert.env.new"
chown 65534:65534 "$d/alert.env.new"
chmod 0400 "$d/alert.env.new"
mv "$d/alert.env.new" "$d/alert.env"
systemctl start commonair-status-render.service
journalctl -u commonair-status-render.service -n 20 --no-pager -o cat | grep -E "alert route|NO ALERT ROUTE|rendered" || true' <"$tmp"
