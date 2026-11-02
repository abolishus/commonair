<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0040: Staging seed mode

- Status: proposed 2026-11-02 (the four decisions below are the maintainer's, made 2026-11-02)
- Date: 2026-11-02 (code checked at `b2e366b8`)
- Brief: [staging seed mode](../../.claude/briefs/seed-full/staging-seed-mode.md); plan:
  [full-coverage seed](../../.claude/briefs/seed-full/README.md)

## Context

`bun harness/src/cli.ts seed full` fills every table and route. It only works against the local
compose harness stack (`bun scripts/infra.ts stack --harness --multi --captions --w3 --seed`),
because it needs:

- every test hook (`MODERATION_`, `COOP_`, `OPS_` and `INTERACT_TEST_HOOKS`) and the `/internal/*`
  routes behind `INTERNAL_API_SECRET`;
- insecure settings: private-network outbound, insecure EventSub callbacks and push endpoints;
- the scripted classifier with the synthetic hash lists;
- stripe-mock, an SMTP sink and direct Postgres access;
- peers the stack calls back: webhook and push sinks, an ActivityPub peer, the Twitch mock, an
  RTMP sink and a member relay.

The staging instance (`staging-stream.abolish.us`, droplet `commonair-rc-test`) is a normal
self-host install from signed releases, with none of these. `selfhost.sh reset-staging` already
resets it, guarded by `DEMO_SEED_FULL=true` and `--confirm <PUBLIC_HOSTNAME>`.

## Decision

`selfhost.sh seed-mode open|run|coverage|close` puts a staging instance into a time-limited
**seed mode** that has all of that, runs the seed from inside the instance, and closes again.
`docs/testing/seeding.md` ("Seeding staging") has the operator's steps.

1. **The harness runs on the droplet**, in a container (`commonair-seed-harness`, from the release
   image `harness`) on the instance's `commonair` network.
   - It reaches `api:3001`, Postgres as the app role, MediaMTX, Mailpit and stripe-mock by name.
   - The stack reaches the harness's peers at `seed-harness`, its network alias.
   - The container has the fixed address `10.89.42.12`, in the lower half of the network that
     Podman never leases. Only while seed mode is open, the API trusts `X-Forwarded-For` from that
     one `/32`, so the harness's forwarding proxy gives each simulated client its own rate-limit
     subject.
   - Nothing new is published on the host, and nothing outside the host is trusted.
   - The harness reaches `https://<PUBLIC_HOSTNAME>` through Caddy on this host
     (`AddHost=<host>:host-gateway`), as a browser would: presigned uploads, playback and the
     web app.
2. **On close, the features stay on and the hooks go off.**
   - Close removes every test hook, every insecure setting, private-network outbound, the mocks,
     stripe-mock, Mailpit and the harness container, the inflated `INFRA_COST_MODEL` and
     `GOVERNANCE_BOOTSTRAP_JSON`.
   - It keeps `GIVEAWAYS_ENABLED`, `CHAT_WATCH_GATE`, `CHAT_SURGE_GUARD` and `WEB_PUSH_ENABLED`
     (with the VAPID pair) on.
   - `FEDERATION_ENABLED`, `TWITCH_IMPORT_ENABLED` and its OAuth and URL settings,
     `PAYMENTS_PROVIDER` and the Stripe settings, and the SMTP settings go back to their previous
     values. Open saves each previous value (`~/.local/state/commonair/seed-mode`, mode 0600) and
     close restores exactly those; a key that was absent stays absent.
3. **Seed mode closes itself after 6 hours.** `--hours` may shorten it, never lengthen it. A
   persistent user timer (`commonair-seed-mode-close.timer`, `OnCalendar=` at the deadline) runs
   `seed-mode close`; a deadline missed while the host was down fires at boot. `status` shows the
   deadline, and `run` refuses once it has passed.
4. **All email goes to a Mailpit container** while seed mode is open (`SMTP_HOST=mailpit`, no TLS,
   no credentials). The harness reads Mailpit's API. No demo address reaches the real SMTP relay.

How the pieces fit:

- **commonair.env:** open writes the seed-mode keys as one marked block, so close can remove
  exactly that block. The values match the compose overrides the local seed stack layers, with
  every peer at `seed-harness` instead of `host.containers.internal`;
  `scripts/tests/selfhost-seed-mode-parity.test.ts` keeps them equal. The webhook secret the
  harness signs stripe-mock's events with is generated fresh for each open, never the instance's
  own.
- **Drop-ins:** what the units pin themselves (`Environment=` beats an env file), so the block
  cannot change it, goes in Quadlet drop-ins that the release ships
  (`infra/selfhost/seed-mode/`). These are the synthetic hash lists for api, worker and media, and
  the harness's `/32` in the API's `TRUSTED_PROXY_CIDRS`. The instance's own hash lists are never
  touched.
- **Units:** `unit_in_mode` lets the stripe-mock, Mailpit and seed-harness units in only while seed
  mode is open, the way it lets whisper in only with captions on. A normal install neither pulls
  their images nor installs them.
- **Order:** `GOVERNANCE_BOOTSTRAP_JSON` takes effect only at a database's first migration, so the
  order is open, `reset-staging`, run.
- **Upgrades:** `upgrade` and `install --reinstall` refuse while seed mode is open, and name
  `seed-mode close`. The harness unit is copied from the installed release at open, so a later
  release never runs an earlier harness image.
- **Guard:** every subcommand but `close` refuses unless `DEMO_SEED_FULL=true` and `--confirm`
  equals `PUBLIC_HOSTNAME`, as `reset-staging` does. Open also needs live captions on.

**The harness image** (`infra/containers/harness.Containerfile`) is a release image, signed and
pinned with the release like the others.

- It is built on Playwright's image at the harness's Playwright version, so its Chromium and
  WebKit run `seed-coverage`.
- It adds Bun, Go with `relay/` (the relay is built once, into the cache
  `buildRelay` reads), Ubuntu's FFmpeg (libx264, aac, libopus, RTMP: what `probeFfmpeg` and
  seed-media use) and the repository with every workspace's production dependencies.
