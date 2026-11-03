<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Grafana dashboards

Provisioned read-only into the "CommonAir" folder by
`../provisioning/dashboards/dashboards.yaml`; subfolders would become Grafana folders. Every panel
queries the provisioned Prometheus data source (uid `prometheus`) and nothing else: no plugins, no
image or text panels that load remote content.

| File                  | Dashboard      | What it shows                                                                                                                              |
| --------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `stage-triggers.json` | Stage triggers | One panel per ADR 0032 trigger, with the alert line (80%) and the trigger line                                                             |
| `availability.json`   | Availability   | The availability over 30 days, the target (`SLO_TARGET`), the error budget left, the burn rates, and the stage 0 budget spent over 30 days |
| `host.json`           | Host           | CPU, memory, load, the root filesystem and disk I/O, from the host's `/proc`                                                               |
| `postgres.json`       | Postgres       | Connections, size, statement time, transactions, rows, tables; replication needs `pg_monitor`                                              |
| `valkey.json`         | Valkey         | Memory against `maxmemory`, clients, commands, hits and misses, evictions                                                                  |
| `app.json`            | App            | Origin egress, HTTP latency and errors, chat connections, job queues, outbox lag, failed jobs                                              |

The panels read the recording rules in `infra/prometheus/rules/` where a trigger or the target is
involved, so the dashboards and the alerts agree. `infra/tests/observability.test.ts` checks that
every query names a metric some receiver, service or rule produces. What each metric is, and the
operator's settings behind the lines, are in
[docs/operators/monitoring.md](../../../docs/operators/monitoring.md).

Edit a dashboard in Grafana, export its JSON ("Export" → "Export as JSON", without "external
sharing"), and replace the file here: the provisioned copies are read-only in the UI.
