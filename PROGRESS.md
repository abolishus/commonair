<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# PROGRESS

Updated by the orchestrator after every integration step. Phases and units: [PLAN.md](PLAN.md).

## Done and verified

- Phase 0: name (ADR 0001), license policy + verified licenses (ADR 0002), architecture (ADR 0003),
  toolchain, REUSE, config module, stray-domain and license checks, `verify` script, project docs,
  AGENTS.md + skills, CI workflow.
- Phase 1: contracts (enums, shapes, scopes, events, chat protocol, tokens, full oRPC router,
  OpenAPI generation), Drizzle schema (all domains) + `0000_initial` + `0001_protections`
  (append-only ledger/audit, double-entry balance, governance protections re-tallying votes),
  tokens package with RFC 8032-anchored vectors, data services in `compose.yaml`.
- Two security reviews of the database protections; every proven bypass fixed with a regression
  test (`0002_protections_hardening.sql`, ADR 0004). Tests run as a least-privilege role.
- Secret scanning and push protection enabled on the GitHub repository.

## Session eleven (2026-10-22): Phase 5 release and self-hosting (in flight)

Started from `eefb597` (E6 done, supply-chain policy ADR 0022 landed as `9dd395a`). Policy
ADR 0023. The user decided:

- ghcr.io (`ghcr.io/abolishus/commonair/<image>`) plus a `cosign copy` mirror recipe for a
  self-run FOSS registry;
- keyless cosign through GitHub OIDC;
- `selfhost.sh` supports Debian 13 and Fedora 42+;
- semver from `v0.1.0` (first tag `v0.1.0-rc.1`);
- arm64 is required at launch.

Contract step: ADR 0023, `scripts/release/manifest.ts` (release manifest schema, image list,
refs and asset names; 26 tests), and `infraEnv` `TLS_MODE`/`ACME_EMAIL`/`ACME_CA`. Briefs are
in `.claude/briefs/phase5/`. Units:

- **A**: CI + release workflow (`.github/**`, `scripts/release/**`).
- **B**: Quadlet/Caddy/systemd + `selfhost.sh` (`infra/quadlet|caddy|systemd/**`,
  `scripts/selfhost*`).
- **C**: docs (`docs/self-hosting/**`, the release runbook, README, `hetzner.md`,
  `infra/README.md`).

A and B run as one batch in worktrees; C runs after they merge.

## Session ten (2026-10-22): E6 Phase 4 completion (in flight)

Started from `388f69f` after E5 closed (e5-coop passed twice, e4b-money and trust-safety once).
Spec `docs/testing/e6-selectors.md`, policy ADR 0021 (the user decided: JSON-only export with a
7-day link and one per kind per 24 h; overlay tokens with optional expiry (none, quick picks up
to 6 months, or any exact date), one active per channel; the restore drill on a throwaway
Postgres; `full` keeps load small and `load-plan` (20 × 200 per streamer) stays out; `full`
includes e5-coop, trust-safety and e2e-relay on one harness stack; polls, predictions, raids and
goals stay 501). Contract step on `main`: `93bab15` (spec, ADR, migration `0022_e6_ops`
(overlay token expiry + one-active index, `vods_broadcast_idx`, export expiry index; db int 3/3),
contracts (overlay token expiry/status/revoke, `OverlayAlert`, `BUS.overlay`,
`OVERLAY_EVENTS_PATH`, `EXPORT_JOBS` and export constants, `opsTick`), `OPS_TEST_HOOKS`,
`infra.ts stack --harness`, `harness/compose.e6.yaml`), `64ddf72` + `6a3d3d0` (fflate 0.8.3 MIT
for worker and harness; worker → `@commonair/email`; harness → ledger, storage). Found while
surveying: account deletion left `events`/`webhook_deliveries` payloads (usernames) and export
objects in place, and `tips.message`; unit B fixes that. Briefs in `.claude/briefs/e6/`.
Batches (workflows of three): 1 = A API, B worker, C `packages/ui`; 2 = D web, E1 harness
feature scenarios, E2 harness ops (drill, load-plan, full, no-proprietary, SDK bot).

