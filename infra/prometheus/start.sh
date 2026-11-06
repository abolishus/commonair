#!/bin/sh
# SPDX-FileCopyrightText: 2026 CommonAir contributors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Prometheus entrypoint (the pinned image's busybox sh). Prometheus reads no environment in rules
# or scrape configs, so this renders the operator's settings into files prometheus.yml includes,
# then execs Prometheus with the arguments it was given:
#   SLO_TARGET              availability target, 0 < x < 1 (default 0.995, stage 0; our instance 0.999)
#   EGRESS_BUDGET_GIB       monthly origin egress budget in GiB (ADR 0032 stage 3; unset: no alert)
#   LIVE_STREAMS_PER_HOST   S1-a's per-host live stream number (stage 2; unset: no alert)
#   MANAGED_DB_METRICS_TARGETS  comma-separated host:port list of a provider's metrics endpoints
#                           (DigitalOcean: the clusters' metrics_endpoints, port 9273). Unset: the
#                           optional managed-db-metrics job is not rendered (the default).
#   MANAGED_DB_METRICS_USER, MANAGED_DB_METRICS_CA_FILE, and the password in the file
#   MANAGED_DB_METRICS_PASSWORD_FILE (default /run/secrets/managed-db-metrics-password).
#   STATUS_PAGE_URL         the status page's origin, https://status.<domain> (docs/operators/
#                           status-page.md). Set: the status-page job scrapes its metrics.txt, and
#                           CommonairStatusPageStale fires when it stops changing. Unset: no job.
# A bad value is reported and ignored, never fatal: a crash loop here would hide every metric.
set -eu

OUT=${COMMONAIR_PROMETHEUS_GENERATED:-/tmp/commonair}
mkdir -p "$OUT/rules" "$OUT/scrape"
rm -f "$OUT"/rules/*.yml "$OUT"/scrape/*.yml

warn() { printf 'commonair prometheus: %s\n' "$*" >&2; }
# Strictly between 0 and 1, plain decimal: 0.995, 0.999.
is_ratio() { printf '%s' "$1" | grep -Eq '^0\.[0-9]*[1-9][0-9]*$'; }
# A positive decimal: 1, 2.5.
is_positive() { printf '%s' "$1" | grep -Eq '^[0-9]+(\.[0-9]+)?$' && printf '%s' "$1" | grep -Eq '[1-9]'; }

slo=${SLO_TARGET:-}
if [ -z "$slo" ]; then
  slo=0.995
elif ! is_ratio "$slo"; then
  warn "SLO_TARGET=$slo is not a number between 0 and 1; using 0.995"
  slo=0.995
fi

{
  printf 'groups:\n  - name: commonair-configured\n    rules:\n'
  printf '      - record: commonair:slo_target:configured\n        expr: vector(%s)\n' "$slo"
  printf '        labels:\n          slo_target: "%s"\n' "$slo"
  egress=${EGRESS_BUDGET_GIB:-}
  if [ -n "$egress" ]; then
    if is_positive "$egress"; then
      printf '      - record: commonair:egress_budget_bytes\n        expr: vector(%s * 1073741824)\n' "$egress"
    else
      warn "EGRESS_BUDGET_GIB=$egress is not a positive number; the egress alert stays off"
    fi
  fi
  streams=${LIVE_STREAMS_PER_HOST:-}
  if [ -n "$streams" ]; then
    if printf '%s' "$streams" | grep -Eq '^[1-9][0-9]*$'; then
      printf '      - record: commonair:live_streams_per_host\n        expr: vector(%s)\n' "$streams"
    else
      warn "LIVE_STREAMS_PER_HOST=$streams is not a positive integer; the streams alert stays off"
    fi
  fi
} >"$OUT/rules/configured.yml"

targets=${MANAGED_DB_METRICS_TARGETS:-}
if [ -n "$targets" ]; then
  user=${MANAGED_DB_METRICS_USER:-}
  pwfile=${MANAGED_DB_METRICS_PASSWORD_FILE:-/run/secrets/managed-db-metrics-password}
  ca=${MANAGED_DB_METRICS_CA_FILE:-}
  list=""
  ok=yes
  for t in $(printf '%s' "$targets" | tr ',' ' '); do
    if printf '%s' "$t" | grep -Eq '^[A-Za-z0-9.-]+:[0-9]{1,5}$'; then
      list="$list${list:+, }\"$t\""
    else
      warn "MANAGED_DB_METRICS_TARGETS: '$t' is not host:port"
      ok=no
    fi
  done
  if ! printf '%s' "$user" | grep -Eq '^[A-Za-z0-9._@-]+$'; then
    warn "MANAGED_DB_METRICS_USER is empty or has characters other than letters, digits and ._@-"
    ok=no
  fi
  if [ ! -s "$pwfile" ]; then
    warn "the managed-db-metrics password file $pwfile is missing or empty"
    ok=no
  fi
  if [ -n "$ca" ] && [ ! -s "$ca" ]; then
    warn "MANAGED_DB_METRICS_CA_FILE=$ca is missing or empty"
    ok=no
  fi
  if [ "$ok" = yes ] && [ -n "$list" ]; then
    {
      printf 'scrape_configs:\n  - job_name: managed-db-metrics\n'
      printf '    scheme: https\n    metrics_path: /metrics\n    scrape_interval: 60s\n'
      printf '    basic_auth:\n      username: "%s"\n      password_file: "%s"\n' "$user" "$pwfile"
      # Verified TLS only: the provider's CA when given, the system store otherwise.
      printf '    tls_config:\n      insecure_skip_verify: false\n'
      [ -z "$ca" ] || printf '      ca_file: "%s"\n' "$ca"
      printf '    static_configs:\n      - targets: [%s]\n' "$list"
    } >"$OUT/scrape/managed-db-metrics.yml"
  else
    warn "the managed-db-metrics job is not configured; fix the values above and restart"
  fi
fi

status_url=${STATUS_PAGE_URL:-}
if [ -n "$status_url" ]; then
  # https://host or https://host:port, nothing after it: the job reads /metrics.txt there.
  status_host=$(printf '%s' "$status_url" | sed -n -E 's#^https://([A-Za-z0-9.-]+(:[0-9]{1,5})?)/?$#\1#p')
  if [ -n "$status_host" ]; then
    {
      printf 'scrape_configs:\n  - job_name: status-page\n'
      printf '    scheme: https\n    metrics_path: /metrics.txt\n    scrape_interval: 60s\n    scrape_timeout: 15s\n'
      # Caddy serves the file as text/plain without a version.
      printf '    fallback_scrape_protocol: PrometheusText0.0.4\n'
      printf '    tls_config:\n      insecure_skip_verify: false\n'
      printf '    static_configs:\n      - targets: ["%s"]\n' "$status_host"
    } >"$OUT/scrape/status-page.yml"
  else
    warn "STATUS_PAGE_URL=$status_url is not https://<host>[:port]; the status page freshness check stays off"
  fi
fi

# `start.sh --render-only` stops here (infra/tests/observability.test.ts checks the output).
[ "${1:-}" != "--render-only" ] || exit 0
exec /bin/prometheus "$@"
