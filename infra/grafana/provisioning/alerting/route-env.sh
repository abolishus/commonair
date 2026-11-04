# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Sourced by Grafana's entrypoint before /run.sh (`. /etc/grafana/provisioning/alerting/route-env.sh`),
# for commonair.yaml beside it (docs/operators/on-call.md#the-alert-route):
# - Grafana's SMTP settings default to the instance's relay (SMTP_*, MAIL_FROM) unless GF_SMTP_*
#   are set, so the alert mail uses the relay the app already sends with;
# - an unset or placeholder ALERT_EMAIL_TO or ALERT_WEBHOOK_URL becomes a placeholder Grafana
#   accepts but cannot deliver to, and the missing route is logged loudly. Never fatal: Grafana
#   with no route still shows every alert.
# POSIX sh (the image's busybox); prints no secret.

commonair_placeholder() {
  case "${1:-}" in
    "" | *example.com | *example.org | *example.net | *.invalid) return 0 ;;
    *example.com/* | *example.org/* | *example.net/* | *.invalid/* | *.invalid:*) return 0 ;;
    *changeme* | *__generate__*) return 0 ;;
    *) return 1 ;;
  esac
}

if [ -z "${GF_SMTP_HOST:-}" ] && [ -n "${SMTP_HOST:-}" ]; then
  export GF_SMTP_ENABLED=true
  export GF_SMTP_HOST="${SMTP_HOST}:${SMTP_PORT:-587}"
  [ -n "${SMTP_USER:-}" ] && export GF_SMTP_USER="$SMTP_USER"
  [ -n "${SMTP_PASSWORD:-}" ] && export GF_SMTP_PASSWORD="$SMTP_PASSWORD"
  [ -n "${MAIL_FROM:-}" ] && export GF_SMTP_FROM_ADDRESS="$(printf '%s' "$MAIL_FROM" | sed 's/.*<\(.*\)>.*/\1/')"
  # Implicit TLS (465/2465) when SMTP_SECURE; otherwise STARTTLS, required once a user is set.
  if [ "${SMTP_SECURE:-false}" != true ] && [ -n "${SMTP_USER:-}" ]; then
    export GF_SMTP_STARTTLS_POLICY=MandatoryStartTLS
  fi
fi

commonair_no_route=""
if commonair_placeholder "${ALERT_EMAIL_TO:-}"; then
  commonair_no_route="ALERT_EMAIL_TO"
  export ALERT_EMAIL_TO="no-route@alerts.invalid"
elif [ "${GF_SMTP_ENABLED:-false}" != true ]; then
  commonair_no_route="SMTP (GF_SMTP_* or SMTP_HOST)"
fi
if commonair_placeholder "${ALERT_WEBHOOK_URL:-}"; then
  # Loopback discard port: the webhook integration fails fast and harms nothing.
  export ALERT_WEBHOOK_URL="http://127.0.0.1:9/no-webhook-configured"
  commonair_webhook=off
else
  commonair_webhook=on
fi

if [ -n "$commonair_no_route" ] && [ "$commonair_webhook" = off ]; then
  printf '%s\n' \
    "*****************************************************************************" \
    "commonair grafana: NO ALERT ROUTE ($commonair_no_route unset or a placeholder," \
    "and no ALERT_WEBHOOK_URL). Alerts fire in Grafana but reach nobody." \
    "See docs/operators/on-call.md#the-alert-route." \
    "*****************************************************************************" >&2
elif [ -n "$commonair_no_route" ]; then
  printf 'commonair grafana: no alert mail (%s unset or a placeholder); webhook only\n' "$commonair_no_route" >&2
else
  printf 'commonair grafana: alert route: mail%s\n' "$([ "$commonair_webhook" = on ] && printf ' and webhook')" >&2
fi
unset commonair_no_route commonair_webhook
