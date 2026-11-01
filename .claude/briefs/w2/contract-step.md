<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W2 contract step (batch 6)

The orchestrator lands this as one commit on `main` (implement → independent review → fix), pushes,
and waits for CI green before wave 1. Decisions are [`batch6/README.md`](../batch6/README.md)
(a)–(r). Line numbers are from `8fc2c974`; recheck them. Follow `.claude/skills/schema-change/SKILL.md`
for the database. Nothing here implements a feature: it creates the shapes, tables, seams, stubs
and scaffolding the nine units build on, so that no two units ever write the same file.

## 0. Where the code differs from the plan

- `PaymentMeta` v2 already landed in W1 (`packages/ledger/src/meta.ts:16-73`) and
  `services/worker/tests/e6-fixtures.ts` already uses it: nothing to convert.
- `PayoutRulesSetting` is at `packages/contracts/src/shapes.ts:269-275`; its seed is
  `packages/db/src/seed.ts:63`.
- `playback.start` returns `captions: []` at `services/api/src/routes/playback.ts:248`.
- The heartbeat field is `playbackMode` (with `behindLiveSeconds`), not `mode`
  (`packages/contracts/src/api/entities.ts:303-306`); it is not recorded today
  (`routes/playback.ts:276-287`).
- Origin dispatch lives in `services/origin/src/origin.ts:145-150`, not `handler.ts`.
- The clause catalog exists: `CLAUSES` in `packages/moderation/src/reasons.ts:45`, `clauseRef` at
  `:76`. ADR 0019 decision 1 rejects `policy_rules`: use `rule_ref` (decision (d)).
- The go-live path is `mediaReady` in `services/api/src/media/hooks.ts:87-139` (it inserts the
  broadcast, sets `channels.liveBroadcastId` at `:118` and writes the `stream.online` outbox event
  at `:120`), not `routes/stream.ts`.
- `IntegritySummary` (`entities.ts:1065-1073`) has float viewer-hours and a free-string `signal`.
- The latest migration is `0041_w1_indexes.sql`.

## 1. Contracts (`packages/contracts`)

### 1.1 Enums (`src/enums.ts`)

- `BROADCAST_KINDS = ["live", "rehearsal"]`.
- `APPEAL_SUBJECTS` (`:106`) gains `exclusion_group`.
- `SPLIT_BASES` (ADR 0013: which revenue kinds a split covers) and `SPLIT_STATUSES`
  (`proposed | accepted | ended | rejected`).
- `CAPTION_TRACK_STATUSES`, `ATTESTATION_KINDS` (`broadcast | supersede | reissue`, decision (r)), `EXCLUSION_CATEGORIES`
  (the category enum `IntegritySummary` and analytics use), `PLAYBACK_MODES` already exists (`:373`).

### 1.2 Shapes (`src/shapes.ts`)

- `PayoutRulesSetting` gains `splitShortfallWriteOffDays` (int, default 365) and
  `splitNewRecipientHoldDays` (7) and `splitRecipientMinAccountAgeDays` (30) (decision (i)).
- Channel settings: `captions {enabled, spokenLanguage, maskWords}` and `dvr {enabled, windowSeconds}`
  (full shape with defaults, patch shape without, following chat settings at `:33-37`).
- Governance setting `captions.defaultEnabled` (boolean, ordinary, seeded false).

### 1.3 API (`src/api/entities.ts`, `src/api/router.ts`)

- `money.splits.{list, propose, accept, reject, end}` under the money router (`:1114`); scope
  `channel:manage:splits` (`src/scopes.ts`).
- `stream.rehearsal.{arm, disarm, status, invite, report}`.
- `analytics.{broadcast, range, exclusions, pnl}` and `analytics.shareLink.{create, revoke}`.
- `integrity.attestations.{list, get, share}`; `integrity.keys.compromise` (admin, audited,
  decision (r)); a public verifier route and `/.well-known/commonair-attestation` (keys and `kid`s),
  served under oRPC's `/api` prefix (`services/api/src/http.ts:310`) and reached through a Caddy
  `handle /.well-known/commonair-attestation` rewrite (§4).
- `money.treasurer.splits.{proposeWriteOff, approveWriteOff, releaseSuspense, forfeitSuspense}`
  (ADR 0013 decisions 6, 7); `TransparencyMonth` (`entities.ts:1031`) gains `splitSuspense`.
