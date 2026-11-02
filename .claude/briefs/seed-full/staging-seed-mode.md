<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Staging seed mode (decided 2026-11-02)

You are implementing **staging seed mode** for CommonAir (repo: /Users/joshe/Repos/bcon). Read
these first:

- AGENTS.md;
- `.claude/briefs/seed-full/README.md` and `docs/testing/seeding.md`;
- `scripts/selfhost.sh`, all of it;
- `docs/self-hosting/{configuration,upgrades}.md`.

Do not look outside the repository. Branch: `seed/staging-mode`, from `origin/main`.

## Why

`bun harness/src/cli.ts seed full` only works against the local compose harness stack
(`bun scripts/infra.ts stack --harness --multi --captions --w3 --seed`). It needs:

- test hooks;
- insecure settings;
- mocks;
- stripe-mock;
- the scripted classifier with the synthetic hash lists;
- direct Postgres access;
- `/internal/*` routes;
- peers that the stack calls back.

Staging (`staging-stream.abolish.us`, droplet `commonair-rc-test`) is a normal self-host install
from signed releases, and it has none of these. Seed mode is a time-limited, staging-only state
that turns them on, runs the seed from inside the instance, and closes again.

## User decisions (binding)

1. **The harness runs on the droplet.** It runs in a container on the instance's `commonair`
   podman network. It reaches `api:3001`, Postgres, mediamtx and the other services directly, and
   the stack reaches the harness's peers by container name. Nothing new is published on the host,
   and nothing outside the host is trusted.
2. **On close, the features stay on and the hooks go off.** Closing removes:
   - every test hook, every insecure setting, private-network outbound, the mocks, stripe-mock,
     Mailpit and the harness container;
   - the inflated `INFRA_COST_MODEL`;
   - `GOVERNANCE_BOOTSTRAP_JSON`.

   Closing keeps on: `GIVEAWAYS_ENABLED`, `CHAT_WATCH_GATE`, `CHAT_SURGE_GUARD` and
   `WEB_PUSH_ENABLED` (with the VAPID pair).

   `FEDERATION_ENABLED` and `TWITCH_IMPORT_ENABLED` go back to their previous values, because they
   would otherwise talk to real peers. `PAYMENTS_PROVIDER` and the Stripe settings also go back to
   their previous values. Record the previous values when seed mode opens, and restore exactly
   those.

3. **Seed mode closes itself after 6 hours** (`--hours` may shorten it, never lengthen it past
   6). A timer runs the close. `status` shows that seed mode is open and its deadline.
4. **All email goes to a Mailpit container on staging** while seed mode is open. The harness
   reads Mailpit's API. Demo addresses never reach the real SMTP relay.

## What the seed needs

The orchestrator mapped this from the code, with file:line references. Verify each item yourself
before relying on it.

### Env for api and worker

Each env var comes from the harness compose overrides. The overrides are listed in
`scripts/infra.ts` as `HARNESS_OVERRIDES`, `CAPTIONS_OVERRIDE`, `W3_OVERRIDES` and `SEED_OVERRIDE`.

