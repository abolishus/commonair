<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# On-call

**This is a template.** The mechanics below are built and tested; the people, the rota and the
contact details are the instance's to fill in (the L1 launch checklist, item 4). Keep names and
numbers out of this repository: put them in the instance's private runbook and point to it from
[Rota](#rota).

Our target is **99.9% a month from launch** ([ADR 0032](../decisions/0032-scaling-and-availability.md)
§1, batch 8 U4): about **43 minutes** of downtime a month, planned upgrades included. One outage of
45 minutes spends the month. So whatever pages must reach a human within minutes, and must not
depend on the host that failed.

## What pages

Two independent paths reach the on-call person. Each sends mail through an SMTP relay and,
optionally, a JSON webhook (no proprietary paging service is needed; a webhook can feed one).

| Path                                                              | Runs on                               | Pages when                                                                                                                                                                                                | Survives the app droplet going down |
| ----------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **Outside-in** ([status-page.md](status-page.md#the-alert-route)) | the monitoring droplet, second region | a component (website, API and database, chat, video, ingest) is down for two probes; the certificate is expiring or expired; the probes stop                                                              | yes                                 |
| **Inside** (Grafana)                                              | the app droplet                       | a `page` alert from `infra/prometheus/rules` fires: the error-budget burn rates [CommonairSloBurnFast](monitoring.md#commonairsloburnfast) and [CommonairSloBurnSlow](monitoring.md#commonairsloburnslow) | no                                  |

`ticket` alerts (the stage triggers, connections, memory, disk, scrape failures) do not page: they
arrive as one daily digest mail, for the working week. Each alert's `runbook` link points at its
section of [monitoring.md](monitoring.md#alerts).

## The alert route

**Outside-in:** `alert.env` on the monitoring droplet, placed over SSH
([status-page.md](status-page.md#the-alert-route)).

**Inside:** Grafana's contact point `commonair-oncall` (`infra/grafana/provisioning/alerting/`)
has an email and a webhook integration, from the instance's settings:

| Setting               | Meaning                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ALERT_EMAIL_TO`      | the on-call address(es), comma-separated. Unset or a placeholder: no mail route                                 |
| `ALERT_WEBHOOK_URL`   | optional: a URL that takes Grafana's webhook JSON                                                               |
| `SMTP_*`, `MAIL_FROM` | the instance's relay, which Grafana uses unless `GF_SMTP_*` are set; with `SMTP_USER` set, STARTTLS is required |

`route-env.sh` runs before Grafana starts (the unit's entrypoint sources it). It renders
`commonair.yaml.tmpl` with these settings into a copy of the provisioning and points Grafana at it;
the webhook integration exists only when `ALERT_WEBHOOK_URL` is set. With no usable route it
prints a banner, `commonair grafana: NO ALERT ROUTE`, in Grafana's log at every start, and Grafana
still starts, so the dashboards keep working. A Grafana started without `route-env.sh` has no
alerting provisioned at all. Check with:

```sh
journalctl --user -u commonair-grafana -b | grep -i "alert route"
```

The notification policy: `page` alerts go out after 10 s, grouped per alert and repeated hourly
while firing; `ticket` alerts wait an hour, then go in one group at most once a day; Grafana's own
alerts (a datasource error) go after 30 s. Grafana sends a resolved message for each.

**Test both paths before launch, and after any change to them:**

- outside-in: [status-page.md](status-page.md#seeing-an-alert-land);
- inside: Grafana, Alerting, Contact points, `commonair-oncall`, Test.

## Response targets

Against a 43-minute monthly budget:

| Severity                | Acknowledge      | Working on it | Status page note                                   |
| ----------------------- | ---------------- | ------------- | -------------------------------------------------- |
| Outside-in problem mail | 5 min            | 10 min        | within 15 min if not resolved                      |
| `page` (burn rate)      | 15 min           | 30 min        | when users notice, or the fast burn rate is firing |
| `ticket` (daily digest) | next working day | this week     | no                                                 |

"Acknowledge" means replying on the team channel that you have it, so nobody duplicates work. If
you cannot meet a target, escalate at once rather than at the deadline.

## Escalation

1. The primary on-call person ([Rota](#rota)) acknowledges and works the incident
   ([incidents.md](incidents.md#declaring-an-incident)).
2. No acknowledgement within the target: the secondary is contacted directly.
3. Neither within 15 minutes, or the incident needs a decision (restore from backup, fail over,
   take the instance read-only, talk to the provider): a maintainer with infrastructure access.
4. DigitalOcean's side (a managed cluster, the region, Spaces): open a support ticket from the
   account and note its number in the incident; their status page is the source for their
   incidents.

Security incidents follow `SECURITY.md`; moderation emergencies (CSAM, credible threats) follow
[trust-safety.md](trust-safety.md), and are never handled on this rota alone.

## Rota

Fill in, in the instance's private runbook:

- the primary and secondary each week, and the hand-over time (UTC);
- how each is reached (the address in `ALERT_EMAIL_TO`, and the webhook's destination);
- who holds SSH access to the app and monitoring droplets, the DigitalOcean account, the
  tofu state passphrase, and the relay accounts;
- the maintainers for step 3.

Review the rota monthly, and after every incident that paged.
