<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0025: Staging and production on DigitalOcean (supersedes ADR 0010)

- Status: proposed (2026-10-26)
- Date: 2026-10-26 (provider facts checked on 2026-10-24)

## Context

[ADR 0010](0010-production-hosting.md) put production on a Hetzner dedicated server and left
staging on Railway. Since then three things changed.

1. **ADR 0023 made one install path real.** A signed release installs with `selfhost.sh` on any
   Debian 13 or Fedora 42+ host: Quadlet units, Caddy with ACME, WAL-G, Garage. v0.1.0-rc.1 was
   installed that way on a DigitalOcean droplet (PROGRESS, session thirteen): ACME TLS, real client
   addresses over IPv4 and IPv6, a killed worker back in 16 s, avatar and export through the
   browser. The same path can now serve staging and production.
2. **Railway cannot run that path.** It has no public UDP, no WAL-G, root-owned volumes and its
   own IaC (ADR 0010's own list). Staging there tests a different deployment from the one we
   ship, and its deploys have drifted from `main` before (redeploys that reused old images).
3. **ADR 0010's reason was cost, and its numbers are out of date.** Hetzner repriced twice in 2026. New dedicated orders since 15 June 2026 are tiered (`AX42-1` €97.30/month; the EX44 that
   ADR 0010 cited is now `EX44-1-LTD`, €57.30, while supply lasts), and cloud prices rose 2–3×.
   Dedicated servers are still only in Germany and Finland, ordered by hand, with a limited API.

The maintainers decided on 2026-10-24 that hosting is chosen on ease of development, stability,
speed and tooling an agent can drive, not on price.

|                               | DigitalOcean                                                                                      | Hetzner                                                                                                        | Hostinger                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Agent tooling                 | official MCP server (`@digitalocean/mcp`, MIT), `doctl` (Apache-2.0), OpenTofu provider (MPL-2.0) | `hcloud` CLI (MIT) and OpenTofu provider (MPL-2.0) for cloud; no official MCP; dedicated servers through Robot | official MCP, CLI and provider, all young |
| Billing for short-lived hosts | per second                                                                                        | hourly (cloud)                                                                                                 | prepaid terms                             |
| Regions                       | North America, Europe, Asia                                                                       | dedicated: Germany, Finland                                                                                    | worldwide, unnamed                        |
| SLA                           | 99.99% (droplets)                                                                                 | none on cloud, 99.9% dedicated                                                                                 | not found                                 |
| Public UDP, IPv6              | yes                                                                                               | yes                                                                                                            | IPv6 not confirmed                        |

Hostinger is out: prepaid terms, one IP per VPS, no confirmed IPv6 or Debian 13 image.

## Decision

1. **Staging and production run on DigitalOcean droplets with `selfhost.sh`**, from the same
   signed releases. No DigitalOcean-specific code; the platform stays provider-neutral and Hetzner,
   OVHcloud or a home server remain valid self-host targets.
2. **Staging is one droplet, upgraded to every release candidate** with `selfhost.sh upgrade`. It
   replaces Railway: `.railway/`, `scripts/railway-bootstrap.ts` and `docs/deploy/railway.md` are
   removed once the staging droplet has run one upgrade.
3. **Production starts as one droplet** with dedicated vCPUs (General Purpose or CPU-Optimized),
   sized by the E6 load test, plus:
   - **Off-host backups** in DigitalOcean Spaces (S3) through `WALG_S3_*` and `AWS_*`
     (`infra/postgres/walg-env.sh`), configuration only. Garage stays the FOSS default.
   - **Monitoring from outside**: a small droplet in a second region for uptime checks and the
     status page.
   - Block storage volumes for media work space if the boot disk is not enough.
4. **Infrastructure as code**: droplets, cloud firewalls, volumes, Spaces buckets and reserved IPs
   are OpenTofu with the `digitalocean/digitalocean` provider (MPL-2.0; verify at the pinned
   version per ADR 0002). DNS stays where the domain is (Cloudflare for `abolish.us`), as DNS-only
   records: Caddy needs the real client address and RTMP, IRC and WebRTC are not HTTP.
5. **Agents operate it through `doctl` or the DigitalOcean MCP server with a scoped token the
   operator configures**; agents never handle the token.
6. **Mail goes through a relay on a non-blocked port.** DigitalOcean blocks outbound 25, 465 and 587
   on new accounts (measured on the rc.1 droplet); staging uses Resend on 2587. Production either
   does the same or asks DigitalOcean to lift the block.

## Consequences

- Staging finally tests what we ship: the same bundle, units, Caddy, WAL-G and UDP as production.
- Bandwidth is metered: each droplet includes a transfer allowance pooled across the account, and
  egress beyond it is billed per GiB. ADR 0010's 160 TB/month scenario is expensive here. Watch
  egress per release, and lean on member relays and P2P (ADR 0005) before a CDN. If egress grows
  past what the project accepts, a dedicated media origin elsewhere is an add-on, not a migration.
- Shared-CPU droplets showed more tail latency under load in third-party tests; production uses
  dedicated vCPUs.
- Abuse and copyright complaints come through DigitalOcean's abuse process; the abuse-response
  runbook ADR 0010 asked for still applies.
- Region is open again, and easier: DigitalOcean has North American and European regions.
- Docs to change on acceptance: `docs/deploy/hetzner.md` becomes `docs/deploy/digitalocean.md`;
  `requirements.md` and `infra/README.md` stop naming Hetzner as the production host; ADR 0010 is
  marked superseded.

## Open questions

- Production region (North American or European audience first).
- Production droplet size, after the E6 load test.
- Whether the staging droplet is the rc test host (`staging-stream.abolish.us`) kept running, or a
  fresh one created with OpenTofu.

Sources (2026-10-24): Hetzner's price adjustment notice of 15 June 2026; Hetzner Cloud CPX pricing;
DigitalOcean droplet pricing; DigitalOcean's MCP server announcement (2025-08-26); Hostinger's
Debian VPS page.
