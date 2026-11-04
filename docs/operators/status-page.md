<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# The status page and the outside-in alerts

The public status page lives on the monitoring droplet, in a second region
([ADR 0025](../decisions/0025-hosting-on-digitalocean.md) decision 3), at `status.<domain>`. The
same droplet probes the instance from outside and mails a human when a component goes down, so an
outage still pages when the app droplet, its Grafana and its mail are all gone. Everything is
in-house (decision (k) of batch 8): `blackbox_exporter`, a small Prometheus, Caddy, and one Bun
script with no dependencies, `infra/status/render.ts`. No third-party status or paging service is
involved, and the page loads nothing from anywhere.

Inside alerts, the ones Grafana sends from the app droplet's own metrics, are in
[on-call.md](on-call.md#what-pages).

## How it works

| Piece                                   | Where (on the droplet)                                                       | What it does                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `commonair-status-blackbox.container`   | `/etc/containers/systemd/`                                                   | runs each probe when Prometheus scrapes it (`blackbox.yml`)                                                   |
| `commonair-status-prometheus.container` | `/etc/containers/systemd/`, data in the `commonair-status-prometheus` volume | scrapes every probe every 30 s, keeps 30 days, records `commonair_status:probe_success:sighted` (`rules.yml`) |
| `commonair-status-render.timer`         | `/etc/systemd/system/`                                                       | starts `commonair-status-render.service` every minute                                                         |
| `commonair-status-render.container`     | `/etc/containers/systemd/`, runs `/etc/commonair-status/render.ts`           | judges the probes, sends alerts, writes the page                                                              |
| `commonair-status-caddy.container`      | `/etc/containers/systemd/`                                                   | serves `/var/lib/commonair-status/site` on `status.<domain>` with an ACME certificate                         |

Each minute the renderer:

1. writes the probe targets from `/etc/commonair-status/status.json` to
   `/var/lib/commonair-status/targets/status.json` (Prometheus reads them, so `status.json` is the
   one list of components);
2. reads the last probes from Prometheus. A component changes state only when **two consecutive
   probes agree** (30 to 60 s). A probe older than 90 s is "no data";
3. mails and optionally POSTs a webhook on a change (see [The alert route](#the-alert-route));
4. keeps each day's availability in `/var/lib/commonair-status/state/state.json`, so the page shows
   90 days while Prometheus keeps 30;
5. writes `index.html` and `status.json` to `/var/lib/commonair-status/site`, with the notes in
   `/var/lib/commonair-status/notes/` and the maintenance file.

Every time it uses is Prometheus's: its `time()`, the sample timestamps, and the UTC day boundaries
derived from them. The droplets' clocks can drift apart without moving a state or a day.

The page is static HTML with an inline stylesheet: no script, no font, no image, no external URL.
It reads the same without CSS, follows `prefers-color-scheme` for dark and light, fits 320 px, and
refreshes itself every minute with a `<meta>` refresh. Caddy's CSP is `default-src 'none'` plus
inline styles. The page and the mails carry component names, states and times only, never personal
data; the notes are written by operators and must not name people either.

## What is probed

From the monitoring droplet, over IPv4, every 30 s (`blackbox.yml` has the modules):

| Component            | Target                                | Module           | Down means                                                        |
| -------------------- | ------------------------------------- | ---------------- | ----------------------------------------------------------------- |
| Website              | `https://<host>/`                     | `http_web`       | no 2xx over TLS                                                   |
| API and database     | `https://<host>/readyz/api`           | `http_ready`     | the API's readiness failed: Postgres, Valkey or its subscribers   |
| Chat                 | `wss://<host>/chat`                   | `websocket_chat` | the WebSocket upgrade failed                                      |
| Video playback       | `https://<host>/readyz/origin`        | `http_ready`     | the origin's readiness failed: Postgres, Valkey or its HLS source |
| Stream ingest (RTMP) | `<host>:1935`                         | `tcp_connect`    | no TCP connection                                                 |
| TLS certificate      | the website probe's certificate chain | (none)           | expired; **degraded** within 14 days of expiry                    |

**Video is the origin's readiness, not a live playlist.** No channel is guaranteed to be live, and
a synthetic always-on test channel would need an ingest client running somewhere, which is one
more thing to fail. The origin's `/readyz` checks what serving HLS needs (Postgres, Valkey and
MediaMTX's HLS listener), so it catches the outages a playlist probe would, except a broken
transcode of one stream, which the stream health dashboards cover.

`/readyz/api` and `/readyz/origin` are Caddy routes on the app droplet that pass to each service's
`/readyz`. That answer is pass or fail per check only; it never carries error text
(`packages/service/src/server.ts`).

## The alert route

The route is in `/etc/commonair-status/alert.env` on the monitoring droplet. It is the only secret
there, and it never passes through tofu, cloud-init or droplet metadata (user data is readable
from inside a droplet and sits in tofu state). Place or replace it from your machine:

```sh
# alert.env, never committed:
#   SMTP_HOST=smtp.resend.com
#   SMTP_PORT=2587            # STARTTLS; 2465 with SMTP_SECURE=true is implicit TLS
#   SMTP_USER=resend
#   SMTP_PASSWORD=<a Resend API key for this droplet only>
#   MAIL_FROM=CommonAir status <status@<domain>>
#   ALERT_EMAIL_TO=<the on-call address; several, comma-separated>
#   ALERT_WEBHOOK_URL=<optional: any endpoint that takes a JSON POST>
infra/status/place-secret.sh root@<monitoring droplet IPv4> < alert.env
```

The script refuses unknown keys, installs the file as mode 0400 owned by the renderer's uid
(65534), runs the renderer once, and prints its route line. Give the droplet **its own** relay key,
so revoking the app's key never silences the outside alerts. The relay is the instance's (Resend
on 2587, as on staging, decision (l)); any SMTP relay works. A password is only ever sent after
STARTTLS or over implicit TLS, and the relay's certificate is verified.

What is sent:

- a **problem** mail when a component is confirmed down or degraded;
- at most one problem mail per component per 10 minutes, so a flapping component sends one mail
  per window, not one per flap;
- **always the recovery** mail once a component that was mailed is operational again;
- "Status probes are not reporting" when no probe has a fresh result for 5 minutes (blackbox or
  Prometheus on the droplet is broken);
- nothing during [maintenance](#planned-maintenance) or while
  [the monitor is blind](#when-the-monitor-is-blind).

A mail that cannot be delivered (on any channel) is retried at the next run. The webhook body is
JSON: `site`, `component`, `name`, `kind` (`problem` or `recovery`), `state`, `from`, `since`,
`at`, `page` and `subject`.

**No route, no page.** With `alert.env` missing, or with a placeholder in it (an `example.*` or
`.invalid` address, `changeme`, `__generate__`), the renderer logs
`NO ALERT ROUTE: outages will not reach anyone` at every run:

```sh
ssh root@<monitoring> journalctl -u commonair-status-render -n 50 -o cat | grep -i route
```

## When the monitor is blind

If the monitoring droplet loses its own network, every probe fails at once. That is not an
outage of the instance, so the droplet also probes two well-known targets, Quad9's and
Cloudflare's anycast DNS over TCP (`9.9.9.9:53` and `1.1.1.1:53`, the tofu variable
`status_canaries`). When **every** component and **every** canary fail together, the renderer:

- sends no mail (it could not anyway), and keeps each component's last known state;
- shows a banner, "The status monitor lost its own network at …";
- does not count that time in the daily availability: `commonair_status:probe_success:sighted`
  keeps a probe result only while at least one canary answers (`infra/status/rules.yml`).

One canary answering means the network works, so components that fail then are really down.

## Planned maintenance

```sh
ssh root@<monitoring> 'echo "Upgrading to v0.1.1, back within 10 minutes." > /var/lib/commonair-status/maintenance'
# … the upgrade …
ssh root@<monitoring> rm /var/lib/commonair-status/maintenance
```

While the file exists the page says "Planned maintenance in progress" with its text (keep it short
and impersonal), components that are not up show "Maintenance", and no outside alert is sent. When
the file goes, anything still down is mailed at the next run, and anything mailed before is
followed by its recovery. **Maintenance still counts against the budget** (ADR 0032 §1): the daily
figures include it, and the 99.9% target leaves about 43 minutes a month.

## Posting a note

Notes are markdown files in `/var/lib/commonair-status/notes/`, one per incident, written as root:

```markdown
---
title: Chat messages delayed
date: 2026-11-03T13:50:00Z
status: investigating
components: chat
---

Chat messages are arriving late. We are looking into it.

## 14:10 UTC

The cause is identified; a fix is deploying.
```

- `date` is ISO 8601 with an offset; `status` is `investigating`, `identified`, `monitoring`,
  `resolved` or `maintenance`; `components` is a comma-separated list of ids (`web`, `api`,
  `chat`, `video`, `ingest`, `certificate`, or an extra one).
- Any status but `resolved` puts the note under "Current incidents" at the top. Resolved notes from
  the last 90 days are under "Past incidents".
- Markdown: paragraphs, `##` headings, `-` lists, `**bold**`, `*italics*` and `` `code` ``. A link
  keeps its text only: the page never points elsewhere. HTML is escaped.
- The next run (within a minute) shows it. A file it cannot read is skipped, and the journal says
  why. [incidents.md](incidents.md#the-status-page-note) says when to post and what to write.

Notes live on the droplet only. Keep a copy with the incident's write-up: re-provisioning loses them.

## Adding a component

Add it to the tofu variable `status_extra_components` (an id, a name, one of the modules
`http_web`, `http_ready`, `websocket_chat`, `tcp_connect`, and a target), then
[re-provision](#re-provisioning). A new kind of check needs a new module in `blackbox.yml`, its
name in `PROBE_MODULES` in `render.ts`, and the variable's validation in
`infra/tofu/digitalocean/modules/instance/variables.tf`. A default component for every instance
goes in `defaultComponents()` in `render.ts`.

## Bringing it up

The tofu module creates the droplet with this stack when `enable_monitoring_droplet` (default on),
`monitoring_cloud_init` (default on) and `instance_origin` are set; without `instance_origin` it
gets package updates only. Then:

1. Point `status.<domain>` (or `status_domain`) at the `monitoring_dns_records` output, A and AAAA.
   Caddy gets its certificate once DNS resolves.
2. Place the route: [The alert route](#the-alert-route).
3. Check: `https://status.<domain>/` shows every component operational within two minutes.

## Re-provisioning

The droplet's user data is read once, at creation, and tofu ignores later changes to it
(`ignore_changes = [user_data]`). So a change to anything in `infra/status/`, or to a status
variable, reaches the droplet only by replacing it:

```sh
tofu -chdir=infra/tofu/digitalocean/envs/production apply -replace='module.instance.digitalocean_droplet.monitoring[0]'
```

That is cheap: the droplet holds no state but 30 days of probe history and the page's daily figures
(lost, so the page starts again with "no data" days), the notes, and `alert.env` (place it again).
The DNS records follow the new addresses from `monitoring_dns_records`.

## Seeing an alert land

To fake an outage without touching the instance, block the probes from the monitoring droplet to
the app droplet's address, then lift the block:

```sh
ssh root@<monitoring>
nft add table inet commonair_drill
# The probes run in containers, so their packets are forwarded, not sent by the host.
nft add chain inet commonair_drill fwd '{ type filter hook forward priority -10; }'
nft add rule inet commonair_drill fwd ip daddr <app reserved IPv4> drop
# within about two minutes: problem mails for website, API, chat, video and ingest
nft delete table inet commonair_drill
# within about two minutes: one recovery mail per component
```

To see the blind banner instead, drop the canaries as well
(`nft add rule inet commonair_drill fwd ip daddr { 9.9.9.9, 1.1.1.1 } drop`): no mail is sent, and
the page says the monitor lost its network. A real drill of the whole path, with
the app droplet down, is the agent track's (U5): power the staging app droplet off with
`doctl compute droplet-action power-off <id>` and power it on again after the mails land.
