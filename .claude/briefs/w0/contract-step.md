<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W0 contract step (orchestrator)

The orchestrator lands this in one commit on `main` before any W0 unit starts (feature-wins §5,
"Contract step first, every wave"; AGENTS.md "Repository map and ownership"). Every path and line
below was checked at `9c51c93`. The E7 contract step and the E7 merges land first, so recheck
line numbers in `packages/contracts/src/api/router.ts`, `enums.ts`, `entities.ts`,
`harness/src/safety.ts`, `harness/scenarios/trust-safety.ts` and `services/worker/src/moderation/**`
against the E7 merge commit before editing.

Matches three ADRs as accepted on 2026-10-27 (each records its answers under "Decisions at
acceptance"): [ADR 0012](../../../docs/decisions/0012-media-clock.md) (part 1),
[ADR 0019](../../../docs/decisions/0019-statement-of-reasons.md) and
[ADR 0009 amendment 1](../../../docs/decisions/0009-public-media-route.md#amendment-1-vod-objects-stay-private-until-published).
Counsel has not reviewed ADR 0019 or its notice text; nothing here says otherwise.

## Order

1. All three ADRs accepted (done 2026-10-27; answers recorded in each ADR).
2. E7's contract step is merged (it is, `3bacecb` and `66e95da`; its migrations end at
   `0026_e7_active_termination`), and **E7-appeals and E7-dmca are merged**. E7-appeals owns
   `services/worker/src/moderation/**` in wave 1 (lift ban on overturn, `ncii-hash` hashes
   `broadcast` items); W0-media-exposure edits four files there (VOD prefix lines only), W0-sor adds
   `sor-*` files there, and this step touches `moderation/objects.ts:43`. E7-dmca uses the trust
   email templates (`packages/email/src/templates/trust.tsx`, `registry.ts`, `messages/en.ts`,
   `samples.ts`) that W0-sor extends, and moves VOD objects to and from `moderation/dmca/` in
   `services/worker/src/dmca/**` with the `vodPrefix` this step wraps (W0-media-exposure then edits
   those VOD-prefix reads, and `vodPlacement` leaves DMCA-hidden VODs alone, A.1). Both E7 units add
   `trust-safety` steps (8 and 9), which section D numbers after. The other E7 units (chat-http, admin, coop, legal) share no file with W0 or this
   step and may still be in flight; if E7-legal is, leave `packages/db/src/legal/index.ts` (B.6)
   until it merges or confirm it does not touch that file.
3. This contract step, one commit, `bun run verify` green.
4. Launch W0-clock, W0-integrity, W0-media-exposure, W0-sor (with P1-tracker and P1-turn: six)
   only once all of E7 has merged (wave 2 starts after wave 1; W0-sor also edits
   `services/worker/src/exports/collectors.ts`, E7-dmca's in wave 1).
   Record each under "In flight" in `PROGRESS.md` with its owned paths (from each brief).

## A. Storage layout (ADR 0009 amendment, decisions 1, 2 and 4)

1. **New `packages/contracts/src/storage.ts`**, exported as `"./storage"` in
   `packages/contracts/package.json` (`exports`, :7-19). Contents:
   - `PUBLIC_MEDIA_PREFIXES` moved from `services/origin/src/media.ts:17` (same value:
     `["channels", "clips", "thumbnails", "vods"]`). `media.ts` imports it instead (one import line;
     the file is W0-media-exposure's afterwards).
   - `VOD_PUBLIC_PREFIX = "vods/"`, `VOD_PRIVATE_PREFIX = "recordings/"`,
     `type VodPlacement = "public" | "private"`, `vodPrefix(vodId, placement)` returning
     `vods/<id>/` or `recordings/<id>/`, and `isVodOwnPrefix(vodId, prefix)` (true for exactly those
     two strings: retention and every reader use it).
   - `VOD_PLAYLIST = "index.m3u8"` (today duplicated at `services/media/src/vod/recorder.ts:24` and
     `services/api/src/routes/vods.ts:28`).
   - `VodPlacementState` (`status`, `visibility`, `removedReason`, `broadcastRestricted`,
     `channelSuspended`, `nciiHidden`, `dmcaHidden`) and the pure
     `vodPlacement(state): VodPlacement | "leave"`: `public` only when ready, `visibility = public`,
     no `removed_reason`, broadcast not restricted and channel not suspended; `"leave"` when a hidden
     NCII item covers the VOD, when a DMCA item covering it has its objects hidden and not restored
     (E7-dmca's `dmca-disable` moves them to `moderation/dmca/<original key>` and `dmca-restore`
     moves them back to the same keys, so placement must not move them meanwhile), and when
     `status = 'deleted'` (nothing left to move); `private` otherwise, including any
     `removed_reason` (`dmca` too). These are ADR 0009 amendment 1 decision 3's rules as accepted.
     Unit tests cover every row (`packages/contracts/tests/storage.test.ts`).
   - `VOD_ROUTE = "/vod/"`, `vodTokenPath(vodId) = "vod/<vodId>"` (the `PlaybackClaims.path` a VOD
     token carries; no MediaMTX path can equal it, they all start `live/`), and
     `VOD_TOKEN_MAX_TTL_SECONDS = 12 * 60 * 60`. A constant, not an env variable (accepted: 12 h,
     no refresh).
   - Document the token reuse in the `PlaybackClaims` comment (`packages/contracts/src/tokens.ts:19-34`):
     `path` is a MediaMTX path **or** `vod/<id>`; the relay and the live `/hls` route refuse the
     latter by path mismatch (`services/origin/src/auth.ts:44`, `relay/internal/tokens/playback.go:179`). No crypto or vector change.
2. **Replace the local copies with the contract** (behaviour unchanged: `vodPrefix(id, "public")`).
   The contract's `placement` argument is required, so each local copy becomes a one-argument
   wrapper, `export const vodPrefix = (id: string) => contractVodPrefix(id, "public")`, not a bare
   re-export (the callers below pass one argument and must keep compiling; W0-media-exposure
   removes the wrappers). `VOD_PLAYLIST` is a plain re-export. Files:
   `services/media/src/vod/recorder.ts:23-24` (re-export from the contract so the media imports at
   `clips.ts:26`, `lifecycle.ts:16`, `recovery.ts:26`, `vod/finalize.ts:28` keep compiling),
   `services/worker/src/housekeeping.ts:87-88`, `services/worker/src/moderation/objects.ts:43`.
   W0-media-exposure then changes what callers pass.
3. **Media clock hook in the recorder** (ADR 0012 decision 4). In `services/media/src/context.ts`
   add `clock: ClockAnchor` to `MediaContext` (:18-51) with the interface in a new
   `services/media/src/clock/anchor.ts`:
   `interface ClockAnchor { offsetMs(broadcastId: string, runId: string): number }` plus
   `IDENTITY_CLOCK` returning 0, and set `clock: IDENTITY_CLOCK` where `services/media/src/service.ts:168`
   builds the context (and in the media test helpers). In `recorder.ts`, keep each local segment's
   raw `startedAt` and its `runId` (the run id is the segment file prefix, `args.ts:202`), and apply
   `ctx.clock.offsetMs(broadcastId, runId)` wherever a wall-clock time leaves the recorder: when
   `pollOnce` (:160-177) sets `recordingStartedAt`, in `localWindow` (:133-146), and when `upload`
   renders the VOD playlist (:220-224, re-rendering every published segment so re-anchored runs are
   re-stamped). Unit tests with a fake anchor. W0-clock implements the anchor; W0-media-exposure owns
   the rest of `recorder.ts`.
4. **Caddy**: in `infra/caddy/Caddyfile`, next to `handle /media/*` (:189-192), add
   `handle /vod/* { reverse_proxy origin:3003 }`, and the route in `infra/tests/caddy.test.ts`
   (route table :37-40). The selfhost bundle ships the same Caddyfile, so self-hosters get it.

## B. Statements of reasons (ADR 0019)

1. **Enums** (`packages/contracts/src/enums.ts`): `"enforcement_notice"` appended to
   `LEGAL_DOCUMENT_KINDS` (:166). New: `ENFORCEMENT_CONTENT_TYPES`, `ENFORCEMENT_RESTRICTION_KINDS`,
   `ENFORCEMENT_RESTRICTION_DETAILS`, `ENFORCEMENT_SOURCES`, `ENFORCEMENT_AUTOMATED_DECISIONS`,
   `ENFORCEMENT_GROUNDS`, `ENFORCEMENT_FACT_CODES` (`classifier`, `moderator_review`,
   `ncii_notice`, `hash_match`), `ENFORCEMENT_DELIVERY_CHANNELS` (`email`, `in_app`) with the
   values of ADR 0019 decision 4, and `ENFORCEMENT_SOURCE_ACTIONS`: the audit actions that may
   produce a statement (decision 3 table: `moderation.t1.restrict`, `moderation.t2.label`,
   `moderation.t1.upload_reject`, `moderation.case.warn`, `moderation.case.end_stream`,
   `moderation.case.suspend`, `ncii.decide`, `ncii.auto_hide`, `moderation.t0.match`). The doc
   comment says the builder (and the coverage sweep) keep only NCII-list `moderation.t0.match`
   rows (`details.listCategory = 'ncii'`): a CSAM-list match never produces a statement (accepted
   answer 1, counsel to confirm). Do **not** add a test comparing these strings with `MOD_ACTIONS`
   (the two vocabularies never overlap, so it proves nothing; ADR 0019 decision 3). The channel
   exclusion is proved by W0-sor's builder tests and the `trust-safety` step.
2. **Entity** in `packages/contracts/src/api/entities.ts` (next to `Appeal`, :830):
   `EnforcementFacts` (discriminated union on `code`, including
   `{ code: "hash_match", listCategory: z.literal("ncii"), capturedAt }` for T0 NCII-list matches)
   and `EnforcementStatement`, exactly the decision 4 shape (`content.type`, `restriction.{kind,detail,endsAt,territorialScope:"all"}`,
   `facts`, `source`, `automatedDetection`, `automatedDecision`,
   `ground.{kind,clauseId,clauseVersion,legalBasis}`, `documents.{guidelinesId,noticeId}`,
   `appeal: {kind:"moderation",subjectType,subjectId} | null`, `createdAt`). `clauseId` is
   `z.string()`, so the catalog stays in `packages/moderation` (W0-sor).
3. **Route** in `packages/contracts/src/api/router.ts`, inside `me` (:95), after `labels` (:184-191):
   `enforcement: { list: user.route({ method: "GET", path: "/me/enforcement", summary: "Statements of reasons about you", ...tag("Users") }).input(PageInput).output(page(D.EnforcementStatement.extend({ clauseTitle, explanation, noticeIsDraft, moderatorNote, appealId, reversedAt }))) }`
   (decision 8). A GET, so it stays readable while suspended (`services/api/src/lib/access.ts:82`
   blocks writes only).
4. **Handler stub**: new `services/api/src/routes/me-enforcement.ts` exporting
   `meEnforcement = { list: os.me.enforcement.list.handler(notImplemented) }`
   (`notImplemented` from `services/api/src/lib/errors.ts:36`), wired as `enforcement: meEnforcement`
   in `services/api/src/routes/me.ts` (the `me` object, :108). W0-sor owns the new file only.
5. **Schema** (`packages/db/src/schema/safety.ts`, after `auditLog` :66-85), via the `schema-change`
   skill:
   - `enforcement_statements`: the decision 4 columns, `facts jsonb`, no foreign keys to `users` or
     `channels` (`recipient_user_id`, `channel_id` plain uuids, like `audit_log.actor_id`),
     `source_audit_id uuid not null references audit_log(id)`, unique
     `(source_audit_id, recipient_user_id)`, index `(recipient_user_id, created_at, id)`.
   - `enforcement_statement_deliveries (statement_id → enforcement_statements, channel, sent_at,
     attempts, last_error_code)`, unique `(statement_id, channel)`; `last_error_code` is a code, never
     provider text (no addresses).
   - `audit_log_action_idx (action, created_at)` on `audit_log`.
   - Generate a named migration at the next free number after E7's. E7's contract step took
     `0024_e7_platform_debts`, `0025_e7_protections` and `0026_e7_active_termination`, so expect
     `0027_enforcement_statements` (unless an E7 merge added another), including the
     `legal_document_kind` enum value. Then a hand-written protections migration (expected
     `0028_w0_protections`) in the style of
     `packages/db/drizzle/0016_trust_safety_protections.sql`:
     - `enforcement_statements` append-only and no-truncate with `commonair_forbid_mutation()`
       (defined at `0001_protections.sql:25`; row-trigger pattern :100-106, no-truncate pattern
       :123-131);
     - a `legal_documents` guard rejecting UPDATE/DELETE of a row once `published_at <= now()`
       (allow the owner role, so the operator CLI can still fix a typo in an unpublished future
       version);
     - `commonair_configure_app_role` redefined from its latest version (E7's `0025_e7_protections.sql`,
       which extends `0021_coop_protections.sql:389-412` at `9c51c93`), adding
       `REVOKE UPDATE, DELETE ON public.enforcement_statements`, then re-run for the app role as the
       earlier migrations do, so the new tables are granted and the statement table is append-only
       for the app role too.

     Integration tests in `packages/db/tests` for each trigger and the revoked privileges.
6. **Seed**: register `enforcement_notice` in `SEED_META` (`packages/db/src/legal/index.ts:55-61`)
   from a new `packages/db/src/legal/enforcement_notice.md` holding only the draft banner, the
   placeholders and one heading per section; `requiresAcceptance: false`, `isDraft: true`. W0-sor
   owns that one `.md` file afterwards and writes the text.
   **Seed version** (settled at ADR 0019 acceptance). `seedLegalDocuments`
   (`packages/db/src/seed.ts:167-178`) inserts by `(kind, version)` with `on conflict do nothing`, and every kind shares
   `LEGAL_SEED_VERSION = "2026-10-18-draft"` with a past `publishedAt`. A database migrated between
   this step and W0-sor's merge (a dev database, the rc droplet) would keep the skeleton for ever,
   and B.5's guard would make it immutable. So give `enforcement_notice` its own version constant
   (`ENFORCEMENT_NOTICE_SEED_VERSION`, an optional per-kind `version` in `SEED_META`; bumping
   `LEGAL_SEED_VERSION` would force everyone to re-accept the terms). Bump it at W0-sor's merge
   if the skeleton reached any persistent database. Extend `packages/db/tests/seed.int.test.ts`
   (:28, :79 compare kinds with `LEGAL_DOCUMENT_KINDS`).
7. **Jobs**: `MODERATION_JOBS` (`packages/contracts/src/internal.ts:278-290`) gains
   `sorBuild: "sor-build"`, `sorCoverage: "sor-coverage"`. New stub
   `services/worker/src/jobs/moderation-sor.ts` exporting `sorJobs: JobDefinition[]` (both
   schedules from decision 5: every 15 s and daily; handlers that return `{ notBuilt: 1 }`),
   registered in `services/worker/src/jobs/index.ts` (`JOBS`, :41-72). W0-sor owns the stub file.
8. **Appeals while suspended** (ADR 0019 answer 2): exempt `appeals.create`, and nothing else,
   from the suspended-write block at `services/api/src/lib/access.ts:82`. Add an optional
   `whileSuspended?: true` to `ProcedureMeta` (`packages/contracts/src/api/common.ts:35-45`, with a
   comment: only for redress), set it on `appeals.create` (`router.ts`, `appeals.create`, about
   :2266; recheck after E7), and make the check
   `if (f.write && caller.user.suspended && f.meta.whileSuspended !== true)`. Tests: the
   `decideAccess` unit tests (suspended caller may create an appeal, still may not do any other
   write), and a contract test that walks the router and asserts `appeals.create` is the only
   procedure with `whileSuspended`. `appeals.create` is already on the `write` rate-limit bucket
   (commit `7833a19`), so this is about the suspended check only. Whether the auth library lets a
   suspended user sign in at all (`services/api/src/auth/index.ts:190`) is W0-sor's to check.
9. **NCII appeal subject** (ADR 0019 answer 4): append `"ncii_request_item"` to `APPEAL_SUBJECTS`
   (`packages/contracts/src/enums.ts:106-118`, doc comment: an NCII request item covering content
   the appellant owns, appealing its removal or auto-hide). `appeals.subject_type` is `text`
   (`packages/db/src/schema/safety.ts:144`), so no migration. E7-appeals has merged, so this step
   edits `services/api/src/routes/appeals.ts`: add it to `KIND_SUBJECTS.moderation`, and a
   `subjectConcerns` case (the item exists, and its `subject_type`/`subject_id` names a broadcast,
   VOD, clip or upload whose channel or uploader is the appellant; the requester is never told who
   appealed). Overturning records the decision only, as for `moderation_action`: restoring content
   is a manual staff step, and `hashed_at` items have no objects left to restore. Update the file's
   doc comment, and add int tests (own item accepted, someone else's item NOT_FOUND, open-appeal
   uniqueness). W0-sor's statements name this subject for `ncii.decide` (removed) and
   `ncii.auto_hide`; a T0 NCII-list statement has a null `appeal`.

## C. VOD placement job (ADR 0009 amendment, decision 3)

1. New stub `services/worker/src/jobs/vod-placement.ts` (`defineJob` on `QUEUES.retention`, name
   `vod-placement`, data `{ vodId?: uuid }`, schedule every minute: the accepted one-minute
   database-state sweep, no outbox events from other writers; handler returns `{ notBuilt: 1 }`),
   registered in `services/worker/src/jobs/index.ts`. W0-media-exposure owns the file.
2. Add `"vod-placement"` to `OPS_TICK_JOBS` (`packages/contracts/src/internal.ts:492`) so the ops
   test hook can run a sweep on demand, as for `vod-retention`.

## D. Harness

1. **`harness/scenarios/clock-skew.ts`** stub: `defineScenario({ name: "clock-skew", description:
   "cross-rendition skew < 100 ms and live-to-VOD < 250 ms (ADR 0012)", needs: ["api", "mail",
   "media", "origin", "ffmpeg", "whip"], inFull: false, timeoutMs: 15 * 60_000, run() { throw new
   Error("clock-skew: not built yet (W0-clock)") } })`. W0-clock owns it; the orchestrator adds it to
   `FULL_REQUIRED` (`harness/src/registry.ts:33-55`), gives it a shard in `FULL_SHARDS`
   (`harness/src/shards.ts:11`) and sets `inFull` after W0-clock merges. W0-clock may change `needs`
   (a recorder restart may need `"podman"`).
2. **`trust-safety` steps** (`harness/src/safety.ts:18-39`): E7's contract step adds steps 8 (DMCA)
   and 9 (appeal lifts the ban) and moves `Run`, `Staff` and `Streamer` into
   `harness/src/safety-run.ts`. Append steps 10 `"VOD exposure"` (no prerequisites) and 11
   `"statements of reasons"`. Step 11's prerequisites are 4, 5, 6 and 7 (T2 label, T1 restriction,
   upload rejection, NCII): those produce the allowlisted audit actions it checks, and
   `withPrerequisites` adds them when step 11 is run alone. Wire each in the switch in
   `harness/scenarios/trust-safety.ts` (:266-288 at `9c51c93`) to a function in a new module:
   `harness/src/safety-vod-exposure.ts` (`runVodExposureStep(run: Run): Promise<void>`) and
   `harness/src/safety-sor.ts` (`runStatementsStep(run: Run): Promise<void>`), with `Run` imported
   from `harness/src/safety-run.ts`. Each is a stub that throws `"W0-media-exposure not merged"` /
   `"W0-sor not merged"`, as E7's stubs do. Extend the `(1-9)` range messages in `parseSteps`
   (E7 fixes `(1-7)` to `(1-9)`), the scenario `description` and `harness/tests/safety.test.ts` for
   the new step count. W0-media-exposure and W0-sor own one module each; nobody else edits
   `trust-safety.ts`, `safety.ts` or `safety-run.ts` during W0 (a change there is a contract
   request).
3. **`integrity-basic`** needs nothing here: W0-integrity owns the scenario file.

## E. `docs/testing/w0-selectors.md`

Same shape as `docs/testing/e4c-selectors.md` (rules, flow table, routes, test ids, scenarios),
extending e1–e7. Contents:

- **Rules a reviewer marks HIGH:** no VOD object that is not "public and playable" under `vods/`
  after the placement job ran; `/media/vods/…` and `/vod/…` check state before storage; a VOD token
  never authorizes `/hls`; no statement for a `scope = 'channel'` action; statements carry no free
  text, no exact score, no NCII requester identity; the statement table is append-only.
- **Flow table:** one row per ADR 0019 decision 3 source action (statement yes/no, restriction,
  fact code, appeal subject), and one row per VOD state (recording, processing, ready public,
  ready subscribers, ready private, owner-removed, T1-restricted, channel suspended, NCII hidden,
  DMCA hidden, deleted)
  with its placement and what `/media/vods/…` and `/vod/…` answer.
- **Routes:** `GET|HEAD /vod/<vodId>/<file>?t=<token>`; `GET /me/enforcement`.
- **Appeals:** `ncii_request_item` subject (B.9); `appeals.create` allowed while suspended (B.8).
- **Data export:** the user export gains an `enforcement_statements` section (the decision 4
  columns, the requester's own statements only, no joined moderator note), W0-sor's after E7
  merges; add the row next to e6-selectors' "Data export".
- **Test ids** on `/settings/appeals`: `enforcement-list` (wrapper; `enforcement-empty`
  `<EmptyState>`), `enforcement-statement` (`data-statement-id`, `data-source-action`,
  `data-restriction-kind`, `data-restriction-detail`, `data-clause-id`, `data-clause-version`,
  `data-automated-decision`, `data-reversed` `true|false`), `enforcement-appeal-open` (opens the
  existing appeal dialog prefilled from `appeal`; absent when `appeal` is null or `appealId` is
  set), `enforcement-draft-notice` (shown when `noticeIsDraft`).
- **Scenarios:** `clock-skew` (metrics `crossRenditionSkewP95Ms`, `liveToVodSkewP95Ms`, data
  `baseline` when run with `--set assert=false`); `trust-safety` "VOD exposure" and "statements of
  reasons" step assertions; `integrity-basic` new cases (fetch-less bot, CDN bot under the `cdn`
  profile, false positives).

## F. Not in this step (owned by units or later)

- `selfhost.sh` NTP check (ADR 0012 decision 2, accepted as **warn, do not refuse**): P1-turn owns
  `scripts/selfhost.sh` in wave 2. W0-clock sends the exact lines as a contract request; apply them
  after P1-turn merges.
- Statements for report resolutions and admin suspensions (`services/api/src/routes/safety.ts`):
  W2, with a required `clauseId` (ADR 0019 answer 3).
- A production rung-skew gauge: not before W1 (ADR 0012 answer 6).
- Follow-ups recorded in ADR 0009 amendment 1: mature-labelled public VODs under `vods/`, clips of
  `subscribers`/`private` VODs public at `clips/`.
- `PROGRESS.md` 2H2 row (`PROGRESS.md:1153`) and `HANDOFF.md:451` ("CDN-delivered sessions not
  fetch-judged"): the orchestrator updates both when W0-integrity merges.
- Patronage and governance inputs that count `verdict = 'verified'` sessions
  (`packages/patronage/src/inputs.ts:101`, `packages/governance/src/inputs.ts:92`) keep counting CDN
  sessions; whether they should exclude `fetch_unjudged` is a question for the user (W0-integrity
  brief, "Contracts").