**Batch 1 merged** (workflow `wf_4d6d02b7-197`): C `packages/ui` (`6b4ca30`, fix `a96261b`;
ui tests 2227), A API (`26331d3`, fix `7127746`; new unit 38, int 26), B worker (`9b534b5`, fixes
`1e78a4c`, `33a641d`; unit 324, int exports/deletion/housekeeping). Reviews: A one HIGH (a clip
made a `subscribers` VOD public) fixed and re-reviewed; B four HIGH (the live user's
`stream.offline` survived the scrub; the scrub deleted unrelated events platform-wide; worker
tsconfig lacked `jsx`) fixed and re-reviewed; C none. Head fixes `24c7f61` (reviewed, no HIGH):
export mail may carry the presigned link (`storageLinks`, https or local storage origin only);
`lockLegalHold` taken by every hold insert and every media purge; account deletion records
`pending_objects` (migration 0023) and retries them, media only without a hold; Caddy routes
`/overlay/events` to the API.

**Batch 2 merged** (workflow `wf_00a70280-12b`): D web (`d12a918`, fix `adae0c2`; web 943),
E2 harness ops (`41f02e5`, fixes `31449f0`, `8dad99a`; harness 391 + drill int 1), E1 harness
feature scenarios (`d62c5b9`, fix `4f3799d`; 65 new). Reviews (each unit had a security reviewer
too): D none HIGH; E2 one HIGH (the SDK-bot step tripped chat's 30 s duplicate filter) fixed; E1
four HIGH (deletion audit check by count only; overlay token could reach the report through a
Playwright error; the listed `downloadUrl` scope and expiry were never checked; the payer check
read only `alert` frames) fixed and re-reviewed. Head `72a7d48`: harness redacts URL credentials
from every step/run error; overlay-alert scans all three streams; username `content` reserved.

**Live runs (2026-10-22, head agent at the user's request).** On the harness stack
(`bun scripts/infra.ts stack --harness`, E5-bootstrapped volume): all seven E6 scenarios pass
(`simulcast` 18/18, `overlay-alert` 41/41, `vod-clips` 28/28, `data-export` 42/42,
`account-deletion` 25/25, `backup-restore` 11/11, `e2e-social` with the SDK bot), `e2e-relay`
passes (21/21, 8 min), and `full` and `full --profile no-proprietary` pass 17/18 each; the
only skip is the Stripe variant of `e4b-money`. **`ingest-whip` fails** (WebKit never shows a
first frame): WHIP brings Opus audio, MediaMTX muxes it into HLS as is, and WebKit's native HLS
does not play it (RTMP brings AAC and plays). Pre-existing, not E6; fixing it needs an Opus → AAC
audio transcode for WHIP ingests in media (decision pending with the user). `bun run verify` is
GREEN.

Fixed while bringing it up (symptom → root cause → fix):

- Postgres reset itself five times (backend "terminated by signal 13"), each time taking the
  worker down → the postmaster ran as PID 1 and reaped orphans (timed-out `podman exec` /
  healthchecks); one dying by SIGPIPE looked like a crashed backend → `init: true` (compose) and
  `RunInit=true` (Quadlet), with a test (`ee904e0`).
- Migrations 0022–0023 never ran → podman's `rm --depend <name>` removed migrate's dependents but
  kept migrate, and compose restarted the old container → survivors removed by id; `stack` now
  fails loudly if any container is still on an old image (`3624153`, `ae62f79`).
- The tmi.js bot could never sign in through the IRC gateway (since Phase 1) → tmi.js lowercases
  `PASS oauth:<token>` and bot tokens were mixed-case base64url → lowercase hex access tokens
  (`randomTokenSecret`); chat logs refused upgrades with status and code (`089265c`).
- Simulcast target changes while live were ignored → API publishes `simulcast-targets` on
  BUS.live; media reconciles the live pushes; a disabled target reads idle (`b4a65b6`).
- Export mail linked the privacy page → `createWorker` dropped `storageOrigin` (`3624153`).
- e2e-relay refused to run → its preflight read `.env`; the API now reports
  `outboundPrivateNetworks` on `/healthz` (`9357148`).
- Harness: simulcast reloaded the dashboard into the session rate limit; overlay-alert tipped
  below `tipMinCents`; manifest row rule for object files; SDK bot reply race; ingest viewers
  stopped before the first heartbeat on a fast stack; simulcast re-enable budget 45 s.
- Gate: chat filter-runner raced JavaScriptCore's ~400 ms backtracking cap (test timeout 250 ms;
  production's is 50 ms); infra stack tests re-running one-shot containers got 60 s.

WHIP/WebKit (user-approved follow-up): media now publishes an AAC copy of a non-AAC source
(`live/<slug>/aac`, video copied, `KEYS.sourceAac`), and origin serves it in place of the source
under the same URLs (`186acf4`; media unit 4, origin int 14, API auth 26). Live: MediaMTX muxes
the copy as H.264 + AAC and Chromium plays it. The harness native player was refusing to start in
WebKit (`play()` NotAllowedError even muted/inline): it now records player errors and clicks once
like a viewer (`aefda3b`); WebKit then reached first frame on both ingests. Final green runs of
`ingest-whip`/`ingest-rtmp` were blocked by host load (load average ≈ 44 from another repo's
suites): rerun when the machine is quiet. MediaMTX warns that the copy's LL-HLS part durations vary
("will cause an error in iOS clients"); watch for it on real iOS.

Open follow-ups: rerun `ingest-whip`/`ingest-rtmp` on a quiet machine; the worker's Postgres client
crashed the process on a connection reset and Podman did not restart it despite
`unless-stopped` (the trigger is gone; make the worker survive and look at the restart policy).

**User to run** (nothing here was run against the live stack): recreate the Postgres volume once
with the E5 bootstrap (ADR 0020), `bun scripts/init-env.ts --merge` (new `OPS_TEST_HOOKS`), then
`bun scripts/infra.ts stack --harness` (rebuilds api, worker, web, media images; migrations
0022–0023), then `bun harness/src/cli.ts run <name>` for `simulcast`, `overlay-alert`,
`vod-clips`, `data-export`, `account-deletion`, `backup-restore`, `e2e-social` (SDK bot), then
`run full` and `run full --profile no-proprietary` (expected skip: the Stripe variant of
`e4b-money` only), and `run load-plan` by hand. Plus `bun run verify`, Storybook (`Pages/Creator
studio/Overlays`, `Content`, `Settings`, `StreamSetup`, the overlay view) and browser checks of
`/dashboard` simulcast, `/overlays`, `/content`, `/settings/privacy` and `/overlay/alerts?token=…`
(both themes, 320 px, OBS browser source).

Known gaps, not blocking: alert strings render in English (no instance locale); alert-config
cache is per API process (10 s); clips cut from `subscribers` VODs follow the VOD now, but clips
have no visibility of their own; the export mail links the privacy page instead of the archive
when `S3_PUBLIC_ENDPOINT` is unset or plain http on a public host; e4b-money's Stripe variant is
declared in the registry's `DEFAULT_PARAM_NEEDS` rather than on the scenario.

## Session nine (2026-10-21/22): E5 co-op

Spec `docs/testing/e5-selectors.md`, policy ADR 0020 (the user decided: shares refunded at once
on exit, two-person patronage approval, any seated council member responds, the local stack's
database is recreated once with short bootstrap periods). Contract step on `main`: `231b2c0`
(spec, ADR), `ede4cdd` (migrations 0019–0021: share statuses, patronage `computed_by_id`,
council term `txid`, triggers for tallies, council, shares, patronage and comments; db int
95/95, governance int 21/21, patronage int 14/14), `12d930b` (contracts: `finance` access,
`coop.shares.*`, `proposals.update`, `patronage.periods`, internal co-op events, `QUEUES.coop`,
`COOP_JOBS`, `/internal/coop/tick`, `COOP_TEST_HOOKS`). Briefs in `.claude/briefs/e5/`. Units run
as workflows of three: batch 1 = A API, B worker + governance lifecycle, C `packages/ui` boards;
batch 2 = D web, E harness `e5-coop`.

**Batch 1 merged** (workflow `wf_3f6e676f-c8d`): A API (`ac4b979`, fix `d8c1020`), B worker +
governance lifecycle (`61dd4eb`, fix `e097e2b`), C `packages/ui` co-op compositions and boards
(`f231af9`, fix `04da33a`). Reviews: no HIGH in any unit (A and B also had a security reviewer);
MEDIUMs fixed (A: share reference retry, withdrawn drafts stayed public, draft titles on the
public event; B: vote notices batched, transient apply errors no longer permanent, unfilled
council refilled, viewer exits kept; C: run-form surplus parsed to cents). Head after merge:
`d77a23e` — votes were judged by the API host's clock against a database-stamped window (the
Podman database runs ~35 ms ahead), so a vote right after voting opened was refused; now the
database clock. Spec/ADR clarifications `9144093`. On `main`: API int 221/221, worker int 76/76,
governance int 37/37, db int 95/95, patronage int 16/16, unit tests of every touched package and
tsc of every package pass.

## E5 `e5-coop` milestone reached (2026-10-22)

`e5-coop` passes twice in a row on the local Podman stack (87/87 assertions each, 3m04s and
3m00s, streamer qualification ≈ 48 s), and on the same stack `e4b-money` (82/82) and
`trust-safety` (95/95) pass. Stack: `bun scripts/infra.ts stack harness/compose.trust-safety.yaml
harness/compose.e5-coop.yaml` on a Postgres volume recreated once (ADR 0020), then
`HARNESS_WEB_URL=http://localhost:3100 bun harness/src/cli.ts run e5-coop` (`--set via=api` for the
backend only).

**Batch 2 merged** (workflow `wf_d2aba403-51c`): D web (`cd01013`, fix `5768099`), E harness
(`9f52950`, fix `1001c4a`). No HIGH. Head follow-ups: `/admin/coop` guard and sidebar (`084eda8`,
the layout guard sent admins to not-found), a pending share shows its payment reference again
(`f54dafe`, contract + API + web), council size 50 on the test stack (`4240985`).

Bring-up (symptom → root cause → fix):

- Votes refused as `voting_closed` right after voting opened, ~1 in 3 integration runs → the API
  judged the window by its host clock against the database-stamped window (the Podman database
  runs ~35 ms ahead) → database clock (`d77a23e`).
- `e5-coop` step 4 `RATE_LIMITED` → the scenario polled proposal status anonymously twice per
  tick every second (~240/min against 120/min) → one list call every 2 s (`e65edcb`).
- `/coop/council` read empty → the wrapper renders with an empty `data-term-id` while loading;
  the driver read it at once (`369fdc1`, `74eeeab`); its retry reloaded the page every second,
  ~300 calls/min as the viewer, so the session check got a 429 and the page rendered signed out
  → re-read every 3 s (`7c82f40`).
- Share refund step timed out → the treasury shares tab lists `refund_pending` only, so the row
  leaves it; wait for that and the API status (`369fdc1`).
- The co-op Overview tab stayed active on every `/coop/*` page → exact link match (`4df5d9b`).
- Streamer qualification took 2–4 min waiting for the 5-minute integrity schedule → tick-only
  `COOP_JOBS.streamHours` runs the pass under its own lock (`ff27a2d`).
- With faster runs, sign-in and appoint-worker forms were filled before hydration (React reset
  the state behind the visible values) → `html[data-hydrated]` set by the web root, and the
  harness waits for it after every navigation (`39ce23c`; benefits every web scenario).

Unverified (user): `bun run verify`, Storybook for the new co-op boards (`Pages/Co-op/*`,
`Pages/Platform/TreasuryCoop`, `AdminCoop`), a browser pass over `/coop/*`, `/treasury` shares and
patronage tabs, `/admin/coop` and `/transparency` (both themes, 320 px, keyboard).

## E4c `trust-safety` harness bring-up (2026-10-21/22, done)

`trust-safety` passes twice in a row against the local Podman stack (92/92 assertions both runs;
T0 off air ≈ 5 s against a 9 s limit, T2 label ≈ 4 s, T1 restrict ≈ 3 s), and `e4b-money` still
passes on the same stack (82/82). Run it with `bun scripts/infra.ts stack harness/compose.trust-safety.yaml`,
then `bun harness/src/cli.ts run trust-safety` (`--set steps=7` runs one step).

Fixed (each with a regression test checked against the old code; API/worker/media changes
reviewed independently):

- Env/infra: `TRUSTED_PROXY_CIDRS` was unset locally, so all simulated users shared one auth
  rate-limit bucket (local `.env` only). `infra.ts stack [override.yaml...]` layers compose
  overrides and recreates containers whose image was rebuilt (podman-compose does not).
  Compose defaults `S3_PUBLIC_ENDPOINT` to the published Garage port (presigned uploads and media
  URLs carried `garage:3900`). ffmpeg is now in the api and worker images (uploads and live T1/T2
  scans failed without it).
- API: the `/internal/moderation/*` test hooks were never served; `startModeration` now runs at
  boot (fail closed) and `/healthz` reports the hooks; `bullmq` was not a dependency, so every
  real T0/escalation/NCII enqueue threw; `vods.list/get` and `clips.create/list/get` implemented
  (were 501) with T0/NCII/T1 hiding, a removed-source backstop for clips and the 18+ gate on media
  URLs; removing a VOD also removes its broadcast's clips. Live clips end 10 s behind the live edge.
- Media: a live clip whose window the recorder has not written yet (ffmpeg writes the playlist
  only when a segment closes, ~15–25 s after going live) failed at once with "not live here and
  has no VOD" on channels without VODs. The lookup now returns `pending` and the clip job waits
  (delayed BullMQ retry every 1 s, up to 60 s after it was queued); a window that starts before
  the recording began moves to its start. (The earlier `Bun.file().exists()` theory was a timing
  artefact: the playlist did not exist yet when the job ran.)
- Worker: `t0-media` job ids had `:` in a form BullMQ rejects, so evidence moves after T0 (and the
  daily reconciler and digest checks) never ran; the T0 evidence count is logged as
  `evidenceCount`. The `ncii-hash` job skipped every item because it read `removed_at` (set by the
  API at decision time, and relied on by the 0017 avatar guard) as "already hashed"; it now marks
  `ncii_request_items.hashed_at` (migration 0018).
- Web: a T1-restricted stream shows `stream-restricted` and plays only for confirmed adults; a
  decided moderation case stays open and refreshed.
- Harness: deletion timestamps read as strings; queue rows open through their button; the NCII
  form driver re-fills text fields that hydration reset; clip frames are read through the public
  media URL (ADR 0009).

Open:

- ~~Public media URLs not fetchable on the local stack~~ closed (2026-10-21, ADR 0009): media URLs
  are `MEDIA_PUBLIC_URL/<key>`, served by the origin's `/media` route from the media bucket for
  the public prefixes only (`channels/`, `clips/`, `thumbnails/`, `vods/`); `incoming/` and
  `moderation/` (NCII-hidden, review frames) answer 404. The trust-safety scenario reads clip 2
  through its public URL and checks clip 1's URL and hidden copy answer 404.
- `ncii-hash` does not hash `broadcast` items yet (a `/live/<channel>` URL: the API ends the
  broadcast and deletes its VODs/clips, but their objects stay and no hashes are added); those
  items stay without `hashed_at` so a later fix picks them up. Requests decided before migration
  0018 need a one-off `ncii-hash` re-enqueue (none exist on a real instance yet).
- vods/clips `update/remove` remain 501 (E6). `vods.broadcast_id` has no index (the clip backstop
  subquery uses it).

## E4b validation (2026-10-21)

Resumed at the user's request. Local `e4b-money` passes: manual API **77/77** assertions,
manual browser **82/82**, Stripe API against stripe-mock **95/95**. Stripe used the pinned
v0.206.0 upstream fixtures with `balance_transaction.fee=50` and matching `net`; stock fixtures
report zero fees and cannot confirm payments. Temporary mock keys and a compose override were
used; no real Stripe account or money. The manual adapter was restored afterward.

Storybook builds; Support dark/light, mobile 320, gift controls, instructions, no-tiers,
PageTabs disabled tabs and wrapped ChoiceToggle inspected. Fixed oversized option-card radios
(horizontal Field orientation), treasury actions racing a debounced search, and the harness
reading the provider before Support loaded. Added option-card and worker health-port regressions.
The gate also exposed formatting/lint issues and a macOS watcher-test race, now fixed.

Full `bun run verify` passed before the last money/infra fixes. The rerun stopped at infra up
because the local `.env` predated the E4c evidence keys (`garage-init: S3_EVIDENCE_ACCESS_KEY_ID
is required`); after `init-env --merge`, `bun scripts/infra.ts test` is healthy. Final gate: user.
Local setup: web uses port 3100; the existing Podman network is `10.89.0.0/24`, so API trust was
set to that actual subnet for these runs. No Railway deployment was performed. ADR 0007
follow-ups remain deferred.

Gate flakes fixed on 2026-10-21. These were load-related failures, and none was a product bug:

- The harness player now waits up to 2 s for WebKit's native-HLS answer.
- Compose Postgres runs with `max_connections=400` (`POSTGRES_MAX_CONNECTIONS`, applied by the
  entrypoint). The parallel suites peaked at the default of 100 and got "remaining connection slots
  are reserved". A restore needs at least the primary's value, and `restore.sh` now says so.
- Integration files that use a test database allow 30 s per test and 60 s for hooks: the suites
  run in parallel, and Postgres runs DROP DATABASE one at a time.
- The chat emote-only test waits for the settings frame on the other instance.
- Media VOD fixture rows are inserted after the upload, so the service's stale-VOD reconcile
  cannot finalize them first. The barrier tests fail fast instead of hanging.
- The chat filter latency test asserts p50 < 2 ms and p99 < 50 ms.
- The stack test tears down by label with `--depend`.
- `infra.ts test` now removes test containers and stacks older than 2 h and idle test databases
  created more than 2 h ago. Killed runs had leaked 4 running stacks, 22 containers and 60
  databases.

## Session eight (2026-10-20–21): E4c trust & safety (implemented; user validation pending)

ADR 0006's open questions resolved (native TypeScript PDQ/vPDQ, default classifier
`AdamCodd/vit-base-nsfw-detector` on ONNX Runtime for sexual content only, NCMEC drafted by the
platform and filed by a `legal` user, evidence sealed in append-only Postgres because Garage
cannot deny delete) and the license judgments recorded in ADR 0008. Both were accepted
2026-10-20.
**Contract step done** (head agent, on `main`, since pushed): spec, enums, migrations
0015/0016 with DB-enforced protections, hold CLI (`3d51fbc`); contracts with internal events,
moderation jobs and payloads, T&S entities, `moderation.*`/`ncii.*` procedures and 501 stubs,
`legal`/`safety-staff` access (`7501bb9`, `0e948da`); `moderationEnv` and the evidence keypair in
init-env (`f038c0e`); `packages/moderation` scaffold with the evidence seal implemented and
tested (`2813f99`); the worker-only Garage evidence bucket and key, evidence secrets scoped per
service in compose/Quadlet (`6377f0c`); `scripts/fetch-model.ts` with the pinned digest
(`5658eef`); unit briefs A–F (`738532e`). **Units A–F are reviewed and merged** on local `main`
(HEAD `132a402`, pushed). B, C and D had additional security reviewers; HIGH findings were
fixed and focused re-reviews passed. Final targeted checks: API integration 171/171 (13 files),
worker integration 68/68, media integration 23/23, web unit 677/677 plus typecheck/lint/build,
harness unit 289/289 plus typecheck/lint. The operator guide and production mounts are integrated;
hash lists mount read-only with an empty FOSS default, the ONNX model mounts read-only into API
and worker, and deprecated `HASH_MATCH_*` settings are removed. User validation remains: full
`bun run verify`, `bun run verify --scenario trust-safety`, image rebuilds, Storybook, browser and
Railway checks.

