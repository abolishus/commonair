<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# L1-observability: host, Postgres and Valkey metrics, dashboards and alert rules

You are implementing unit L1-observability for CommonAir (repo: /Users/joshe/Repos/bcon). Before
you start, read:

- AGENTS.md, PLAN.md and docs/architecture.md.
- `.claude/briefs/batch8/README.md`. Decisions U4, (k), (l) and (q), "What U4 changes", the path
  ownership and the shared rules are binding.
- `.claude/briefs/b8/contract-step.md`: §1.2 (the monitor role) and §3.7 (the env and secret names
  S1-b writes).
- ADR 0032: §1 (targets, `:83-92`), §2 (the triggers, `:94-108`) and §6 ("Measure what the
  triggers name", `:166-176`). Also ADR 0002 and ADR 0022 for every new image.
- `.claude/briefs/next/L1-public-instance.md`, launch checklist item 4.
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 1**: work in your own git worktree, on branch
`l1/observability`, cut from the contract step's sha. S1-b runs beside you and writes the env your
collector reads.

## Why

Nothing measures what ADR 0032's stage triggers name:

- the collector receives OTLP only (`infra/otel-collector/config.yaml:15-21`);
- `infra/grafana/dashboards/` holds only a README;
- `infra/prometheus/prometheus.yml` has no `rule_files`.

U4 makes it harder. Our instance launches at stage 1, so Postgres and Valkey run on DigitalOcean's
hosts, where nothing of ours can run. Their metrics must be collected **remotely**, over TLS, with
the read-only monitor role. Self-hosters on the bundled stack must get the same dashboards from
the same config.

## You own (write only these)

- `infra/otel-collector/**`, `infra/prometheus/**` (including a new `rules/` directory).
- `infra/grafana/dashboards/**` and `infra/grafana/provisioning/{dashboards,datasources}/**`. Not
  `provisioning/alerting/**`, which is L1-status's in wave 2.
- `infra/quadlet/commonair-{otel-collector,prometheus,grafana}*`.
- `docs/operators/monitoring.md` (new).
- `infra/tests/observability*` (new).
- `scripts/selfhost/e2e-metrics.ts` (new): a check function the orchestrator wires into the e2e at
  merge.

**Read-only:** `compose.yaml` and `harness/**`. Send the collector env and the volume mounts the dev
and harness stacks need as a **contract request** (an exact `compose.yaml` diff). `scripts/selfhost.sh`
is S1-b's.

## Contracts you must honor

- **The env and secret names** of contract §3.7:
  - `PG_MONITOR_*` and `VALKEY_MONITOR_*`;
  - `OBSERVABILITY_STATE_MODE`;
  - the monitor password secrets;
  - the CA secrets, mounted read-only into the collector.
    One collector config serves bundled and external installs. Metrics must work in **both** modes
    (the user, 2026-11-02, bundled is the self-host default): local receivers against the bundled
    containers, and remote ones with the monitor role against managed services. The tests cover
    both.
- **`commonair_monitor`** may lack `pg_monitor` on a managed database (contract §1.2). Every
  dashboard panel and alert must work with the reduced set, or say "needs pg_monitor" in its
  description.
- **Decision (q):** vet any new image with `bun scripts/pin-images.ts`, add it to
  `infra/image-licenses.json` by contract request, and get the orchestrator's OK. Prefer the
  collector's own `hostmetrics`, `postgresql` and `redis` receivers. They are in the contrib
  distribution the stack already pins, so they add no image. Check that the pinned image contains
  them.

## Build

1. **Receivers** (`infra/otel-collector/config.yaml`):
   - `hostmetrics` (cpu, memory, load, filesystem, network, disk). It needs the host's `/proc` and
     `/sys` mounted read-only, and its root path set. Document why each mount is there.
   - `postgresql`:
     - endpoint `${env:PG_MONITOR_ENDPOINT}`, user `${env:PG_MONITOR_USER}`, password from the
       secret file;
     - TLS from `PG_MONITOR_TLS`, with the CA file when set;
     - databases `commonair`.
   - `redis`: endpoint `${env:VALKEY_MONITOR_ENDPOINT}`, the password file, and TLS from
     `VALKEY_MONITOR_TLS`. It reads `INFO` only, which DigitalOcean allows.
   - All three feed the existing Prometheus exporter, with a `state_mode` resource attribute from
     `OBSERVABILITY_STATE_MODE`.
2. **Managed database hosts (U4).** The managed nodes' CPU, memory and disk are not visible through
   SQL.
   - DigitalOcean offers a Prometheus-format metrics endpoint for managed databases. Verify that
     against its docs, then add it as an **optional, off-by-default** scrape job,
     `managed-db-metrics`. Its target and credentials come from env, and its basic-auth password
     from a secret file. A provider endpoint is an optional adapter (rule 3). The FOSS default is
     the SQL-side metrics above, and no panel may need the adapter.
   - If the endpoint does not exist or needs a proprietary agent, drop it and say so in
     `monitoring.md`.
3. **Prometheus rules** (`infra/prometheus/rules/*.yml`, plus `rule_files` in `prometheus.yml`):
   - **Recording rules** for every ADR 0032 trigger, measured at the daily peak over 7 days
     (`:96-97`):
     - stage 0: Postgres CPU, only with bundled state; the 99.5% budget spent; the restore time.
       The restore time is a gauge that S1-h's drill pushes through OTLP. Name it
       `commonair_restore_drill_seconds` and tell S1-h.
     - stage 1: app host CPU; upgrade downtime against half the monthly budget.
     - stage 2: transcode CPU; concurrent live streams against S1-a's per-host number, from
       `docs/operators/capacity.md`.
     - stage 3: monthly egress against `EGRESS_BUDGET_GIB`. Read it as a Prometheus external
       label; it is the user's L1 number and unset by default.
   - **Alerts at 80% of each trigger**, with severity `ticket`.
   - **An SLO burn-rate rule pair** (fast: 1 h and 5 m; slow: 6 h and 30 m) on the availability
     target. The target is a label, `slo_target`, defaulting to `0.995` (stage 0, the self-host
     default). Our production config sets `0.999` (U4).
   - Burn alerts are severity `page`.
   - **Managed-state alerts:** connections over 80% of `max_connections`, database size growth,
     Valkey memory over 80% of `maxmemory`, and the collector failing to scrape the remote. That
     last one is the only sign that the VPC path to the cluster broke.
   - Every alert has `summary`, `runbook` (a `docs/operators/` anchor; L1-status writes the pages)
     and `severity` labels.
4. **Dashboards** (`infra/grafana/dashboards/*.json`, provisioned from the existing
   `provisioning/dashboards`):
   - "Stage triggers": one panel per trigger with its threshold line;
   - "Availability": the SLO, the budget left this month, and the burn rates;
   - "Host";
   - "Postgres": with notes on the panels that need `pg_monitor`;
   - "Valkey";
   - "App": origin egress, HTTP latency, chat connections, queue depth and outbox lag, from the
     existing app metrics.
     Rewrite the dashboards README. No panel loads remote content: no plugins from the internet, no
     image panels with URLs (rule 4).
5. **`docs/operators/monitoring.md`**:
   - what is collected, and from where, for bundled and external state;
   - the monitor role and what it can read;
   - each alert, what it means and its threshold;
   - how to set `slo_target` and `EGRESS_BUDGET_GIB`;
   - how to turn on the optional managed-db scrape.

## Edge cases

- The remote Postgres is unreachable at collector start. The collector must start anyway and
  report the scrape failure as a metric, not crash-loop. R0-d fixed a crash loop that held starts
  behind `After=` (`docs/self-hosting/README.md:86`), so do not bring it back.
- `pg_monitor` is absent: the panels that need it show "no data" with their description, not an
  error.
- Thresholds come from ADR 0032 exactly: 50% → alert at 40%, 60% → 48%, 70% → 56%. Test them.
- No PII in labels. The collector's scrub processor (`config.yaml:30-35`) must also cover the new
  receivers' attributes: no client addresses, no query text, no user names.

## Tests you must add

- **`infra/tests/observability.test.ts`:**
  - `promtool check rules` and `promtool check config` run in the pinned Prometheus image. If the
    test cannot run a container, run the binary the image ships.
  - Every alert's expression names only metrics that a receiver or a recording rule produces.
    Build the list from the receivers' documented metric names and the recording rules.
  - Every dashboard panel's query names a metric on that list.
  - Each threshold matches ADR 0032's trigger times 0.8.
  - Every alert has `runbook`, `summary` and `severity`.
- **`infra/tests/observability.int.test.ts`:** run the collector image against the test Postgres
  and Valkey (the `.env.example` defaults) with a monitor role created in the test, then scrape its
  Prometheus endpoint and find `postgresql_*` and `redis_*` series.
- **`scripts/selfhost/e2e-metrics.ts`:** after install, Prometheus has `system_cpu_*`,
  `postgresql_*` and `redis_*` series, in bundled mode and in S1-b's external mode.

## Reviewer focus

- Every alert and panel names a metric that exists.
- The 80%-of-trigger thresholds match ADR 0032, and the burn rules use the configured target.
- The monitor role is read-only, and its password never appears in a config file or a log.
- Remote collection uses verified TLS.
- No third-party client-side code is in the dashboards.
- The provider metrics scrape is optional and off by default.

## Done means

Follow `.claude/briefs/_done-means.md`:

- `bun --bun vp test run infra/tests/observability*`;
- `vp lint --deny-warnings` and `vp fmt` on your files;
- `reuse lint`. Dashboards are JSON, so they need a `REUSE.toml` annotation by contract request, or
  a `.license` file.

`git status` shows only your paths. Commit with `git commit -s`.

Your final message lists:

- the `compose.yaml` diff;
- any image rows;
- the restore-drill metric name for S1-h;
- what DigitalOcean's metrics endpoint turned out to be;
- the command the user runs to see the dashboards on a running stack.
