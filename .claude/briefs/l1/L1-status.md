<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# L1-status: the public status page, alert routing and the runbooks

You are implementing unit L1-status for CommonAir (repo: /Users/joshe/Repos/bcon). Before you
start, read:

- AGENTS.md, PLAN.md and docs/architecture.md.
- `.claude/briefs/batch8/README.md`. Decisions U4, U5, (k), (l) and (q), "What U4 changes", the
  path ownership and the shared rules are binding.
- `.claude/briefs/l1/L1-observability.md` and what it merged: the rules in
  `infra/prometheus/rules/`, the dashboards, and `docs/operators/monitoring.md`.
- ADR 0025 decision 3 (a monitoring droplet in a second region) and ADR 0032 §1 (99.9% from launch
  under U4).
- `.claude/briefs/next/L1-public-instance.md`, launch checklist item 4, as U4 changed it.
- `infra/tofu/digitalocean/modules/instance/monitoring.tf` and `infra/tofu/README.md`.
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 2**: work in your own git worktree, on branch
`l1/status`, cut from `main` after wave 1 merged.

## Why

The launch checklist asks for an alert route to a human and a public status page on the monitoring
droplet in a second region. Neither exists (`L1-public-instance.md`, item 4). The tofu module
already creates the monitoring droplet (`monitoring.tf:7-30`), but its `user_data` only applies
updates.

Under U4 our target is 99.9% from launch, about 43 minutes a month. So an outage must reach a
human within minutes, and that path must not depend on the host that failed.

## You own (write only these)

- `infra/status/**` (new):
  - the probe config;
  - the renderer;
  - the status page's static assets;
  - the monitoring droplet's Prometheus and Caddy config;
  - the cloud-init template.
- In `infra/tofu/**`: `modules/instance/monitoring.tf`, a new `modules/instance/monitoring-cloud-init*`,
  and the monitoring variables in `modules/instance/variables.tf`. **Only the lines under its
  monitoring heading** (`:150-173` on `4e92eefe`).
- `infra/grafana/provisioning/alerting/**` (new).
- `docs/operators/{incidents,on-call,status-page}.md` (new).
- `infra/tests/status*` (new).
- Tests named after these files.

**Read-only:** the rest of `infra/grafana/**`, `infra/prometheus/**` and `infra/otel-collector/**`
(L1-observability's, merged), `infra/tofu/digitalocean/envs/**`, `.github/**` and
`infra/image-licenses.json`. Anything else is a **contract request**: image rows, the tofu provider
or envs, and CI.

## Contracts you must honor

- **Decision (k):** in-house, with no new dependency except `blackbox_exporter` (Apache-2.0, vetted
  per ADR 0022). Pin it with `bun scripts/pin-images.ts`, and send its `infra/image-licenses.json`
  row as a contract request. Prometheus and Caddy reuse the images the stack already pins.
- **Decision (l):** alerts go by email through the instance's SMTP relay (Resend on 2587, as on
  staging), plus an optional generic webhook. No proprietary paging service is required.
- **Decision (q):** no other image. If the outside-in alert path below needs one (for example
  Alertmanager), do not add it. Send it as a proposal with `vet` and `pin-images` output instead.

## Build

1. **Probes from the second region.**
   - The monitoring droplet runs `blackbox_exporter` and a small Prometheus. It probes from outside:
     - HTTPS on the web origin;
     - the API health route (it checks Postgres and Valkey behind it, so a managed-cluster outage
       shows here);
     - the chat WebSocket upgrade;
     - an HLS playlist of a synthetic always-on test channel, or the origin health route if no
       channel is live. Document which.
     - TCP on RTMP 1935;
     - TLS certificate expiry.
   - Interval 30 s. Retention 30 days, enough for the monthly availability figure.
2. **The outside-in alert path.** If the app droplet is down, its Grafana cannot alert, so the
   monitoring droplet alerts on its own probes.
   - Keep it dependency-free: the renderer (below) keeps the last state per component and, on a
     change that lasts 2 probe intervals, sends one email through the SMTP relay and an optional
     webhook POST.
   - The mail is sent from the monitoring droplet with its own relay credentials (a secret in
     cloud-init, never in tofu state in plain text). Document how the secret is placed.
   - Debounce flapping: at most one mail per component per 10 minutes, and always the recovery mail.
