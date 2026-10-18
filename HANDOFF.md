<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# HANDOFF — for the next head agent

Written 2026-10-18 at the end of the first orchestration session. Read this, then
[AGENTS.md](AGENTS.md), [PLAN.md](PLAN.md), [PROGRESS.md](PROGRESS.md),
[docs/architecture.md](docs/architecture.md) and ADRs 0001–0004 in `docs/decisions/`.
The original product brief's constraints still apply in full (FOSS-first, Podman, local-first on
`main`, DCO, verify gate, subagent pods with disjoint ownership, reviewer before commit).

## New priority: one full end-to-end flow first, then build around it

The first session built contracts and backend units in breadth (13 parallel units) before any UI
or end-to-end flow existed. **Change of approach:** get a thin, real, end-to-end flow working
locally under `podman compose up`, prove it with a harness scenario in Chromium and WebKit, and
then grow features as vertical slices (API route + worker job + web page + harness scenario
together), each landing green.

### Milestone E1 — "sign up, go live, watch, chat" (do this first)

Done when `podman compose up -d && bun harness/src/cli.ts run e2e-basic` passes:

1. **Stack up**: `compose.yaml` brings Postgres (+migrate job creating the least-privilege app
   role via `commonair_configure_app_role`), Valkey, Garage (+bootstrap), Mailpit, MediaMTX
   (`infra/mediamtx/mediamtx.yml`), api, chat, origin, media, worker, web to healthy. The infra
   unit's branch has most of this (see "Branches" below) — merge it first and fix what's broken.
2. **Web app (minimal, real)**: `apps/web` (TanStack Start + `@commonair/ui`): sign up (ALTCHA +
   birth date + legal acceptance), verify email (link from Mailpit), sign in, dashboard page showing
   the stream key + RTMP URL (`stream.ingest`, `stream.rotateKey`), channel page with the player
   (hls.js calling `playback.start` + heartbeats; native HLS on WebKit) and chat (chat WebSocket via
   `chat.connectToken`), footer with the AGPL Source link (`instance.info`). Use the house
   primitives; i18n-ready strings; no UI polish beyond the design rules.
3. **Harness scenario `e2e-basic`**: sign up a streamer through the web UI (Playwright), read the
   verification email from Mailpit, copy the stream key, publish an ffmpeg RTMP test pattern,
   open the channel as a second user in Chromium AND as an anonymous viewer in WebKit, assert
   first frame, measure TTFF and glass-to-glass latency, send a chat message and see it on the
   other client, stop the stream, assert offline.
4. Add `e2e-basic` to `bun run verify:full` and CI on main.

### Then, as vertical slices (each with its harness scenario, each merged green)

E2 follows + directory/discovery page + a moderation action (ban/timeout) + tmi.js bot via the IRC
gateway; E3 relay node joins and serves viewers (Go relay + origin issuance + receipts verified by
the worker) + viewbot swarm excluded; E4 money with the manual adapter (subscription, tip, ledger,
revenue dashboard, chargeback clawback), then the Stripe adapter against stripe-mock; E5 co-op
(memberships, a governance vote including the protected-decision rejection, council review,
patronage run with statement); E6 the rest of "Done means" (simulcast to the mock target,
overlays, VOD/clips, data export, account deletion, backup restore, load test, no-proprietary
profile). Keep PLAN.md's Phase 3–5 content as the backlog, reordered into these slices.

## State of `main`

- All shared contracts: `packages/contracts` (oRPC contract with REST routes, events catalog,
  chat protocol, internal service contract, scopes, shapes, ISO currency minor units), `packages/db`
  (schema + migrations 0000–0005; 0001/0002 are database-enforced ledger and governance protections,
  reviewed twice — see ADR 0004), `packages/config` (env schemas; `.env.example` must stay in sync),
  `packages/tokens`, `packages/service`, `packages/observability`, `packages/storage`.
- Merged units: email + OTel SDK (2M, with review fixes), ledger + patronage (2H1), relay (2F, with
  review fixes), origin (2D), worker (2L), IRC gateway (2C), governance + integrity (2H2), UI (2G),
  chat (2B, first fix round), media (2E), API core (2A).
- Harness core (2J) is merged. **Infra/compose (2I) is not**: its branch is complete, but merging it
  makes `DROP DATABASE` hang in integration tests — see "First task" below.
- Gate status at handoff: full `bun run verify` GREEN on `main` (pushed). Per-unit status and open
  items: PROGRESS.md "Handoff status".

## First task: merge infra (2I) and bring the stack up

1. `git merge --no-ff worktree-agent-a856cff1eae87abf9` (head 0b1f3f9).
2. Fix the WAL archiver hang: `archive_command = 'wal-g wal-push %p'` blocks forever when Garage
   is unreachable; Postgres's `DROP DATABASE` then waits on a ProcSignalBarrier the archiver never
   absorbs (seen in `pg_stat_activity` as `wait_event = ProcSignalBarrier`, archiver in
   `ArchiveCommand`). Wrap it with a timeout (e.g. `timeout 30 wal-g wal-push %p`) AND start
   Garage + garage-init + migrate in `scripts/infra.ts` (`TEST_SERVICES`, building `postgres` and
   `garage-init` first, waiting for exit 0 of the one-shot jobs), as the infra unit requested.
