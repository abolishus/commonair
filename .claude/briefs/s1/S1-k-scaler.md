<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# S1-k scaler: pools that grow and drain on their own

You are implementing unit S1-k for CommonAir (repo: /Users/joshe/Repos/bcon). Before you start,
read:

- AGENTS.md (non-negotiables 3, 6 and 7 bind this unit closely), PLAN.md and
  docs/architecture.md.
- [ADR 0041](../../../docs/decisions/0041-launch-scale.md) decision 3 and "Maintainer's answers"
  (the budget ceiling is not set yet), and [ADR 0025](../../../docs/decisions/0025-hosting-on-digitalocean.md)
  (decision 5: the operator's scoped token is never written to git or handed to an agent).
- `.claude/briefs/s1/launch-contract-step.md`: `cluster_nodes` and its audit rule (§1),
  `SCALER_*` (§2), node join, the provider enum and the metric names (§3.7-3.9).
- The merged wave 1 code: S1-e's node registry and health endpoint, S1-n's `--role`, `--join`
  and `node cordon|drain`, S1-f's drain on SIGTERM.
- `packages/payments/src/{adapter,manual,factory}.ts`, the pattern for an optional proprietary
  adapter with a FOSS default and a lazy import.
- `infra/tofu/README.md` and `.claude/briefs/s1/S1-g-iac.md`.
- `.claude/briefs/_done-means.md`.

Do not look outside the repository, except DigitalOcean's own API and product documentation for
the facts Build 2 names; record each with the date you checked it. This is **wave 2**: work in
your own git worktree, on branch `s1/k-scaler`, cut from `main` after wave 1 merged. S1-m runs
beside you.

## Why

Launch needs pools that follow load without a person: 1,000 concurrent streams arrive and leave
over a day, and a new host takes minutes. ADR 0041 decides that **our code chooses when to
scale** and the provider only creates and destroys hosts, because a host carrying live streams
must never be destroyed by a CPU-average rule. Today nothing in the app calls a cloud API, tofu
creates a fixed `app_count`, and hosts are installed by hand over SSH.

## You own (write only these)

- `packages/scaler/**` (new package: interface, planner, static adapter, DigitalOcean adapter).
- `services/worker/src/scaler/**` and `services/worker/src/jobs/scaler-tick.ts` (new).
- `services/api/src/nodes/**` (new: the `nodeJoin` route and token minting).
- `infra/tofu/digitalocean/**`, all of it from this wave on.
- `scripts/scaler/**` (new: the snapshot build).
- `docs/operators/autoscaling.md` (new) and the autoscaling section of
  `docs/self-hosting/scaling.md` (S1-n wrote the rest: add your section, change nothing else).

**Read-only:** `packages/contracts`, `packages/config`, `packages/db`, `scripts/selfhost.sh`,
`infra/quadlet/**`, the other services. A missing field or flag is a **contract request**.

## Contracts you must honor

- **The static adapter is the default and is complete.** With `SCALER_PROVIDER=static` the
  scaler never creates or destroys anything: it reports the pools and, if asked, cordons and
  drains hosts the operator listed. Every code path except host creation and destruction works
  with it.
- **No provider outside the adapter.** The planner, the tick and the api route never name
  DigitalOcean. The adapter is loaded lazily, as `packages/payments/src/factory.ts:28` loads
  Stripe.
- **No new npm dependency** for the provider API: use `fetch`. If you find one is needed, vet it
  first (`bun scripts/vet-package.ts`) and paste the output.
- **Secrets.** The provider token is a secret file, never in git, env files in the repo, logs,
  user data or a snapshot. A new host receives only a one-time join token (10 minutes, single
  use, accepted from the internal network only).
- **Every action writes an `audit_log` row** with the system actor: create, cordon, drain,
  destroy, and each refusal to act.
- **Ceilings are absolute.** The scaler never exceeds `SCALER_<POOL>_MAX`. The production
  values are not decided: ship with no defaults and refuse to start a non-static provider
  without them.

## Build

1. **The interface** (`packages/scaler`): list hosts in a pool, create one from an image with a
   role and a join token, destroy one by id, and nothing else. Cordon and drain are not the
   provider's: they are `cluster_nodes` state changes.
2. **Check the provider first**, and record the answers in `autoscaling.md`:
   - whether DigitalOcean's Droplet Autoscale Pools accept a desired size set by us and let us
     choose which droplet is removed on scale-in. If both, the adapter may use them; if not, it
     calls the droplet API directly. ADR 0041 leaves this open.
   - how a droplet reads its user data, and who else can read it;
   - the scopes a token needs for exactly this (create and destroy tagged droplets, read
     snapshots), and whether scopes can be limited to a tag or project;
   - API rate limits, and the account's droplet limit as a failure the adapter must report
     clearly.
3. **The planner**, a pure function: `(pool config, hosts, node registry, signals, clock,
   last actions) → actions`. Rules, all from ADR 0041 decision 3:
   - **Media out:** placed load over 60% of the pool's capacity (streams against
     `maxStreams`, ladders against slots), or headroom below the largest 10-minute rise in
     go-lives of the last 7 days.
   - **App out:** CPU p95 across the pool over 60% for 5 minutes.
   - **Moderation out:** `moderation.sample.lag` over 2 × `MODERATION_SAMPLE_SECONDS`.
   - **In:** only by cordoning the least-loaded host when the pool would stay under its
     scale-out threshold without it, then destroying it once it is empty (media: no live
     streams; app: drained; moderation: no active job) or the drain limit passes with nothing
     live.
   - Never below `MIN`, never above `MAX`, one scale-in at a time per pool, cooldowns after
     each action, and warm spares counted as capacity.
   - **Missing or stale signals mean no scale-in.** Scale-out on stale signals is allowed only
     up to the warm-spare count.
   - A host that never joined within a boot deadline is destroyed and counted as a failure;
     three in a row stop creation for that pool and alert.