| Purpose                          | Variables                                                                                                                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Test hooks                       | `MODERATION_TEST_HOOKS`, `COOP_TEST_HOOKS`, `OPS_TEST_HOOKS`, `INTERACT_TEST_HOOKS`                                                                                                                                                                                                  |
| Scripted moderation              | `MODERATION_CLASSIFIER=scripted`, `MODERATION_SAMPLE_SECONDS=2`, `MODERATION_HASHLIST_CSAM`/`_NCII` pointing at the synthetic `packages/moderation/fixtures/{csam,ncii}.pdq` (also on media)                                                                                         |
| Insecure outbound                | `OUTBOUND_ALLOW_PRIVATE_NETWORKS` (api, worker, media), `EVENTSUB_ALLOW_INSECURE_CALLBACKS`, `WEB_PUSH_ALLOW_INSECURE_ENDPOINTS`                                                                                                                                                     |
| Features that stay on            | `CHAT_WATCH_GATE`/`CHAT_SURGE_GUARD` (also chat), `WEB_PUSH_ENABLED`, `GIVEAWAYS_ENABLED` (also chat)                                                                                                                                                                                |
| Federation and the Twitch import | `FEDERATION_ENABLED`; `TWITCH_IMPORT_ENABLED` with `OAUTH_TWITCH_*` and `TWITCH_*_BASE_URL`/`TWITCH_IMAGE_HOSTS`. These point at the harness's Twitch mock, which today is hard-coded to `host.containers.internal:4791`; in seed mode, point them at the harness container instead. |
| Payments                         | `PAYMENTS_PROVIDER=stripe`, `STRIPE_SECRET_KEY=sk_test_harnessseed`, `STRIPE_API_BASE=http://<stripe-mock>:12111`, plus a `STRIPE_WEBHOOK_SECRET` the harness also gets                                                                                                             |
| Costs and points                 | the seed's `INFRA_COST_MODEL`; `DEMO_SEED_FULL=true` on the worker. The staging marker is already set.                                                                                                                                                                               |
| Captions                         | whisper (`WHISPER_URL`, `CAPTIONS_MAX_STREAMS`). Staging must be installed with `--captions`; refuse to open seed mode without it.                                                                                                                                                   |

**Governance bootstrap.** `GOVERNANCE_BOOTSTRAP_JSON`, from `harness/compose.e5-coop.yaml`, only
takes effect at a database's first migration. So the order is: open seed mode, then
`reset-staging`, then seed. `reset-staging` must apply the bootstrap while seed mode is open.
seed-coop checks the bootstrap with `preflightGovernance`.

### Peers the stack calls

The stack reaches each peer through `HARNESS_WEBHOOK_HOST`, which must become the harness
container's network name:

- the e9 webhook receivers;
- the push sink;
- the ActivityPub peers;
- the Twitch mock (fixed port 4791);
- seed-media's RTMP sink;
- the Go member relay (`harness/src/relay.ts` uses a LAN IPv4 for `--public-url`; make that
  configurable so it works in-network).

### Connections from the harness

- **Postgres:** `DATABASE_URL`. The briefs say the app role, but the code uses whatever it is given
  (see "Open points").
- **Internal hooks:** `/internal/*` with `INTERNAL_API_SECRET`, sent to `HARNESS_API_URL` (here
  `http://api:3001`).
- **`AUTH_SECRET`:** must equal the stack's.
- **Stripe webhooks:** signed, and posted to `/api/webhooks/stripe`.
- **Media:** RTMP to mediamtx, the chat socket, HLS playback, and presigned S3 uploads.
- **Mailpit:** its API.
- **Health check:** seed-media requires `/healthz` to report `opsTestHooks` and
  `outboundPrivateNetworks`.

### Rate limits

`harness/src/seed/clients.ts` gives each client a CGNAT address through the harness forwarding
proxy, which sets `x-forwarded-for`. The API honours that only from a peer in
`TRUSTED_PROXY_CIDRS`. On a self-host install that is `10.89.42.10/32,10.89.42.11/32` (Caddy and
web). In seed mode, give the harness container a fixed address in the reserved lower half (for
example `10.89.42.12`), and add that one `/32` to the API's trusted list. Remove it again on
close.

## Build

1. **`selfhost.sh seed-mode open --confirm <PUBLIC_HOSTNAME> [--hours N]`**
   - Refuse, changing nothing, unless all of these hold:
     - `DEMO_SEED_FULL=true`;
     - `--confirm` matches, as `staging_guard` checks it;
     - captions are on;
     - seed mode isn't already open.
   - Save the previous values of the keys it will change to a state file under
     `~/.local/state/commonair/`.
   - Write the seed-mode keys into `commonair.env` as one marked block, so close can remove
     exactly that block.
   - Turn on the seed-mode units, gated in `unit_in_mode`, the way whisper is gated by its env
     value.
   - Start the close timer (decision 3).
   - Restart what has to restart.