3. Fill the new infra variables in `.env` (`bun scripts/init-env.ts --force` regenerates; note an
   existing Postgres volume keeps its old password — set `POSTGRES_PASSWORD` to match or reset the
   volume with `bun scripts/infra.ts reset`).
4. Add an `apps/web` `start` script serving the build on `WEB_PORT` with `/healthz` (needed by the
   compose `web` service), then `podman compose up -d` until every service is healthy.

## Branches and worktrees

Each unit ran in a git worktree under `.claude/worktrees/agent-<id>/` on branch
`worktree-agent-<id>`. The final status of each (merged / unmerged commits / open items) is in
the table in PROGRESS.md "Handoff status". To integrate a branch:

```
git merge --no-ff --no-edit worktree-agent-<id>
# bun.lock conflicts: take ours and regenerate
git checkout --ours bun.lock && bun install && git add bun.lock && git commit -s --no-edit
bun run verify   # check the EXIT CODE, not grep output
```

Remove a worktree when its branch is merged and nothing uncommitted remains:
`git worktree remove .claude/worktrees/agent-<id>` then `git branch -d worktree-agent-<id>`.

## Open review findings (not yet fixed on main)

Every merged unit got an independent review; fix rounds were in progress at handoff. Anything a
unit did not report as fixed is still open. Highest priority open items:

- **API (2A)** — review findings, none fixed yet: (HIGH) the API's word-filter "ReDoS check" lets
  catastrophic patterns like `((a+))+$` through and chat compiles them with backtracking `RegExp`
  (the chat service now has its own shape check + 25 ms budget, but the API should refuse such
  patterns too, ideally via a linear-time subset); (HIGH) `birthDate` is writable through
  better-auth `update-user`, so minors can unlock mature content — refuse it in
  `databaseHooks.user.update.before`; (MED) playback mature gate ignores the category's mature
  flag; theme `avatarKey`/`bannerKey` and `image` accept third-party URLs (tracking, breaks the
  no-third-party rule); better-auth `admin` plugin endpoints bypass audit and safeguards; rate-limit
  subjects collapse behind an unconfigured proxy and aren't /64-bucketed for IPv6; (MED-LOW) relay
  and simulcast URLs need DNS-resolved private-range checks; (LOW) presigned uploads don't sign
  content-length; no per-recipient mail limits; interim viewer verification passes in under a
  second. Also still to do: publish `UserControlMessage`; `developer.tokens.list/revoke`; TOTP tests.
- **Integrity (2H2, integrity half)** — none fixed yet: fetch-less heartbeat bots get verified;
  stream-hour eligibility gameable (exclude owner's ipHash incl. stream key `last_used_ip_hash`,
  require `membership.classes.streamer.minVerifiedViewers` = 2 viewers); appeal overturns/`allowed`
  flags don't stick; concurrency ranks the live reload as the duplicate; datacenter weight 0.8 is
  fatal alone (lower to 0.6, privacy-relay class, drop hyperscaler ASNs from the sample);
  periodic-timing/background-tab/CDN false positives; relay suspension on missing issuance and
  post-reinstatement history; candidate-session scans need indexes:
  `create index playback_sessions_scoring_idx on playback_sessions (scored_at nulls first) where ended_at is null or verdict = 'pending';`
  `create index playback_sessions_live_hb_idx on playback_sessions (last_heartbeat_at) where ended_at is null;`
  (add as a migration); follow-burst prior viewing should count verified sessions only.
- **Media (2E)**: CSAM quarantine and kick-before-record are fixed; still open: stale
  `processing` VODs, crash recovery + work-dir sweep, disk budget, transcode slot limit,
  simulcast SSRF/protocol whitelist/generic errors, simulcast key in argv, thumbnail cleanup.
- Ledger, worker, origin, chat, IRC, relay and UI review findings are fixed (see PROGRESS.md for
  the small remainders).

## Process lessons from session one (keep doing / stop doing)

- **Check exit codes.** `bun run verify | grep GREEN` hides failures; capture the log and test
  `$?`. One commit (`cc5a7b5`) landed while unit tests were red and was fixed in `d2ba28d`.
- The gate runs workspace tasks with `--no-cache` because the task cache replayed a stale pass.
- **Never drop databases you didn't create** on the shared Postgres; agents' test databases live
  there (`commonair_test_*`, `commonair_tpl_*`).
- Integration tests must not assert tight wall-clock latencies; machines are loaded when many
  agents run. Poll until a condition holds, with generous deadlines.
- Fewer parallel units at once (≤ 6) made integration and review tractable; 13 at once produced a
  long tail of fix rounds. Prefer vertical slices with a harness scenario each.
- Review **before** merging, not after (session one merged several units before review).
- Briefs live in `.claude/briefs/`; contract requests from units are applied by the head agent
  only (contracts, db schema, config, root package.json, scripts).

## Local environment notes

- Podman machine `podman-machine-default` (8 CPU / 12 GB / 120 GB, rootless) with podman-compose
  1.6.0. Data services run as compose project `commonair` (`bun scripts/infra.ts test`).
- `.env` (gitignored) was generated with `bun scripts/init-env.ts`; regenerate with `--force` if new
  `__generate__` variables were added to `.env.example`, or append them by hand.
- GitHub repo `abolishus/commonair` is public with secret scanning and push protection enabled.