4. **The tick**: a BullMQ job scheduler in the worker, one run per tick cluster-wide, with a
   Valkey run lock like the integrity jobs. It reads signals from the node registry, queue
   statistics and the metrics the contract names, runs the planner, and applies actions through
   the adapter. A dry-run mode logs and audits the plan and applies nothing (request the env key
   in a contract request if the contract step lacks one).
5. **Idempotence and crash safety.** Hosts are named and tagged from the pool and a sequence,
   so a tick that crashed after "create" finds its droplet on the next run. A droplet in the
   pool's tag with no `cluster_nodes` row past the boot deadline is an orphan: destroy and
   audit. A `cluster_nodes` row with no droplet becomes `gone`.
6. **Join** (`services/api/src/nodes`): mint a token for a role (scaler and `selfhost.sh node
   token` both use it), and serve `nodeJoin`: verify the token and the caller's internal
   address, return the role's env, burn the token. Rate-limit it and audit both outcomes.
7. **Boot in 3 minutes.** A rebuild plus install took about 7 minutes (ADR 0032 §1), because
   hosts pull about 14 images and download the classifier model at install.
   - `scripts/scaler/build-snapshot.ts` prepares a snapshot per role and release: the OS
     updated, Podman, the release bundle verified (signature and checksum, as `obtain_bundle`
     does), the role's images pulled by digest, the model fetched. **No secret and no node
     identity in the snapshot.**
   - First boot runs `selfhost.sh install --role … --join … --token-file …` from user data that
     contains only the app pool's internal URL and the token.
   - Measure and report boot-to-accepting-streams, and keep the warm-spare count as a parameter.
8. **Tofu.**
   - Per-role tags, firewalls and droplets for the pools' minimum sizes. The scaler owns
     droplets above the minimum: tofu must not destroy them (`ignore_changes`, or pools declared
     outside the droplet count), and a `tofu plan` after the scaler has acted must be empty.
   - A second load balancer for ingest (RTMP 1935) that targets the media tag and uses S1-e's
     node health endpoint; the app load balancer stops forwarding 1935.
   - The database firewalls admit each role's tag.
   - Variables for the snapshot ids and pool sizes, with `mock_provider` tests in the style of
     `tests/stage2.tftest.hcl`.
9. **Metrics**: `scaler.pool.size`, `scaler.pool.desired`, `scaler.actions`, plus an alert for
   "at ceiling and still over the scale-out threshold", which is the signal that admission
   control is about to refuse go-lives.
10. **`autoscaling.md`**: how it decides, every parameter, how to set ceilings from a budget
    and S1-i's costs, the manual overrides (pause the scaler, pin a host, force a drain), and
    what to do when the provider's API is down (nothing scales in, and the operator adds hosts
    with `selfhost.sh --role`).

## Edge cases

- The provider API failing mid-create, or returning the droplet limit error.
- Two ticks overlapping despite the lock (the lock expired): actions stay idempotent.
- A media host cordoned for scale-in when load rises again: uncordon, do not create.
- A host whose streams never end: the drain limit passes, and it is still not destroyed while
  anything is live. Alert.
- Clock skew between hosts in the registry's `seenAt`.
- Scale-out during a rolling upgrade: new hosts boot the pool's current release, never a mix
  the migrations cannot serve.
- The scaler's own worker host being the one chosen for scale-in.

## Tests you must add

- **Planner: exhaustive unit tests.** Every rule at its boundary, min and max, cooldowns, stale
  and missing signals, the warm spares, the boot-failure breaker, uncordon-instead-of-create,
  and a property test that no sequence of inputs produces an action past a ceiling or a destroy
  of a host with live streams.
- **DigitalOcean adapter:** against a local fake HTTP server that implements only the endpoints
  used (create, list by tag, destroy, the error cases). Do not mock `fetch` in-process.
- **Tick integration** (`*.int.test.ts`, real Postgres and Valkey, static adapter and a test
  adapter): a crash between create and register, orphan cleanup, audit rows for every action,
  one tick cluster-wide with two workers.
- **Join:** token single use, expiry, wrong role, a caller outside the internal range.
- Tofu tests for the pools, the ingest balancer and the firewalls.

## Reviewer focus

- A host with a live stream cannot be destroyed by any path.
- Ceilings hold, and a non-static provider cannot start without them.
- The token never appears in git, logs, user data or a snapshot, and the join token is
  single-use and short-lived.
- The static default is complete, and no provider name leaks outside the adapter.
- Every action is audited.
- `tofu plan` is empty after the scaler has added hosts.

## Done means

Follow `.claude/briefs/_done-means.md`: `bun run test` and `bun run test:int` for
`packages/scaler`, `services/worker` and `services/api` (one at a time), `bunx tsc --noEmit` for
each, `sh infra/tofu/check.sh` if tofu 1.13.1 is installed (say so if it is not),
`bun scripts/check-licenses.ts`, lint, format and `reuse lint`. `git status` shows only your
paths. Commit with `git commit -s`.

Your final message lists: what you built, test counts, the provider facts with dates, the
measured or estimated boot time, contract requests, and the staging commands for the user
(build a snapshot, start the scaler in dry-run, then live with a ceiling of 3).