2. **`seed-mode run --confirm <host> [--scale small|medium] [--seed n]`** (open only)
   - Run `seed full` in the harness container. Pass the right `HARNESS_*` env, `DATABASE_URL`,
     the secrets and `DEMO_SEED_FULL`, and `--confirm` set to `DATABASE_URL`'s `host:port/db`.
   - Stream its output, and write the run's store report somewhere the operator can read it.
   - Use the password from `DEMO_SEED_PASSWORD` if it is given. Otherwise print the generated one
     once.
   - **`seed-mode coverage`**, optional: runs `seed-coverage` the same way.
3. **`seed-mode close`**
   - Applies decision 2.
   - Is idempotent.
   - Is safe to run from the timer.
   - Leaves the seeded data in place.
4. **`status`** shows seed mode open or closed, its deadline, and which seed-mode units are
   running.
5. **New units.** These are `infra/quadlet/commonair-{stripe-mock,mailpit,seed-harness}.container`:
   - pinned images, publishing nothing (the network test);
   - covered by `compose.test.ts` (stripe-mock is in `DEV_ONLY` today; move it, and keep compose
     parity);
   - license entries in `infra/image-licenses.json`, after `bun scripts/vet-package.ts` /
     `pin-images.ts` as AGENTS.md rule 7 says;
   - Mailpit is already used in compose, so reuse its pin.
6. **The harness image.**
   - Prefer a release image (`commonair/harness`, added to `RELEASE_IMAGES` and built by
     `release.yml`). It contains bun, ffmpeg (libx264, aac) and the Go toolchain plus `relay/`
     sources, the harness and its fixtures, so it is signed and pinned with the release.
   - If that is clearly wrong, say why and propose an alternative instead.
   - Upgrades must not leave a stale harness image running.
7. **Upgrades and installs while seed mode is open.** Refuse `upgrade` and `install --reinstall`
   while seed mode is open, with a message that names `seed-mode close`.
8. **Docs.**
   - `docs/testing/seeding.md`: a "Seeding staging" section with the exact operator commands, in
     order: upgrade, open, reset-staging, run, coverage, close.
   - `docs/self-hosting/upgrades.md`: point to that section.
   - An ADR, `docs/decisions/00NN-staging-seed-mode.md`, recording the four decisions and the
     security exposure while open.

## Tests

- `scripts/tests/selfhost-sh-seed-mode.test.ts`, modelled on `selfhost-sh-reset-staging.test.ts`:
  - every refusal changes nothing (`changes(h)` is empty);
  - open writes exactly the block and the saved state;
  - close restores exactly the previous values and keeps the "stay on" features;
  - close is idempotent;
  - the timer is created with at most 6 h;
  - upgrade and reinstall refuse while open;
  - `status` shows the deadline.
- Static: the quadlet tests, the compose parity test and the network test pass with the new units.
- Unit tests for any harness changes (the relay public URL, the Twitch mock host).
- shellcheck stays clean.

## Done means

- Targeted checks only:
  - `bun --bun vp test run` on the touched test files;
  - `bunx tsc` for the touched packages;
  - `vp lint --deny-warnings` and `vp fmt` on the changed paths;
  - `reuse lint`;
  - shellcheck through the cli test.
- Never run `bun run verify`, compose, the self-host e2e, or anything against staging. Never SSH
  anywhere.
- Commit with `git commit -s` (Conventional Commits), ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push.
- Final message:
  - what you built;
  - the test counts;
  - the branch and sha;
  - the exact operator command sequence;
  - anything left open, including whether the harness image needs a release, which it will.

## Open points to settle in the code

- **The seed's `DATABASE_URL` role.** Every brief says the seed writes as the least-privilege app
  role, but on compose the harness `.env` gives it the owner. Use the **app role** in seed mode.
  If a unit fails as the app role, report it; don't switch to the owner.
- **The ffmpeg in the harness image** must have what the harness probes for: `harness/src/ffmpeg.ts`
  `probeFfmpeg`.
