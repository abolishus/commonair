<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Monitoring: metrics, dashboards and alerts

This page is for operators: what the stack measures, where it reads it, what each alert means, and
the few settings behind the lines. It implements §6 of
[ADR 0032](../decisions/0032-scaling-and-availability.md) ("Measure what the triggers name"):
stage triggers only count once dashboards show them.

Everything runs inside the stack, with no third-party service: the OpenTelemetry Collector
collects, Prometheus stores and evaluates, Grafana shows. The configuration is in
`infra/otel-collector/`, `infra/prometheus/` and `infra/grafana/`.

## Seeing the dashboards

Grafana listens on the host's loopback only, behind its admin login. From your machine:

```sh
ssh -L 3030:127.0.0.1:3030 commonair@stream.example.org
# then open http://localhost:3030 and sign in as admin
# (the password is in the commonair-grafana-admin-password Podman secret)
```

On a development stack (`podman compose up`), Grafana is at `http://localhost:3030` with
`GRAFANA_ADMIN_PASSWORD` from `.env`, and Prometheus at `http://localhost:9090`. The dashboards are
in the "CommonAir" folder:

| Dashboard      | What it shows                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------- |
| Stage triggers | One panel per ADR 0032 trigger, with the alert line (80%) and the trigger                          |
| Availability   | Availability over 30 days, the target, the error budget left, the burn rates, stage 0 budget spent |
| Host           | CPU, memory, load, the root filesystem and disk I/O                                                |
| Postgres       | Connections, size, statement time, transactions, rows, the largest tables                          |
| Valkey         | Memory against `maxmemory`, clients, commands, hits and misses, evictions                          |
| App            | Origin egress, HTTP latency and errors, chat connections, queues, outbox lag                       |

Prometheus is not published on a self-hosted instance. To read its alerts, ask it from the host:
`podman exec commonair-prometheus wget -qO- http://127.0.0.1:9090/api/v1/alerts`.

## What is collected, and from where

| Source        | How                                                                            | Bundled state                              | External (managed) state                                                        |
| ------------- | ------------------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------- |
| The services  | OTLP from each service to the collector (`http://otel-collector:4318`)         | same                                       | same                                                                            |
| The host      | the collector's `host_metrics` receiver, reading the host's `/proc`            | the one host                               | the app host; the managed nodes are not visible (see the optional scrape below) |
| Postgres      | the collector's `postgresql` and `sql_query` receivers, as `commonair_monitor` | `postgres:5432`, inside the Podman network | the managed cluster, over `sslmode=verify-full` with the provider's CA          |
| Valkey        | the collector's `redis` receiver, `INFO` only                                  | `valkey:6379`, inside the Podman network   | the managed cluster, over TLS verified against the provider's CA                |
| Managed nodes | the optional `managed-db-metrics` Prometheus job (off by default)              | not used                                   | the provider's metrics endpoint, if you turn it on                              |
| The collector | its own telemetry on `:8888` (job `otel-collector-internal`)                   | same                                       | same: the scrape error counters are the only sign the path to a cluster broke   |