- `transparency.enforcement` — a new top-level `transparency` key (public), input
  `{window: "30d" | month}`, output per-rule counts, automated split, overturn rate, suppressed
  cells marked (k = 10).
- `vods.captions.{get, update}` (`:792`); `Vod` gains `captions` (track list).
- `PlaybackStart` (`:243-278`) gains `dvrWindowSeconds` (int ≥ 0, 0 = no DVR) and `dvrPlaylistUrl`
  (nullable); `captions` stays and gets real values from W2-captions.
- `IntegritySummary` becomes integer seconds and `category` from `EXCLUSION_CATEGORIES`
  (decision (k)); update the one stub.
- DVR and captions playback: `playback.heartbeat` output gains `dvrToken?` (DVR tokens last 120 s);
  `PlaybackStart.captionsState: "off" | "queued" | "active"`; the public viewer count gains a
  catching-up figure (ADR 0016: "the public count shows both numbers"); `instance.info` exposes the
  DVR cap to the web.
- Replay (wave 2): `Clip.windowStartedAt` (clips are MP4s with no wall-clock in the stream);
  `ChatReplayInput` (`router.ts:57-61`) gains an optional `from: Timestamp` so a seek deep into a
  long VOD is one request.
- `appeals.create` accepts `exclusion_group` with `{broadcastId, category}`.
- `transparency.enforcement` rows carry `clauseTitle` (the web has no clause catalog; titles come
  from the API, as in `apps/web/src/i18n/README.md`).
- ADR 0019 acceptance answer 3: `safety.resolve` and `safety.suspend` staff inputs gain a required
  `clauseId`, and those actions write their statement and `rule_ref` (W2-enforcement-report fills
  the writes; the inputs land here).
- `stream.rehearsal.watch({channel}) → {playlistUrl, token, expiresAt}` for invitees
  (`playback.start` resolves only `liveBroadcastId`); `playback.heartbeat` accepts a rehearsal
  session.

### 1.4 Events (`src/events.ts`) and internal (`src/internal.ts`)

- Events: `channel.split.update`, `analytics.rollup.ready`, `integrity.attestation.appended`,
  `rehearsal.armed`, `rehearsal.ended` (internal only, never offered to apps).
- Job payloads: `BroadcastRollupJob {broadcastId, reason: "offline" | "rescore" | "test"}` and
  `IntegrityAttestationJob {broadcastId, reason: "rollup" | "recheck" | "reconcile" | "test"}`;
  internal event `integrity.sessions.rescored {broadcastId}`.
- `SegmentFetch` (`internal.ts:314-328`) gains `mode: "live" | "dvr"` (optional, absent = live).
- `KEYS.rehearsalArmed(channelId)` (`internal.ts:142`) and `KEYS.rehearsalReport(broadcastId)`
  (worker writes, api reads).
- Internal test hooks (the `streamHours` pattern, `internal.ts:595`): run the rollup and the
  attestation job now with a settle override; bypass the 24 h analytics display delay. Harness only.

### 1.5 Tokens (`src/tokens.ts`, `src/storage.ts`)

- `dvrTokenPath` and a `dvr/<vodId>` state predicate in `storage.ts` (ADR 0016 decision 2; it
  refuses rehearsal broadcasts); the playback token's
  `dm` refine (`tokens.ts:48`) rejects `dvr/` paths, mirrored in `relay/internal/tokens/playback.go:131`.

## 2. Database (`packages/db`)

### 2.1 `0042_w2.sql` (generated from schema changes)

- **Splits:** `revenue_splits` (channel, version, status, basis, created/accepted/ended),
  `revenue_split_shares` (split version, recipient user id, bps), `revenue_split_acceptances`,
  `revenue_split_postings` (link: split version ↔ ledger transaction). Ledger transaction kinds
  `split_shortfall_writeoff`, `split_suspense_release`, `split_suspense_forfeit` (find where the kind
  enum lives).
- **Captions:** `broadcast_caption_tracks`, `caption_edits` (`editor_user_id`); covered by
  `services/worker/src/deletion` (pseudonymize editors).
- **Analytics:** `broadcast_audience_minutes` (90-day retention), `broadcast_costs`,
  `analytics_share_links`.
- **Attestations:** `integrity_signing_keys` (kid, algorithm, public key, `first_used_at`,
  `retired_at`, `compromised_at`, as ADR 0014), `integrity_attestations` (seq, kind, broadcast id, payload, signature, kid,
  `prev_hash`, `entry_hash`).