3. **Inside alerts** (`infra/grafana/provisioning/alerting/**`):
   - Grafana contact points: SMTP through the instance relay, and the optional webhook.
   - One notification policy: `page` alerts go now, and `ticket` alerts go in a daily digest group.
   - One Grafana-managed rule that fires on the Prometheus alert series
     `ALERTS{alertstate="firing"}` and carries `severity`, `summary` and `runbook` through. This
     routes L1-observability's Prometheus rules with no Alertmanager image. If you find the pinned
     Grafana can receive Prometheus alerts directly, compare the two in your final message.
   - The recipients come from env. A placeholder means no route, and that is logged loudly at
     start. The human on the route is the user's L1 item.
4. **The status page.**
   - A script in `infra/status/render.ts`, Bun, no dependencies, run every minute by a systemd timer
     on the monitoring droplet. It reads the monitoring Prometheus's HTTP API and writes static
     HTML and JSON: components with their state, the last 90 days' daily availability per
     component, and incident notes from a directory of markdown files the operator writes.
   - Caddy serves the page on `status.<domain>`, with ACME.
   - The page has no JavaScript, or only inline script that is bundled and self-hosted. No external
     fonts or scripts (rule 4). It works with no CSS, has dark and light themes through
     `prefers-color-scheme`, and fits 320 px.
   - Names and the domain come from the instance's config, not literals (`check-domains`).
5. **Cloud-init** (`monitoring-cloud-init.yaml.tftpl`, used by `monitoring.tf` when
   `var.cloud_init_updates` is on, or a new `var.monitoring_cloud_init` defaulting to true):
   - install Podman;
   - write the Quadlet units for blackbox, Prometheus and Caddy, and the renderer timer;
   - set up the secrets;
   - start everything.
     Keep `ignore_changes = [user_data]` (`:21`). Document that a config change means re-provisioning
     the droplet, which is cheap because it holds no state but probe history.
6. **Runbooks:**
   - `incidents.md`: declaring, the status page note, comms, and the post-incident write-up
     template;
   - `on-call.md`: what pages, response targets against 99.9%, and escalation. It is a template,
     because the people are the user's;
   - `status-page.md`: how it works, how to add a component, and how to post a note.
     Every `runbook` label in L1-observability's rules must resolve to an anchor in these or in
     `monitoring.md`. Test that.

## Edge cases

- **The monitoring droplet loses its own network:** every probe fails at once. Treat "all
  components down plus the probe of a known-good external target down" as "monitoring is blind",
  and do not page "everything down". Pick a well-known target and document it, or skip this and
  say why.
- **A planned upgrade:** a maintenance file on the monitoring droplet suppresses the outside
  alerts, and the page says "maintenance". It still counts against the budget (ADR 0032 §1).
- **Clock skew** between droplets: the renderer uses Prometheus's timestamps only.
- **No personal data** anywhere on the page or in alert mails.

## Tests you must add

- **`infra/tests/status.test.ts`:**
  - the renderer against recorded Prometheus API answers: each state, the 90-day figure, notes,
    and maintenance;
  - the debounce and recovery mail logic, with fake time and an injected sender;
  - the page has no external URL (scan the output);
  - the HTML is valid and has `lang`;
  - every `runbook` label resolves;
  - `promtool check config` on the monitoring Prometheus;
  - the alerting provisioning parses.
- **`bash infra/tofu/check.sh`** passes, including `tofu validate` and the module tests with the new
  cloud-init.

## Reviewer focus

- The probes run from the second region, and the down-alert path does not depend on the app droplet.
- The page is static, self-hosted, and loads nothing third-party.
- No proprietary paging is required, and only `blackbox_exporter` is added.
- No secret is in tofu state or in a log.
- Every `runbook` resolves.

## Done means

Follow `.claude/briefs/_done-means.md`:

- `bun --bun vp test run infra/tests/status*`;
- `bash infra/tofu/check.sh`;
- `vp lint --deny-warnings` and `vp fmt`;
- `reuse lint`.

`git status` shows only your paths. Commit with `git commit -s`.

Your final message gives the image row, the exact `tofu apply` and secret steps for the agent
track to bring the monitoring droplet up on the staging project (U5), and how to fake an outage to
see a mail land.