## Session six (2026-10-19): E4b money (in progress)

Manual adapter first, then Stripe against stripe-mock (PLAN.md E4b). Plan and units in
HANDOFF.md "Session six in flight" and `.claude/briefs/e4b/`.
Session seven (2026-10-20): all nine units (A–I) reviewed and merged — manual adapter, Stripe adapter, web pages, harness `e4b-money` (manual and `provider=stripe`), ledger/worker and ui follow-ups. E4b is code-complete; not yet run by the user: verify, e4b-money, Storybook, browser.

Paused 2026-10-20 at the user's request. On `main`: the contract step, migrations 0013–0014, the
operator role CLI, `packages/payments` scaffold, the spec `docs/testing/e4b-selectors.md`, and
the worker money jobs (expiry, renewal, hold release; reviewed, fix round merged). Built but not
merged (branches listed in HANDOFF.md "Resume point"): API checkout, API reports, web Support
dialog, harness `e4b-money`; web money pages unfinished. Not run live by the user yet.

## Session five (2026-10-18): E4a design system (in progress; resumed 2026-10-19)

Application design only (PLAN.md E4a). Mockup canvas: <https://claude.ai/artifact/Ve5J5XjRZV42eRE2cdReVd>
(29 boards). Units in `.claude/briefs/e4/`: U1 primitives (shadcn CLI 4.21.1, preset `b1ZhhFNpx`),
U2 shells/headers, U3 data blocks, U4 form blocks, U5 media/player/chat blocks, U6 page stories +
enforcement + apps/web migration. U1–U5 are now reviewed, merged and pushed to `main` at
`3b882054`. U1 brought in the primitives and gallery; U2 shells/navigation/headers; U3 data blocks
plus cataloged TanStack Table 8.21.3; U4 form/settings blocks; U5 media/player/chat blocks. Review
HIGHs were fixed and focused re-reviews passed. Targeted tests/typecheck/lint/format passed; UI
Storybook builds passed for U1, U2, U4 and U5. The aggregate unit-test command also completed
successfully during integration. U6b (apps/web migration + apps/web source-policy test) merged
2026-10-19 after review and re-review (`6d31d95`). U6a (board page stories + packages/ui
source-policy test) merged after review and re-review (`2a5c2c7`). U7 packages/ui follow-ups (new compositions,
allowlist cleared, `formatUnitCost`) merged ahead of its independent review at the user's request;
its review found no HIGH; the four MEDIUMs are fixed (`4c2829e`). E4a is complete pending the user's gate, Storybook and browser checks.