- **Enforcement:** `rule_ref text` on `moderation_cases`, `appeals`, `mod_actions`.
- **Group appeals:** `appeals.exclusion_category` (non-null if and only if `subject_type =
  'exclusion_group'`).
- **Split write-offs:** `split_writeoff_proposals` (the two-approver trigger's subject).
- **DVR / playback:** `channels.dvr_enabled` (default true), `channels.dvr_window_seconds` (default
  1800); `playback_sessions.playback_mode`, `playback_sessions.dvr_seconds`.
- **Rehearsal:** `broadcast_kind` enum, `broadcasts.kind` (default `live`), `rehearsal_invitees`
  (broadcast or arm id, user id, at most 5).
- Channel settings JSON for captions/dvr if they live in the settings blob rather than columns —
  pick one and say which in the commit.

### 2.2 `0043_w2_protections.sql`

- Splits: immutable once a posting links to it; accepted shares freeze; bps per basis ≤ 10,000;
  a link row must point at a payment whose metadata `splitVersionId` matches.
- `split-suspense` debits only by the two allowed kinds and only with an `audit_log` row in the
  same transaction; the write-off needs two distinct approvers (model: `0021_coop_protections.sql:16`).
- `integrity_signing_keys`: append-only except `retired_at` and `compromised_at`, each set once.
- `integrity_attestations`: append-only; refuse a `seq` that is not head + 1, a `prev_hash` that is
  not the head's `entry_hash`, a retired or compromised `kid`, and a second `broadcast` entry for one
  broadcast.
- `rule_ref` format CHECK (`^[a-z][a-z0-9.-]*@[0-9]+$`, check against real ids) and
  `rule_ref is null or scope = 'platform'` on `mod_actions`.
- Rehearsal (decision (f)): refuse rehearsal broadcasts in `stream_hours`, ledger postings that
  reference a broadcast, patronage inputs and `integrity_attestations`; refuse `channels.live_broadcast_id`
  pointing at a rehearsal.

### 2.3 Seed

- `captions.defaultEnabled = false`; the payout rules additions; the three chart entries.

## 3. Shared code

- **Ledger chart** (`packages/ledger/src/accounts.ts:28-81`, `:118-132`): `asset:receivable:split-shortfall:<uuid>`,
  `liability:split-suspense:<uuid>`, `expense:split-shortfall-writeoff`. `meta.ts` stays as is.
- **`packages/integrity/src/constants.ts`** (new): `DEFAULT_FINALIZE_SECONDS = 3600` (replace the
  inline `?? 3600` at `jobs.ts:215`), `AUDIENCE_SETTLE_SECONDS = 7200`, `RULESET_VERSION`; a unit test
  that settle ≥ finalize + the stream-hours interval + its run limit
  (`services/worker/src/integrity/jobs.ts:46`).
- **`packages/integrity/src/rescore.ts`** stub (re-exported from `index.ts`) and a
  signal → `EXCLUSION_CATEGORIES` map in `constants.ts`, shared by the worker rollup and the API.
- **`packages/tokens/src/attestation.ts`** (ADR 0014 lines 82-110; header
  `AGPL-3.0-or-later OR Apache-2.0`, WebCrypto only, no imports from `index.ts`, exported as
  `./attestation` in `package.json`; decision (q)): the `{payload, signature}`
  envelope in base64url, integer figures only, `kid` derived from the public key, `entryHash` =
  SHA-256 over the payload bytes, `reasonsCommitment`; `sign`, `verify`, `canonicalize`.
  `vectors.json` gains an `attestation` section with canonical-bytes and tamper cases, tested in
  `packages/tokens` (and in Go only if the relay ever verifies; it does not this batch).
- **`packages/sdk`**: add the `@commonair/tokens` workspace dependency (decision (l)) and extend
  `scripts/build.ts` (`:23`, `:119`, `:147`) to copy and licence-check `attestation.ts`; the helper
  file itself is W2b-attestations'.
- **`packages/sim`** skeleton (new, AGPL): `package.json`, tsconfig, workspace entry, an empty
  `src/index.ts`; `@commonair/sim` in `services/worker/package.json`. W2-rehearsal fills it.
- **`packages/chat-filter`** (new): move `services/chat/src/filter-{runner,worker,protocol}.ts`
  with what they import from `content.ts` (`applyFilters`, `CompiledFilter`, `FILTER_BUDGET_MS`) and
  `types.ts` (`WordFilterDef`); repoint `core.ts`, `pipeline.ts`, `server.ts` and the tests; keep
  `WORKER_URL` resolving through `import.meta.url` (`filter-runner.ts:93`). Behaviour unchanged.

## 4. Seams

- **Origin route registry** (`services/origin/src/origin.ts:145-150`): a `{prefix, handle}` list
  that `dvr.ts` and `captions.ts` register into at startup; `paths.ts:25-73` gains `vtt` (and
  subtitle playlist) and `dvr` request kinds; export the `SegmentLog` hook so registered routes
  account fetches. Stub `dvr.ts` and `captions.ts` register a 404 handler.
- **Media session hooks** (`services/media`): a registry of `{onStart(session), onEnd(session)}`
  called beside the ladder in `service.ts` / `session.ts`; `captions/index.ts` registers a no-op.
  Captions use their own `SlotLimiter` (`transcode/slots.ts:22`).
- **Rehearsal gate** (`services/api/src/media/hooks.ts`): `mediaAuth` accepts an armed rehearsal
  (`KEYS.rehearsalArmed`); `mediaReady` inserts `kind = 'rehearsal'`, sets no `liveBroadcastId`,
  writes no `stream.online` (and `mediaDone` no `stream.offline`), skips simulcast. Integration test
  that the N1 go-live fan-out, EventSub, goals and `stream_hours` see nothing (decision (f)).
- **Rehearsal side effects** (decision (f), (g)): rehearsal VODs are created `private` with
  `expiresAt = now + 24 h` (`services/media/src/lifecycle.ts:205`, `vod/finalize.ts:303`); a T0 hit
  ends an open rehearsal broadcast without `stream.offline` (`services/api/src/moderation/live.ts:52`
  `endLiveInTx`, and the worker's broadcast-ending path in `services/worker/src/moderation/records.ts`);
  `mediaNotReady` (`hooks.ts:152`) handles a rehearsal too.
- **Chat dry run** (`services/chat/src/dry-run.ts`, internal route): runs the full send pipeline
  for a synthetic sender and returns accepted, held or rejected without broadcasting or saving, so
  simulated rehearsal chat never reaches the channel's public chat or replay.
- **`playback.ts`**: leave the DVR fields for W2-dvr (it owns every new line here); return
  `dvrWindowSeconds: 0, dvrPlaylistUrl: null`, `captionsState: "off"`, and
  `captions: await captionTracksFor(b)` from a stub `services/api/src/captions/tracks.ts` (returns
  `[]`). Also stub `services/api/src/captions/handlers.ts` (`vods.captions.{get,update}`) and wire
  `Vod.captions` into `routes/vods.ts`; W2-captions writes only `services/api/src/captions/**`.
- **Player seam** (`apps/web/src/player/controller.ts`, frozen for units): `enterDvr(playlistUrl):
  Promise<boolean>` and `exitDvr()` on the same hls.js instance (heartbeats and played seconds carry
  on); while in `dvr` mode pass `behindLiveSeconds` (now − `playheadWallclock()`) to `playbackFields`
  (`:705`); refresh the DVR token from the heartbeat. `player.tsx` gains slots for the captions toggle
  and the DVR controls.
- **Integrity and counters** (orchestrator files): `packages/integrity/src/jobs.ts:115` selects
  `playback_mode` into `LiveSession.mode`; `services/worker/src/counters.ts:57` counts only
  `playback_mode = 'live'` as live viewers and adds the catching-up count.
- **Channel settings handler**: saving `captions` and `dvr` settings clamps the window to
  `DVR_MAX_WINDOW_SECONDS` and validates mask words with the existing safe-regex check; a mount for
  the DVR settings component on the studio stream settings page.
- **`packages/captions`** skeleton (model entry for `fetch-model`) and workspace deps:
  `@commonair/captions` in `services/{media,origin,api}`, `@commonair/chat-filter` in `services/media`.
- Captions VOD tracks live under the recording prefix: check that `vod-finalize`'s `moveVodObjects`
  moves every object under it and that a late caption write cannot race the move (fix it here if not).
- **Caddy** (`infra/caddy/Caddyfile` near `:205`): `handle /dvr/*` to origin;
  `handle /.well-known/commonair-attestation` rewritten to `/api/.well-known/commonair-attestation`; captions `.vtt` under
  the existing media handle if the path allows.

## 5. API, worker and web scaffolding

- **Route files with `notImplemented` stubs** (one per unit, so units own disjoint files):
  `routes/{analytics,rehearsal,transparency,attestation-verify}.ts`, `money/splits.ts`,
  `transparency/enforcement.ts`, `stream/rehearsal.ts`, `analytics/appeals.ts` (stub).
- **Worker job stubs** registered in `src/jobs/index.ts` under `// Feature wins, wave 2 (W2).`:
  `broadcast-rollup`, `integrity-attestation`, `rehearsal-driver`; the delayed `broadcast-rollup`
  enqueue on `stream.offline` in `outbox.ts` (rollup implements the job body); `integrity-attestation`
  enqueued on `analytics.rollup.ready`; `broadcast-rollup` (`reason: "rescore"`) on
  `integrity.sessions.rescored`; a daily attestation reconciler schedule.
- **Group-appeal wiring** (`routes/appeals.ts`): `exclusion_group` in `KIND_SUBJECTS.integrity`
  (`:88`); `create` (`:588`) calls `createGroupAppeal` and `resolve` (`:670`) calls
  `onGroupAppealResolved` from the `analytics/appeals.ts` stub.
- **Config** (`packages/config/src/env.ts`, `.env.example`, a test keeps them in sync):
  `CAPTIONS_MAX_STREAMS` (int ≥ 0, default 2, media), `WHISPER_URL` (media), `DVR_MAX_WINDOW_SECONDS`
  (default 7200, api + origin), `INFRA_COST_MODEL` (JSON, worker + api), `INTEGRITY_SIGNING_KEY`
  (`__generate_ed25519__`, worker only, `init-env` handles the placeholder). Regenerate the self-host
  key lists: `bun scripts/selfhost/unit-env.ts`.
- **Web**: placeholder routes `_studio/{crew,captions,analytics,rehearse}.tsx`,
  `_app/$channel_.vods.$vodId.tsx`, `_app/$channel_.clips.$clipId.tsx` (`$channel_` opts out of nesting under `$channel.tsx`, which renders no `<Outlet/>`; a nested `$channel.vods.…` file would never render; see `docs/testing/w2-selectors.md`); nav entries; empty namespaces
  `w2-splits`, `w2-captions`, `w2-analytics`, `w2-enforcement`, `w2-dvr`, `w2-rehearsal`,
  `w2-attestations`, `w2-replay` (`en` and `es` `{}`, `bun run i18n:gen`); a public attestation
  verifier page placeholder (`_app/attestations.verify.tsx`, with its `SEED_ROUTES` row); stub
  `components/attestations/panel.tsx` and `components/analytics/group-appeal.tsx` (render `null`)
  so wave 1 can mount them without writing into wave 2's paths; mount an empty
  `EnforcementReport` slot on `routes/_app/transparency.tsx`; `SEED_ROUTES` rows for every new route
  (`harness/src/seed/routes.ts`; seed-media publishes `vodId` and `clipId` in `store.extra`).

## 6. Harness and CI

- `harness/src/w2/steps.ts`: `W2_EXTENSIONS` and `PENDING_W2_*` lists (W1's `harness/src/w1/steps.ts`
  pattern), wired into `e4b-money`, `integrity-basic`, `trust-safety` and `timeline-sync`; each
  unit fills its own `harness/src/w2/<unit>.ts`.
- Scenario stubs `captions`, `live-dvr`, `rehearsal` (pending steps), `inFull` true, in
  `FULL_REQUIRED`; a `captions` shard in `harness/src/shards.ts` and the CI matrix, selected by
  `scripts/ci-changes.ts` when changes reach captions, media or origin code, and always on the
  nightly schedule (decision (c)); `live-dvr` and `rehearsal` into the shard that keeps every shard
  under ~12 minutes.
- `.github/actions/setup/action.yml`: per-model fetch flags so the captions weights are fetched
  only by jobs that need them.

## 7. `docs/testing/w2-selectors.md`

Routes, test ids and scenario steps every unit builds against (crew, captions studio and player
toggle, analytics, enforcement report, DVR scrubber and "back to live", rehearsal arm and report,
VOD and clip watch pages, the replay panel), checked by `apps/web/tests/selectors.test.ts` with a
`PENDING_W2_IDS` list emptied as units merge.

## 8. Done means

`bun run verify` green in CI on the pushed commit; every stub returns `notImplemented` or a
pending harness step; no unit-owned behaviour implemented here; PROGRESS "In flight" gets the
batch 6 paragraph.
