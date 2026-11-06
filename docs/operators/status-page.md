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
   `/var/lib/commonair-status/notes/` and the maintenance file, and `metrics.txt`: `status.json`'s
   `updatedAt` and `stale` in Prometheus's text format, which the app side reads (see
   [When the renderer or the droplet stops](#when-the-renderer-or-the-droplet-stops)).

Every time it uses is Prometheus's: its `time()`, the sample timestamps, and the UTC day boundaries
derived from them. The droplets' clocks can drift apart without moving a state or a day. The one
exception is a run that cannot read Prometheus at all; see
[When Prometheus itself fails](#when-prometheus-itself-fails).

The page is written before any alert is sent, and delivery has a budget: each SMTP connection
gives up after 10 s of connecting or 20 s of silence, mail and webhook go out in parallel, and a
run stops waiting after 60 s in all (the unit's limit is 120 s). The state is saved before
delivery and again as each alert lands, so a hung relay never freezes the page and never causes
a mail that was already accepted to be sent again.

The page is static HTML with an inline stylesheet: no script, no font, no image, no external URL.
It reads the same without CSS, follows `prefers-color-scheme` for dark and light, fits 320 px, and
refreshes itself every minute with a `<meta>` refresh. Caddy's CSP is `default-src 'none'` plus
inline styles. The page and the mails carry component names, states and times only, never personal
data; the notes are written by operators and must not name people either.

## What is probed

From the monitoring droplet, over IPv4, every 30 s (`blackbox.yml` has the modules):

| Component            | Target                         | Module           | Down means                                                        |
| -------------------- | ------------------------------ | ---------------- | ----------------------------------------------------------------- |
| Website              | `https://<host>/`              | `http_web`       | no 2xx over TLS                                                   |
| API and database     | `https://<host>/readyz/api`    | `http_ready`     | the API's readiness failed: Postgres, Valkey or its subscribers   |
| Chat                 | `wss://<host>/chat`            | `websocket_chat` | the WebSocket upgrade failed                                      |
| Video playback       | `https://<host>/readyz/origin` | `http_ready`     | the origin's readiness failed: Postgres, Valkey or its HLS source |
| Stream ingest (RTMP) | `<host>:1935`                  | `tcp_connect`    | no TCP connection                                                 |
| TLS certificate      | `https://<host>/`, unverified  | `http_cert`      | expired; **degraded** within 14 days of expiry                    |

The certificate has its own probe. `http_web` verifies the certificate, and a failed verification
reports no expiry at all, so the certificate's probe skips verification and only reads the expiry.
An expired certificate therefore shows twice: the website as down (verification fails), and the
certificate as down (expired).

**Video is the origin's readiness, not a live playlist.** No channel is guaranteed to be live, and
a synthetic always-on test channel would need an ingest client running somewhere, which is one
more thing to fail. The origin's `/readyz` checks what serving HLS needs (Postgres, Valkey and
MediaMTX's HLS listener), so it catches the outages a playlist probe would, except a broken
transcode of one stream, which the stream health dashboards cover.

`/readyz/api` and `/readyz/origin` are Caddy routes on the app droplet that pass to each service's
`/readyz/public`, which relays the service's own `/readyz`. That answer is pass or fail per check
only; it never carries error text (`packages/service/src/server.ts`). The routes are public, so
each service allows 60 requests a minute per client address (the API's limiter on Valkey, the
origin's in process) and answers `429` past that. The probes stay far below it (one per component
every `probeIntervalSeconds`, at least 5 s apart), so they are never limited; a `429` would count
as a failed sample. The services' bare `/readyz`, which compose and the API's own status probes
use, is not reachable through Caddy and is not limited.

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
- "Status probes are not reporting" when no probe has a fresh result for 5 minutes (blackbox is
  broken), or when the renderer cannot read Prometheus for 5 minutes
  ([When Prometheus itself fails](#when-prometheus-itself-fails));
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

## When Prometheus itself fails

If Prometheus on the monitoring droplet stops answering (it is crash-looping, its disk is full, or
its config is bad), the renderer cannot judge anything. Each failed run then:

- keeps the last page, with a banner at the top: "This page has not been updated since …". It
  also sets `"stale": true` in `status.json`;
- counts the failure as the probes not reporting. After 5 minutes of failed runs it mails
  "Status probes are not reporting" through the same route (once, as for any component). The
  first good run sends the recovery and removes the banner.

These runs cannot ask Prometheus the time, so they use the droplet's own clock. That is the same
clock Prometheus on this droplet would have answered with, so nothing is lost. Check with:

```sh
ssh root@<monitoring> systemctl status commonair-status-prometheus
ssh root@<monitoring> journalctl -u commonair-status-render -n 20 -o cat
```

A dead monitoring droplet sends nothing at all; see the next section.

## When the renderer or the droplet stops

A renderer that never runs (its timer stopped, the unit fails before it can mark the page), or a
droplet that is gone, cannot mail about itself. The app droplet's Prometheus watches for it from
the other side: with `STATUS_PAGE_URL=https://status.<domain>` in the instance's
`commonair.env` (production: `tofu output observability_env`), it reads
`https://status.<domain>/metrics.txt` every minute and raises
[CommonairStatusPageStale](monitoring.md#commonairstatuspagestale) through the inside route when
the page is more than 5 minutes old, or cannot be read, for 10 minutes. The file carries two
numbers, the time of the last good run and the stale flag, and nothing else. Without the setting,
the on-call checks the page as part of the [rota](on-call.md#rota).

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

Notes live on the droplet, on its state volume (see [Re-provisioning](#re-provisioning)), which
outlives the droplet but is not a backup. Keep a copy with the incident's write-up.

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

1. Point `status.<domain>` (or `status_domain`) at the `monitoring_dns_records` output: the A
   record, and the AAAA record once the IPv6 check in step 3 passes. Caddy gets its certificate
   once DNS resolves.
2. Place the route: [The alert route](#the-alert-route).
3. Check: `https://status.<domain>/` shows every component operational within two minutes. Then
   check IPv6 from a host that has it: `curl -6 -sI https://status.<domain>/`. The status network
   has IPv6 turned on (`commonair-status.network`), so Caddy's ports answer on the droplet's IPv6
   address. If that check fails, delete the AAAA record: IPv6-only visitors would get no answer,
   and ACME validation over IPv6 would fail.

Set `status_site_name` to the instance's `INSTANCE_NAME`. Without it the page and the mails show
the instance's host name, because the tofu module cannot read the name from
`packages/config`. `status_locale` (`en` or `es`) sets the page's language. Alert mails stay in
English.

## Re-provisioning

The droplet's user data is read once, at creation, and tofu ignores later changes to it
(`ignore_changes = [user_data]`). So a change to anything in `infra/status/`, or to a status
variable, reaches the droplet only by replacing it:

```sh
tofu -chdir=infra/tofu/digitalocean/envs/production apply -replace='module.instance.digitalocean_droplet.monitoring[0]'
```

**The page's state outlives the droplet.** `/var/lib/commonair-status` (the 90-day availability
history in `state/state.json`, the notes, the maintenance file and the last page) is a 1 GiB block
storage volume of its own, `<prefix>-status-state` in `monitoring_region`
(`monitoring_state_volume`, default on, about 0.10 USD a month). Tofu attaches it to the
replacement at creation and cloud-init mounts it before anything is written, so the new droplet's
first run picks up where the old one stopped: no mail is resent, and the days the old droplet
recorded keep their figures. The volume is created with the monitoring droplet and formatted
once; `tofu destroy` deletes it.

Replacing the droplet still loses:

- 30 days of raw probe history (the monitoring Prometheus's own volume). The daily figures already
  in `state.json` stay; a day that ended while no droplet ran shows "no data";
- `alert.env` (place it again: [The alert route](#the-alert-route));
- with `monitoring_state_volume = false`, or on a monitoring host you run yourself, everything
  under `/var/lib/commonair-status` too. Copy it off first and back after the first boot:

```sh
ssh root@<old monitoring> tar -C /var/lib/commonair-status -czf - state notes > status-state.tgz
ssh root@<new monitoring> 'systemctl stop commonair-status-render.timer && tar -C /var/lib/commonair-status -xzf - && chown -R 65534:65534 /var/lib/commonair-status/state && systemctl start commonair-status-render.timer' < status-state.tgz
```

Check the mount after a replacement: `ssh root@<monitoring> findmnt /var/lib/commonair-status`
shows the volume's device. With `nofail`, a volume that did not attach leaves the directory on
the root disk, and the page starts again from "no data".

**The replacement gets new IP addresses.** Update the A and AAAA records by hand to the new
`monitoring_dns_records` output. The status page is unreachable until they resolve.

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