## Session four (2026-10-18): E3 slice built

All merged and pushed to `main`; live testing is the user's (HANDOFF.md "For the user to run").
Review was lighter at the user's request (HIGHs only, no re-review of fix rounds).

- **E3 built**: API relay lifecycle (retire/rejoin/drain/suspend), Go relay draining + heartbeat
  state machine, web `/relays` + player `data-source`, harness `e2e-relay` with a liar relay.
  Contract: `docs/testing/e3-selectors.md`. Milestone E3 is reached when the user's live
  `e2e-relay` run passes.
- P2P: `services/tracker` built; integrity judges P2P only on per-session evidence with a
  channel-wide per-network cap (ADR 0005, `KEYS.p2pChannelNet`).
- Legal drafts seeded by the migrate job; legal API; consent rate-limited.
- Next: E4 opens with the design-system track, then money (PLAN.md).

## Session three (2026-10-18): E2 slice built, review-gated

All merged after independent review (HIGH findings re-reviewed), pushed to `main`; live testing is
the user's (see HANDOFF.md "For the user to run").

- Worker integrity wiring merged (jobs, run locks, fetch evidence, viewer-count republish).
- API round 3: appeals, heartbeat floor, canonical IP hashes, `pinnedGet` deadline,
  `channels.get.viewer.following`. P2P source recording deferred until the tracker gives
  server-side swarm evidence.