- No instance runs it outside seed mode. The self-host e2e tags a stand-in for it instead of
  building it.

**The database role.** The seed writes as the app role (`commonair-database-url`), never the
owner, as the briefs say. Every protected table is written through the real code paths.

## Security exposure while open

For the hours seed mode is open, the staging instance:

- serves the test-hook routes to anyone holding `INTERNAL_API_SECRET`, and runs the ops, co-op,
  moderation and interactivity test hooks (test clocks, waived quiet windows, immediate payout
  holds);
- lets the API, the worker and media call private addresses and plain http (needed for the
  harness's peers), so a user-supplied URL could reach a private address on the network;
- accepts insecure EventSub callbacks and push endpoints;
- runs the scripted classifier with synthetic hash lists, so real uploads are not classified or
  matched against the instance's own lists;
- accepts payments only through stripe-mock and delivers no email, so real users' payments,
  sign-up mails and notifications go nowhere;
- has the federation and the Twitch import pointed at the harness;
- trusts `X-Forwarded-For` from `10.89.42.12`. A container that took that address could choose
  its own client address. Podman never leases it, and only the harness unit claims it;
- gives the harness container the session secret, the internal secret, the media bucket's key and
  an app-role database URL, but never the evidence key or the owner role.

That is acceptable only on a staging instance with no real users, which `DEMO_SEED_FULL=true`
marks. The deadline bounds the exposure, and close returns every setting but the four features
of decision 2 to its previous value.

## Consequences

- One command sequence seeds staging with nothing set up off the host.
- Each release builds and ships one more image, the largest (a few GB, because of the browsers).
  It is pulled only when seed mode opens.
- The seeded data outlives seed mode. Webhook, Discord and federation rows point at peers that
  went away with the harness, and fail later, as on the local stack.
- If the seed is still running at the deadline, the timer stops it, and the database needs a reset.

## Open points

- `AddHost=<host>:host-gateway` relies on Podman 5's host-gateway mapping reaching Caddy's systemd
  sockets from a rootless bridge network. It is not yet checked on the droplet.
- With `TLS_MODE=internal`, the harness drop-in turns TLS verification off for Bun
  (`NODE_TLS_REJECT_UNAUTHORIZED=0`). Playwright still rejects the CA, so `seed-mode coverage`
  needs ACME.
- `scripts/supply-chain.ts` matches only repositories with two or more path segments, so it does
  not see `mcr.microsoft.com/playwright`. Its digest was pinned by hand, and `compose.test.ts`
  checks it.