One collector configuration serves both modes. `selfhost.sh` writes these keys to `commonair.env`
(the collector's unit receives only them):

| Key                                  | Bundled              | External                        |
| ------------------------------------ | -------------------- | ------------------------------- |
| `OBSERVABILITY_STATE_MODE`           | `bundled`            | `external`                      |
| `PG_MONITOR_ENDPOINT`                | `postgres:5432`      | the cluster's `host:port`       |
| `PG_MONITOR_USER`                    | `commonair_monitor`  | `commonair_monitor`             |
| `PG_MONITOR_TLS`                     | `disable`            | `verify-full`                   |
| `VALKEY_MONITOR_ENDPOINT`            | `valkey:6379`        | the cluster's `host:port`       |
| `VALKEY_MONITOR_USER`                | empty (default user) | empty, or an ACL user           |
| `VALKEY_MONITOR_TLS`                 | `off`                | `on`                            |
| `DATABASE_CA_FILE`, `VALKEY_CA_FILE` | empty                | the CA paths, mounted read-only |

The passwords are Podman secrets, `commonair-pg-monitor-password` and
`commonair-valkey-monitor-password`, handed to the collector as environment and never written to a
file or a log. Every series from the state receivers carries a `state_mode` label.

Unset keys take the bundled values above, but a key that is present and **empty** is used as it
is: an empty `PG_MONITOR_TLS`, `PG_MONITOR_USER` or Postgres password, an unknown TLS mode, or a
missing monitor secret makes the collector refuse its configuration and restart in a loop.

**That stops all telemetry, not only the state metrics.** There is one collector, so while it
refuses its configuration no service's traces, logs or metrics reach Tempo, Loki or Prometheus
either; the services themselves keep running (their units only want the collector, they do not
require it) and retry their exports. `selfhost.sh` refuses to write an empty or unknown value for
these keys, so this takes a hand edit of `commonair.env`. After one, check
`podman logs commonair-otel-collector` before anything else.

On a development stack the collector gets the bundled values from `compose.yaml` and the password
from `POSTGRES_MONITOR_PASSWORD` in `.env`. There, an empty or missing password becomes
`not-configured`, so the collector still starts (every service waits for its health): the login
fails at each scrape and [CommonairStateScrapeFailing](#commonairstatescrapefailing) fires. An
`.env` written before that key had a `__generate__` marker has `POSTGRES_MONITOR_PASSWORD=`, which
`bun scripts/init-env.ts --merge` keeps; set a value by hand (`openssl rand -hex 24`), then rerun
the `migrate` job so it creates the role.

`PG_MONITOR_TLS` and `VALKEY_MONITOR_TLS` take exactly those two values each, plus
`PG_MONITOR_TLS=require` (TLS without verifying the certificate), which `selfhost.sh` writes only
for a database URL with `sslmode=require` and `--allow-insecure-database`. They pick a file in
`infra/otel-collector/tls/`; any other value makes the collector refuse to start rather than fall
back to an unverified connection. `verify-full` checks the certificate chain against the CA (or the
system trust store when `DATABASE_CA_FILE` is empty) and the host name against the certificate.

**When a remote is down.** The collector starts anyway. Each failed scrape is logged; the
`postgresql` receiver also counts them in `otelcol_scraper_errored_metric_points`, and a Valkey that
does not answer leaves no `redis_*` series. Either way
[CommonairStateScrapeFailing](#commonairstatescrapefailing) fires after five minutes of it.

**Two host figures are not collected, on purpose.** Under rootless Podman the collector cannot see
another container's processes (`/proc/<pid>/status` is denied), so there is no per-process CPU, and
`/proc/net/dev` resolves to the collector's own network namespace, so host network counters would
count the collector's traffic. Egress comes from the origin itself (`origin_egress_bytes_total`),
which is what the stage 3 trigger names; Postgres load comes from Postgres (below).

### The monitor role

`commonair_monitor` is created by the `migrate` job from `infra/postgres/monitor-role.sql`, with
`POSTGRES_MONITOR_PASSWORD`: `LOGIN`, `CONNECTION LIMIT 5`, `default_transaction_read_only`,
`CONNECT` on the database and nothing else. It owns nothing and has no table grants. It is a member
of `pg_monitor` where the owner can grant it: on the bundled stack (a superuser applies it), not on
a managed database (the owner there may not grant `pg_monitor`; ADR 0032 §3).

Without `pg_monitor` it still reads `pg_stat_database`, `pg_stat_user_tables`,
`pg_statio_user_tables`, `pg_stat_user_indexes`, `pg_stat_bgwriter`, `pg_stat_checkpointer`,
`pg_settings` and `pg_database_size`, which is everything the alerts use. What it loses is the
replication lag columns of `pg_stat_replication` (the "Replication: WAL age" panel, marked "needs
pg_monitor"), other roles' state in `pg_stat_activity`, and WAL size. On a managed cluster the
standby is the provider's, and its lag comes from the provider's metrics endpoint.

Valkey has no separate monitor user unless you made an ACL user for it: the bundled Valkey and
DigitalOcean's managed Valkey have only the default user, so the collector uses that password. The
`redis` receiver sends `INFO` only; it never sends `CONFIG` or `CLIENT LIST`.

**No personal data.** The collector deletes client addresses, query text and user names from these
receivers' attributes (`attributes/scrub-state` and `resource/scrub-state` in `config.yaml`).
Labels name databases, tables, queues and devices, never people.

## Settings

Prometheus reads four settings from `commonair.env` (its unit receives only them). Its entrypoint,
`infra/prometheus/start.sh`, turns them into recording rules at every start; a bad value is
reported in the unit's log and ignored, never fatal. Edit `commonair.env`, then
`systemctl --user restart commonair-prometheus`.

| Key                     | Default | Meaning                                                                                                                                                                                                                     |
| ----------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SLO_TARGET`            | `0.995` | The availability target, a number between 0 and 1. 0.995 is stage 0, the self-host default; our instance sets `0.999` (ADR 0032 §1, U4). It becomes the `slo_target` label of `commonair:slo_target` and of the burn rates. |
| `EGRESS_BUDGET_GIB`     | unset   | The monthly origin egress budget in GiB, the stage 3 trigger. Unset: no egress alert and no line.                                                                                                                           |
| `LIVE_STREAMS_PER_HOST` | unset   | S1-a's per-host live stream number ([capacity.md](capacity.md#results)), the stage 2 trigger. Unset: no alert.                                                                                                              |
| `MANAGED_DB_METRICS_*`  | unset   | The optional provider scrape, below.                                                                                                                                                                                        |

## Alerts

Alerts live in `infra/prometheus/rules/commonair-alerts.yml` and use the recording rules in
`commonair-recording.yml`. Each carries a `severity` (`ticket`: look at it this week; `page`: a
human now), a `summary` and a `runbook` that points at its section below. Alert routing (mail and a
webhook) is configured in Grafana by L1-status.

ADR 0032's triggers are measured "at the daily peak, sustained for 7 days": the rules take the
highest 5-minute value of each 24 hours, then the lowest of those over 7 days, so a trigger line is
crossed only when every day of the week peaked over it. Each stage alert fires at **80% of its
trigger**, so the next stage is built before the trigger is reached.

| Alert                                                             | Severity | Fires when                                                      | Trigger (ADR 0032)                    |
| ----------------------------------------------------------------- | -------- | --------------------------------------------------------------- | ------------------------------------- |
| [CommonairStage0PostgresCpu](#commonairstage0postgrescpu)         | ticket   | Postgres load sustained peak over 40%                           | Postgres CPU over 50% (bundled)       |
| [CommonairStage0ErrorBudget](#commonairstage0errorbudget)         | ticket   | 80% of a 99.5% monthly budget spent                             | the 99.5% budget spent                |
| [CommonairStage0RestoreTime](#commonairstage0restoretime)         | ticket   | the last restore drill over 3.2 h                               | restore time over 4 h                 |
| [CommonairStage1AppCpu](#commonairstage1appcpu)                   | ticket   | app host CPU sustained peak over 48%                            | app droplet CPU over 60%              |
| [CommonairStage1UpgradeDowntime](#commonairstage1upgradedowntime) | ticket   | upgrade downtime in 30 days over 80% of half the monthly budget | upgrade downtime over half the budget |
| [CommonairStage2TranscodeCpu](#commonairstage2transcodecpu)       | ticket   | transcode CPU sustained peak over 56%                           | transcode CPU over 70%                |
| [CommonairStage2LiveStreams](#commonairstage2livestreams)         | ticket   | live streams sustained peak over 80% of `LIVE_STREAMS_PER_HOST` | streams past the per-host number      |
| [CommonairStage3Egress](#commonairstage3egress)                   | ticket   | 30-day egress over 80% of `EGRESS_BUDGET_GIB`                   | monthly egress past the budget        |
| [CommonairSloBurnFast](#commonairsloburnfast)                     | page     | burn rate over 14.4 on 1 h and 5 min                            | the availability target               |
| [CommonairSloBurnSlow](#commonairsloburnslow)                     | page     | burn rate over 6 on 6 h and 30 min                              | the availability target               |
| [CommonairPostgresConnections](#commonairpostgresconnections)     | ticket   | connections over 80% of `max_connections` for 10 min            |                                       |
| [CommonairPostgresSizeGrowth](#commonairpostgressizegrowth)       | ticket   | the database grew over 20% in a day (and is over 1 GiB)         |                                       |
| [CommonairValkeyMemory](#commonairvalkeymemory)                   | ticket   | Valkey memory over 80% of `maxmemory` for 10 min                |                                       |
| [CommonairStateScrapeFailing](#commonairstatescrapefailing)       | ticket   | the collector failed to read Postgres or Valkey for 5 min       |                                       |
| [CommonairDiskFilling](#commonairdiskfilling)                     | ticket   | the root filesystem over 80% for 30 min                         |                                       |
| [CommonairCollectorDown](#commonaircollectordown)                 | ticket   | Prometheus cannot scrape the collector for 5 min                |                                       |
| [CommonairRestoreDrillFailed](#commonairrestoredrillfailed)       | ticket   | a kind's latest restore drill in 8 days failed                  |                                       |
| [CommonairRestoreDrillOverdue](#commonairrestoredrilloverdue)     | ticket   | a kind's restore drill reported nothing for 8 days              |                                       |

### CommonairStage0PostgresCpu

Bundled state only. Postgres load is statement execution time per host core, from
`pg_stat_database.active_time` (`commonair_postgres_active_time_seconds_total`): rootless Podman
hides the Postgres container's processes from the collector, and Postgres's own counter needs no
`pg_monitor`. It counts time waiting on I/O and locks as well as CPU, so it reads high, never low:
this alert can fire early, not late. Check the Postgres dashboard for what grew, and plan stage 1
(managed Postgres, `selfhost.sh --database-url`).

### CommonairStage0ErrorBudget

More than 80% of a 99.5% monthly error budget (about 2.9 of 3.6 hours) went in the last 30 days,
whatever `SLO_TARGET` says: this is stage 0's own trigger. Look at the Availability dashboard for
when the errors came.

**This approximates the trigger.** ADR 0032 moves on when the budget is spent in two months of a
quarter; the alert watches one rolling 30-day window, so it fires on the first such month, a
warning ahead of the trigger rather than the trigger itself. Whether a second month in the quarter
followed is read off the Availability dashboard's "Stage 0 budget spent, rolling 30 days" panel
with the time range set to 90 days.

### CommonairStage0RestoreTime

The last restore drill (`commonair_restore_drill_seconds`, pushed by the drill) took more than
3.2 hours. Over 4 hours the restore no longer fits stage 0's recovery time. No data means no drill
reported in the last 8 days.

### CommonairStage1AppCpu

The host's CPU (everything but idle and I/O wait) peaked over 48% every day for a week. Stage 2
(more app hosts behind a load balancer) is due at 60%.

### CommonairStage1UpgradeDowntime

Downtime from upgrades in the last 30 days (`commonair_upgrade_downtime_seconds`, one value per
upgrade) passed 80% of half the monthly error budget at `SLO_TARGET`: about 17 minutes at 0.999.
Each upgrade must take well under 10 minutes; past half the budget, stage 2's rolling upgrades are
due.

### CommonairStage2TranscodeCpu

ffmpeg CPU, reported by the media service (`media_transcode_cpu_time_seconds_total`), peaked over
56% of the host every day for a week. Stage 3 (separate ingest and transcode hosts) is due at 70%.

### CommonairStage2LiveStreams

Concurrent live streams (`media_streams_live`) peaked over 80% of `LIVE_STREAMS_PER_HOST` every day
for a week. Set that key from S1-a's streams-axis result for your host size.

### CommonairStage3Egress

The origin served more than 80% of `EGRESS_BUDGET_GIB` over the last 30 days. Relays and P2P
(stage 4) carry viewers off the origin; check the per-source split on the App dashboard.

### CommonairSloBurnFast

Requests fail more than 14.4 times faster than the target allows, over both the last hour and the
last 5 minutes: 2% of a 30-day budget in an hour. Something is broken now. Check the App dashboard
(5xx by service) and the services' logs in Grafana.

### CommonairSloBurnSlow

The same at 6 times over 6 hours and 30 minutes: 5% of the budget in 6 hours. A slow leak, still
worth a human today.

### CommonairPostgresConnections

Backends to the `commonair` database are over 80% of `max_connections`. Managed nodes allow few
connections; lower `DATABASE_POOL_MAX` or move to a larger node. Works without `pg_monitor`.

### CommonairPostgresSizeGrowth

The database grew by more than a fifth in a day. Check the "Largest tables" panel; a burst of
imports or a runaway job is the usual cause. On a managed cluster check the node's disk in the
provider's console or the optional scrape.

### CommonairValkeyMemory

Valkey's memory is over 80% of `maxmemory`. Valkey runs `noeviction` (BullMQ needs it), so at
100% writes fail. Bundled Valkey has no `maxmemory` (0), and this alert stays quiet; watch the host's
memory instead.

### CommonairStateScrapeFailing

The collector's `postgresql` or `redis` receiver failed scrapes for 5 minutes. With external state
this is the only sign the path to the managed cluster broke (trusted sources, VPC, a rotated CA).
Look at `podman logs commonair-otel-collector`: a TLS error names the certificate problem, an
authentication error the monitor password. Without a monitor password set (an older bundled
install), this fires until `POSTGRES_MONITOR_PASSWORD` and the secrets are set.

### CommonairDiskFilling

The root filesystem, which holds Podman's storage and volumes, is over 80% full. Prometheus keeps
35 days; media work files and the Postgres data are the usual growth.

### CommonairCollectorDown

Prometheus has not scraped the collector for 5 minutes. Every other alert goes quiet with it, so
this one comes first: `systemctl --user status commonair-otel-collector`.

### CommonairRestoreDrillFailed

The latest restore drill of one kind (`kind="dump"` or `kind="walg"`) within 8 days failed:
`commonair_restore_drill_success` was 0. The newest backup is not known to restore, so treat it
as a backup outage. `selfhost.sh status` shows each drill's last run and result, and the drill's
journal says why:

```sh
journalctl --user -u commonair-drill.service -n 100 -o cat        # kind="dump"
journalctl --user -u commonair-drill-walg.service -n 100 -o cat   # kind="walg"
```

Fix the cause ([backups.md](../self-hosting/backups.md#automatic-restore-drills) lists what each
drill checks), then run the drill by hand (`selfhost.sh backup --drill`, with `--walg` for WAL-G). The
alert ends with the next success. A failure that is never retried turns into
[CommonairRestoreDrillOverdue](#commonairrestoredrilloverdue) after 8 days.

### CommonairRestoreDrillOverdue

A drill that reported within Prometheus's 35 days has reported nothing for 8 days, a week plus the
timer's randomized delay. `kind="none"`: no drill of any kind reported in 35 days, on a Prometheus
that has collected for at least 15 (so a new install is quiet until its first drill is due). The
drills run weekly from `commonair-drill.timer` (dump, Sunday) and `commonair-drill-walg.timer`
(WAL-G, Saturday, bundled Postgres only):

```sh
systemctl --user list-timers 'commonair-drill*'
systemctl --user status commonair-drill.service commonair-drill-walg.service
```

A timer that is missing or inactive was never enabled: the dump drill's timer, with the bundled
Postgres, is enabled by the first successful `selfhost.sh backup --drill`. A drill that ran but
did not reach Prometheus logged "the drill's result is not in Prometheus" (the collector was not
running) or "could not push the drill's result" in its journal. Gaps in the collector's own data
also hide the result: check [CommonairCollectorDown](#commonaircollectordown) first.

## Metrics pushed by jobs

Two triggers are measured by jobs that run now and then, not by a receiver. They push a gauge over
OTLP to `http://otel-collector:4318/v1/metrics` from inside the Podman network:

| Gauge                                | Unit    | Pushed by                          | Labels                           |
| ------------------------------------ | ------- | ---------------------------------- | -------------------------------- |
| `commonair_restore_drill_success`    | 1 or 0  | the restore drill, after a run     | `kind` (`dump` or `walg`)        |
| `commonair_restore_drill_seconds`    | seconds | the restore drill, after a success | `kind` (`dump` or `walg`)        |
| `commonair_upgrade_downtime_seconds` | seconds | `selfhost.sh upgrade`, after it    | `upgrade_id`, unique per upgrade |

The collector forgets a gauge five minutes after its last value, so the rules look back over a
window (8 days for the drill, 30 for upgrades) instead of reading the current value. The drill
alerts read the latest result within 8 days, and 35 days (the retention) to know which kinds ran
at all.

The collector's OTLP port is not published on the host; a job on the host posts through the
collector's own busybox:

```sh
now=$(date +%s)000000000
podman exec commonair-otel-collector /usr/local/bin/busybox wget -q -O - \
  --header 'Content-Type: application/json' --post-data '{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"commonair-selfhost"}}]},"scopeMetrics":[{"scope":{"name":"commonair.selfhost"},"metrics":[{"name":"commonair_restore_drill_seconds","unit":"s","gauge":{"dataPoints":[{"asDouble":1234,"timeUnixNano":"'"$now"'"}]}}]}]}]}' \
  http://127.0.0.1:4318/v1/metrics
```

## The optional managed-db-metrics scrape

A managed database's nodes (their CPU, memory, disk and replication lag) are invisible from SQL.
DigitalOcean offers a Prometheus-format endpoint for each managed PostgreSQL and Valkey cluster
(checked against its documentation on 2026-11-03): HTTPS on port 9273, path `/metrics`, HTTP basic
authentication. The host names are the cluster's `metrics_endpoints` (`GET /v2/databases/{uuid}`;
a standby adds a second one), and the credentials are account-wide (`GET
/v2/databases/metrics/credentials`, an admin or write token). The cluster's trusted sources must
include the host that scrapes. It needs no agent. It is offered for the Standard edition only;
Advanced edition clusters have no such endpoint.

It is an optional adapter, off by default: no dashboard panel or alert needs it, and the SQL-side
metrics above are the default. To turn it on:

1. Store the password as a Podman secret:
   `printf '%s' "$PASSWORD" | podman secret create commonair-managed-db-metrics-password -`.
2. Mount it into Prometheus with a drop-in,
   `~/.config/containers/systemd/commonair-prometheus.container.d/managed-db-metrics.conf`:

   ```ini
   [Container]
   Secret=commonair-managed-db-metrics-password,type=mount,target=managed-db-metrics-password,mode=0444
   # The cluster's CA (doctl databases get-ca <uuid>), if the system store does not trust it:
   Volume=%h/.config/commonair/managed-db-ca.crt:/etc/commonair/managed-db-ca.crt:ro,Z
   ```

3. Set, in `commonair.env`:

   ```sh
   MANAGED_DB_METRICS_TARGETS=<pg-metrics-host>:9273,<valkey-metrics-host>:9273
   MANAGED_DB_METRICS_USER=<basic_auth_username>
   MANAGED_DB_METRICS_CA_FILE=/etc/commonair/managed-db-ca.crt
   ```

4. `systemctl --user daemon-reload && systemctl --user restart commonair-prometheus`, then check
   the `managed-db-metrics` target in Prometheus (`/api/v1/targets`).

TLS is always verified; there is no setting to skip it. If a value is wrong, the job is left out
and the reason is in `journalctl --user -u commonair-prometheus`.