- Shared `@commonair/safe-regex` with a sound cost model; chat filters re-validated on load and run
  in a worker pool with a hard timeout and quarantine.
- **E2 built**: directory home, follow button, chat moderation (web) + `e2e-social` scenario with a
  tmi.js bot through the IRC gateway (harness). Contract: `docs/testing/e2-selectors.md`.
  Milestone E2 is reached when the user's live `e2e-social` run passes.
- Contracts/config: auth routes, appeal subjects, `ircEnv`, `ORIGIN_ISSUANCE_ENABLED`; harness
  Mailpit basic auth for Railway staging; IRC health port published.

## Session two (2026-10-18): end-to-end first

**Milestone E1 reached locally:** `bun scripts/infra.ts stack && bun harness/src/cli.ts run e2e-basic`
passes (web sign-up + email verification, stream key, RTMP publish, Chromium signed-in + WebKit
anonymous playback, chat both ways, offline). First run: TTFF 1.0 s (Chromium) / 1.8 s (WebKit),
glass-to-glass 2.1 s / 3.9 s. `verify --full` and `--scenario` now bring the platform up and install
browsers; CI on main runs `verify:full`.

Landed this session (all reviewed before merge, gate green):

- Infra (2I) merged: WAL-G push under a timeout (DROP DATABASE hang), Garage + migrate in the
  test subset, `infra.ts stack`, `init-env --merge`, tracker behind the `p2p` profile, fixed compose
  subnet trusted for `x-forwarded-for`.
