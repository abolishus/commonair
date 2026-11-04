# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
# shellcheck shell=sh
#
# Sourced by Grafana's entrypoint before /run.sh (`. /etc/grafana/provisioning/alerting/route-env.sh`)
# to install the alert route (docs/operators/on-call.md#the-alert-route):
# - Grafana's SMTP settings default to the instance's relay (SMTP_*, MAIL_FROM) unless GF_SMTP_*
#   are set, so the alert mail uses the relay the app already sends with;
# - it copies the read-only provisioning to a writable directory, renders commonair.yaml.tmpl
#   there with ALERT_EMAIL_TO and ALERT_WEBHOOK_URL, and points GF_PATHS_PROVISIONING at it;
# - an unset or placeholder ALERT_EMAIL_TO keeps a placeholder address Grafana accepts but cannot
#   deliver to, and the missing route is logged loudly. Never fatal: Grafana with no route still
#   shows every alert, and a failure here leaves the provisioning as it was.
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
  [ -n "${MAIL_FROM:-}" ] && GF_SMTP_FROM_ADDRESS="$(printf '%s' "$MAIL_FROM" | sed 's/.*<\(.*\)>.*/\1/')" && export GF_SMTP_FROM_ADDRESS
  # Implicit TLS (465/2465) when SMTP_SECURE; otherwise STARTTLS, required once a user is set.
  if [ "${SMTP_SECURE:-false}" != true ] && [ -n "${SMTP_USER:-}" ]; then
    export GF_SMTP_STARTTLS_POLICY=MandatoryStartTLS
  fi
fi

commonair_no_route=""
commonair_email="${ALERT_EMAIL_TO:-}"
if commonair_placeholder "$commonair_email"; then
  commonair_no_route="ALERT_EMAIL_TO"
  commonair_email="no-route@alerts.invalid"
elif [ "${GF_SMTP_ENABLED:-false}" != true ]; then
  commonair_no_route="SMTP (GF_SMTP_* or SMTP_HOST)"
fi
commonair_webhook="${ALERT_WEBHOOK_URL:-}"
commonair_placeholder "$commonair_webhook" && commonair_webhook=""

# Render: a single-quoted YAML scalar doubles its quotes, and Grafana's env expansion of contact
# point settings needs a literal $ as $$. awk's index/substr, not gsub, so & and \ stay literal.
commonair_src="${COMMONAIR_PROVISIONING_SRC:-/etc/grafana/provisioning}"
commonair_out="${COMMONAIR_PROVISIONING_OUT:-/tmp/commonair-provisioning}"
if rm -rf "$commonair_out" && mkdir -p "$commonair_out" && cp -R "$commonair_src/." "$commonair_out/" &&
  COMMONAIR_EMAIL="$commonair_email" COMMONAIR_WEBHOOK="$commonair_webhook" awk '
    function twice(v, c,   out, i) {
      out = ""
      while ((i = index(v, c)) > 0) { out = out substr(v, 1, i) c; v = substr(v, i + 1) }
      return out v
    }
    function lit(v) { return twice(twice(v, sprintf("%c", 39)), "$") }
    function put(line, key, val,   i) {
      while ((i = index(line, key)) > 0) line = substr(line, 1, i - 1) val substr(line, i + length(key))
      return line
    }
    {
      line = $0
      if (line ~ /^#@WEBHOOK@/) { if (ENVIRON["COMMONAIR_WEBHOOK"] == "") next; line = substr(line, 11) }
      line = put(line, "@ALERT_EMAIL_TO@", lit(ENVIRON["COMMONAIR_EMAIL"]))
      line = put(line, "@ALERT_WEBHOOK_URL@", lit(ENVIRON["COMMONAIR_WEBHOOK"]))
      print line
    }' "$commonair_src/alerting/commonair.yaml.tmpl" >"$commonair_out/alerting/commonair.yaml" &&
  rm -f "$commonair_out/alerting/commonair.yaml.tmpl" "$commonair_out/alerting/route-env.sh"; then
  export GF_PATHS_PROVISIONING="$commonair_out"
else
  printf 'commonair grafana: could not render the alerting provisioning; no alert rules or route\n' >&2
fi

if [ -n "$commonair_no_route" ] && [ -z "$commonair_webhook" ]; then
  printf '%s\n' \
    "*****************************************************************************" \
    "commonair grafana: NO ALERT ROUTE ($commonair_no_route unset or a placeholder," \
    "and no ALERT_WEBHOOK_URL). Alerts fire in Grafana but reach nobody." \
    "See docs/operators/on-call.md#the-alert-route." \
    "*****************************************************************************" >&2
elif [ -n "$commonair_no_route" ]; then
  printf 'commonair grafana: no alert mail (%s unset or a placeholder); webhook only\n' "$commonair_no_route" >&2
else
  printf 'commonair grafana: alert route: mail%s\n' "$([ -n "$commonair_webhook" ] && printf ' and webhook')" >&2
fi
unset commonair_no_route commonair_email commonair_webhook commonair_src commonair_out