- Web app (3A-e1): TanStack Start on Bun, `/api` + `/rpc` proxy, sign-up/in, dashboard, channel
  page (hls.js / native HLS + heartbeats), chat, embed. Contract: `docs/testing/e1-selectors.md`.
- Harness `e2e-basic` + fix: API-path sign-ups now verify via web-origin links.
- DB: integrity scan indexes (0006), users identity immutability trigger (0007), appeals subject
  index (0008). Storage: presigned PUT signs content type and length.
- Config: media disk budget / ladder cap, `OUTBOUND_ALLOW_PRIVATE_NETWORKS`.

Also merged after review: API (2A) rounds one and two, integrity (2H2) and media (2E) review
fixes, web review fixes. Open: worker integrity wiring (branch `worktree-agent-a07b926d662d5d4bd`,
WIP), API round 3 and the contract requests listed in HANDOFF.md.

## Handoff status (end of session one, 2026-10-18; superseded by HANDOFF.md)

`main` at the handoff commit passes the full `bun run verify` (format, lint, typecheck, unit,
integration, licenses, domains, reuse, relay). All units below are merged except infra.

| Unit                       | Branch (`worktree-agent-…`)      | Merged                                | Open items (not done)                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | -------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2A api-core                | a6c3e9d45066950e6                | yes                                   | **API review (see HANDOFF): ReDoS-capable filter check, minors can edit birthDate**, category mature gate, third-party image URLs, better-auth admin endpoints unaudited, rate-limit subject behind proxy / IPv6 /64, relay+simulcast URL SSRF, upload size, per-recipient mail limits, interim verify too fast; `BUS.userControl` publishing; `developer.tokens.list/revoke`; TOTP integration tests |
| 2B chat                    | a10faca9017b35f37                | yes                                   | README for round-two behavior; test for OAuth revocation on an open socket                                                                                                                                                                                                                                                                                                                            |
| 2C irc                     | afc07554b4056edf3                | yes                                   | move `IRC_*` connection-limit env vars into `packages/config`                                                                                                                                                                                                                                                                                                                                         |
| 2D origin                  | a5d29e5776daab709                | yes (includes a `wip(origin)` commit) | integration tests for relay 401→429, CDN URIs without `t=`, HEAD not recorded; multi-replica issuance integration test; `ORIGIN_ISSUANCE_ENABLED` and `ISSUANCE_KEYS` into config/contracts                                                                                                                                                                                                           |
| 2E media                   | a910b90d0855b019d                | yes                                   | stale `processing` VOD reconcile; crash recovery of recordings + work-dir sweep; global disk budget; transcode slot limit; simulcast SSRF + protocol whitelist + generic errors; simulcast key out of argv; thumbnail history cleanup                                                                                                                                                                 |
| 2F relay                   | af349641b1a04d351                | yes                                   | none                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2G ui                      | a346bf0796b847ef4                | yes                                   | wire `test:node` into verify                                                                                                                                                                                                                                                                                                                                                                          |
| 2H1 ledger + patronage     | a0f0430ca5204e3c7                | yes                                   | READMEs for payout clearing, hold lots, `postReversal`, period close; callers must use the new APIs                                                                                                                                                                                                                                                                                                   |
| 2H2 governance + integrity | a3375f41100c11fad                | yes (governance fixes)                | **all integrity review items** (fetch-less bots, stream-hour eligibility, appeal stickiness, false positives, relay suspension, scale + indexes — exact SQL in HANDOFF); `subscriptionQualifies` unit test; `closeElection` test                                                                                                                                                                      |
| 2I infra                   | a856cff1eae87abf9 (head 0b1f3f9) | **no**                                | blocks on: WAL-G `archive_command` hangs when Garage is down, which makes `DROP DATABASE` hang (signal barrier) — needs a timeout wrapper and Garage in the test subset; `scripts/infra.ts` TEST_SERVICES change; compose needs the new infra env vars (now in `.env.example`)                                                                                                                        |
| 2J harness                 | a39c0557744e767c7                | yes                                   | export better-auth routes + ALTCHA field name from contracts; document heartbeat counters as deltas                                                                                                                                                                                                                                                                                                   |
| 2L worker                  | ad54ee1f3dbd2b43b                | yes                                   | decision: `chat:read` events bind to the subscriber's `user_id` (Twitch semantics), kept                                                                                                                                                                                                                                                                                                              |
| 2M email + OTel            | a9ba774c6001ac6db                | yes                                   | none                                                                                                                                                                                                                                                                                                                                                                                                  |

## Next

See HANDOFF.md: Milestone E1 (sign up → go live → watch → chat, end to end) first.

## Previous next steps

- Integrate each Phase 2 branch as it lands: merge locally, reconcile `bun.lock`, apply contract
  requests, `bun run verify`, reviewer subagent, commit, push.
- Then the first end-to-end bring-up (`podman compose up` + harness `ingest-rtmp`, `viewers`).
- Phase 3 briefs (web app, money, developer platform, channel bot, co-op, integrity pipeline,
  trust & safety, compliance, operations).
