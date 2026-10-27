<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W0-media-exposure: VOD objects stay private until published

You are implementing unit W0-media-exposure for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md, PLAN.md and docs/architecture.md first, then `.claude/briefs/next/W0-prerequisites.md`,
`docs/product/feature-wins.md` §4.12 "Free Live DVR" ("Segments must not be publicly reachable")
and §5 "Wave 0", `.claude/briefs/w0/contract-step.md`, [ADR 0009 and its amendment 1](../../../docs/decisions/0009-public-media-route.md)
and [ADR 0006](../../../docs/decisions/0006-automated-moderation.md) (T0 and NCII object
handling). Do not look outside the repository. Work in your own git worktree on a branch named
`w0/media-exposure`, starting from the W0 contract-step commit (which already contains E7-appeals
and E7-dmca).

Matches ADR 0009 amendment 1 as accepted on 2026-10-27 (its "Decisions at acceptance" section):
one private `recordings/<vodId>/` prefix, a token-checked `/vod/` origin route for restricted VODs
(12 h token cap, no refresh), a per-request state check on both routes (5 s per-instance cache, no
cross-instance invalidation), and one placement job that moves objects to match state, driven by
a one-minute database-state sweep plus direct enqueues from `vods.update` and `vods.remove` (no
outbox events from other writers). Existing objects move by that sweep. Mature-labelled public
VODs stay under `vods/` and clips of restricted VODs stay public at `clips/` (recorded
follow-ups, not yours).

## Why

Every VOD object is under the public `vods/` prefix from the first segment: in-progress recordings
(not yet PDQ-scanned by finalize), `subscribers` and `private` VODs, owner-removed VODs until the
hourly retention run, T1-restricted broadcasts and suspended channels indefinitely. The origin's
`/media` route serves all of it to anyone who has the URL (`services/origin/src/media.ts:17`). This
is a trust & safety exposure and the prerequisite for DVR (W2-dvr builds on your prefix and route).
Done when in-progress and removed VOD segments answer 404 via `/media` and `trust-safety` asserts it.

## You own (write only these)

P1-tracker works in `services/origin` in the same wave: keep the `P2P_DIGEST_ROUTE` dispatch
line the P1 contract step adds to `services/origin/src/origin.ts` `fetchHandler`, and create no
file named `p2p-digest*`.

- `services/media/src/vod/recorder.ts` (except the `ClockAnchor` calls the contract step added:
  keep them working), `services/media/src/vod/finalize.ts`, and the VOD-prefix code in
  `services/media/src/{clips,recovery,lifecycle}.ts`
- `services/origin/src/media.ts`, new `services/origin/src/vod.ts`, and in
  `services/origin/src/origin.ts` the route dispatch (:126-130) and the deps you pass in;
  `services/origin/src/main.ts` only if wiring needs it
- `services/api/src/routes/vods.ts`, new `services/api/src/media/vod-placement-queue.ts`
- `services/worker/src/housekeeping.ts` (VOD retention), the VOD-prefix lines of
  `services/worker/src/deletion/account-deletion.ts` (:26, :370), and the VOD-prefix code of
  `services/worker/src/moderation/{objects,t0-media,ncii-clock,ncii-hash}.ts` (the reads at
  `t0-media.ts:108`, `ncii-clock.ts:203`, `ncii-hash.ts:75`; nothing else in those files: W0-sor
  works beside you in `services/worker/src/moderation/sor-*`)
- the VOD-prefix reads in `services/worker/src/dmca/**` (E7-dmca's, merged before you start: where
  `dmca-disable` lists a VOD's objects with `vodPrefix`, list `storage_prefix` instead; nothing else
  in those files)
- new `services/worker/src/vod/**`, and `services/worker/src/jobs/vod-placement.ts` (stub from the
  contract step)
- `packages/storage/src/**`, `packages/storage/tests/**` (a `copy` operation; today the package has
  only `src/index.ts` and the unit test `tests/s3.test.ts`)
- `harness/src/safety-vod-exposure.ts` (stub from the contract step), the prefix assertions in
  `harness/scenarios/vod-clips.ts` (:221-222, :300)
- `infra/README.md` (:224-231, the public-prefix paragraph)
- Tests: new files under `services/{media,origin,api,worker}/tests/` and `packages/storage/tests/`,
  and edits to existing tests that assert the old layout (`services/media/tests/media.int.test.ts`,
  `housekeeping*.test.ts` in media and worker, `services/worker/tests/deletion.int.test.ts`,
  `moderation-hide.int.test.ts`, `moderation-ncii-hash.int.test.ts`,
  `moderation-t0-media.test.ts`, `services/origin/tests/media.test.ts`,
  `services/api/tests/vods-*.int.test.ts`)

Not yours: `services/media/src/ffmpeg/args.ts`, `clock/**`, `service.ts`, `main.ts` (W0-clock),
`services/worker/src/moderation/sor-*` and `jobs/moderation-sor.ts` (W0-sor),
`harness/scenarios/trust-safety.ts` and `harness/src/safety.ts` (orchestrator; your step is wired
to your module), `infra/caddy/Caddyfile` (the contract step added `/vod/*`),
`packages/contracts/**`, `packages/db/**`, `services/api/src/media/visibility.ts` (E7-dmca's
removed-reason handling; read it), `scripts/selfhost.sh`. Need a change outside your paths? Do not
make it: put the exact change in your final message as a contract request.

## Contracts you must honor (read-only for you)

- `@commonair/contracts/storage` (contract step): `VOD_PUBLIC_PREFIX`, `VOD_PRIVATE_PREFIX`,
  `vodPrefix(id, placement)`, `isVodOwnPrefix`, `VOD_PLAYLIST`, `VodPlacementState`,
  `vodPlacement(state)` (`public | private | leave`), `PUBLIC_MEDIA_PREFIXES`, `VOD_ROUTE`,
  `vodTokenPath(id)`, `VOD_TOKEN_MAX_TTL_SECONDS`. Use them; never rebuild a prefix string.
- VOD tokens are `PlaybackClaims` (`packages/contracts/src/tokens.ts:19-34`) with
  `path = vodTokenPath(vodId)`, `src = "origin"`, signed with the existing key
  (`signPlaybackToken`/`verifyPlaybackToken` from `@commonair/tokens`). No new crypto, no vector
  change. A VOD token must never authorize `/hls` (path mismatch already refuses it, keep a test).
- `vods.storage_prefix` (`packages/db/src/schema/media.ts:152`) is where a VOD's objects are now.
  Every reader lists objects from it, never from a rebuilt id prefix.
- `OPS_TICK_JOBS` contains `vod-placement` (contract step), so the ops test hook can run a sweep.
- T0: a T0 match during recording or finalize must never have produced a public object, and T0
  evidence preservation must find every object wherever it is (`t0-media.ts`). NCII-hidden objects
  (`moderation/ncii-hidden/`) and DMCA-hidden objects (`moderation/dmca/`, E7-dmca) stay where they
  were put: `vodPlacement` returns `leave` for a VOD with a hidden NCII item, a hidden and not
  restored DMCA item, or `status = 'deleted'`.
- `docs/testing/w0-selectors.md` (contract step): the VOD state table and the HIGH rules.

## What is there today (verified at `9c51c93`)

- The recorder uploads each closed segment, then the open playlist, to `vodPrefix(vodId)` =
  `vods/<vodId>/` (`services/media/src/vod/recorder.ts:23`, `upload` :191-224; resume reads the
  playlist from the same prefix :179-189). `lifecycle.ts:196-212` inserts the VOD row with
  `storagePrefix: vodPrefix(id)` and status `recording`. Recovery after a crash re-uploads to the
  same prefix (`recovery.ts:105-112`); VOD clips read it (`clips.ts:126-133`).
- Finalize (`finalizeVod`, `vod/finalize.ts:90-242`): claims `processing`, PDQ-scans the recording in chunks and
  refuses to publish on a T0 match (:110-114, :158-173), samples a thumbnail into
  `<prefix>thumbnail.<ext>` (:198-201), then in one transaction writes the ended playlist, the
  thumbnail and sets `ready` with size and `expiresAt` (:207-236).
- The origin's `/media` route (`services/origin/src/media.ts`) serves any key under
  `channels|clips|thumbnails|vods` (:17, checked at :55) with the service key, `cache-control:
  public, max-age=300` (:94), never consulting the database. It is dispatched in `origin.ts:126-130`,
  which already has `opts.db` and the playback signing key (:25-28, :108-114). The live route
  rewrites playlists so every URI carries the token (`handler.ts:110-116`); `TtlCache` is in
  `cache.ts:103`.
- The API returns `playlistUrl: mediaUrl(...)` for every ready VOD the caller may see
  (`services/api/src/routes/vods.ts:34-49`), so subscriber and owner playback of restricted VODs
  goes through public `/media` URLs today. `vods.update` changes visibility (:106-133);
  `vods.remove` sets `removed_reason = 'owner'`, `expires_at = now` (:135-171). Visibility rules are
  in `services/api/src/media/visibility.ts` (`vodShown` :101-114). Playback URLs use
  `PLAYBACK_PUBLIC_URL` (`services/api/src/routes/playback.ts:52-63`).
- Worker: retention deletes `vodPrefix(vod.id)` and refuses any `storage_prefix` other than exactly
  `vods/<id>/` (`housekeeping.ts:141-189`, guard :148-150); account deletion lists
  `vodPrefix(v.id)` (`deletion/account-deletion.ts:370`); T0 evidence lists it
  (`moderation/t0-media.ts:108`); NCII lists it (`ncii-clock.ts:203`, `ncii-hash.ts:75`). The only
  object mover reads whole objects into memory (`moderation/objects.ts:47-58`).
- The storage port has no copy (`packages/storage/src/index.ts:28-48`; single file).
- Harness: `vod-clips.ts:221-222` asserts the prefix is `vods/<id>/`; `:300` lists a held VOD under
  it.

## Build

1. **Storage copy.** Add `copy(bucket, fromKey, toKey)` to `ObjectStorage` and the S3 client
   (S3 CopyObject, server side; content type and cache-control preserved). Garage is the default
   store and ADR 0033 proposes SeaweedFS. `packages/storage` has no integration test today: add
   `tests/s3.int.test.ts` against the infra store at the `.env.example` defaults, reaching it (and
   skipping) the way `services/media/tests/media.int.test.ts` does. ADR 0009 amendment 1 requires
   this test to prove CopyObject against the pinned Garage image, and against SeaweedFS too if
   ADR 0033 has been accepted and the infra store switched by the time you start; say which stores
   you proved. Add `moveVodObjects(storage, bucket, fromPrefix,
   toPrefix)` (copy every object, verify each copy by size and ETag or a HEAD, return counts; never
   delete here) wherever it is shared by media and worker without a new dependency edge
   (`packages/storage` is fine).
2. **Record privately.** New VODs start with `storagePrefix = vodPrefix(id, "private")`
   (`lifecycle.ts:211`). The recorder writes and resumes under the row's `storage_prefix` (read it
   at start; a `recording` VOD resumed across the upgrade keeps its old `vods/` prefix and finalize
   moves it like any other). Recovery and VOD clips read `storage_prefix`.
3. **Finalize publishes by placement.** After the scan passes and before the `ready` transaction,
   compute `vodPlacement` for the VOD as it will be once ready. If `public`, copy the objects
   (playlist, init, segments, thumbnail) to `vods/<id>/`, then in the `ready` transaction set
   `storage_prefix` and `thumbnail_key` to the public ones; delete the private prefix after commit.
   If `private`, write the ended playlist and thumbnail under `recordings/<id>/` and stay there. A
   T0 hit leaves nothing public (it never was). A crash between copy and commit leaves both copies;
   a rerun or the sweep finishes.
4. **The placement job** (`services/worker/src/vod/placement.ts`, run by the
   `jobs/vod-placement.ts` stub). With `{ vodId }`: load the VOD's `VodPlacementState` (status,
   visibility, `removed_reason`, `broadcasts.restricted_at`, `channels.suspended_at`, any hidden NCII
   item and any hidden, unrestored DMCA item covering it), compute the target (`leave`: do nothing); if `storage_prefix` differs, copy, update
   `storage_prefix` and `thumbnail_key` in one transaction, delete the source prefix. Idempotent;
   per-VOD dedupe (`jobId = vod-placement:<id>`); a legal hold on the owner never blocks moving to
   private (it only blocks deletion). Without data: the sweep. Every minute select up to N VODs
   whose `storage_prefix` does not match `vodPlacement` of their state (in SQL, in batches) and
   enqueue each, logging counts only (never keys). The first sweeps also migrate every existing
   non-public VOD from `vods/` to `recordings/` (ADR decision 5); no schema migration.
   This is the accepted mechanism (ADR 0009 amendment 1 decision 3): a one-minute state-driven
   sweep plus direct enqueues from the two writers you own (step 6). T1 restriction and clearing
   (`moderation/scan.ts`, `routes/moderation.ts`, `moderation/restriction.ts`), channel
   suspension (`routes/moderation.ts`, `routes/admin.ts`) and the DMCA and NCII flows need no edits
   by you and emit no outbox events for placement; exposure in the meantime is closed by the state
   check (step 5).
5. **Origin: state check and the VOD route.**
   - `/media/vods/<id>/…`: before touching storage, look up the VOD's state (one query joining
     `vods`, `broadcasts`, `channels`, and NCII hidden items; cached per VOD for 5 s in a
     `TtlCache`; negative results cached too) and serve only if `vodPlacement` is `public`. Anything
     else, including an unknown id and a database error, is the same 404 as a missing object (a
     database error is logged without the key). Other prefixes keep today's behaviour.
   - New `GET|HEAD /vod/<vodId>/<file>?t=<token>` (`services/origin/src/vod.ts`, dispatched by
     `VOD_ROUTE` in `origin.ts`): verify the token (`path === vodTokenPath(vodId)`, `src = origin`,
     not expired); check state: not deleted, no `removed_reason`, broadcast not restricted, channel
     not suspended, status `ready` (cached as above); read `<storage_prefix><file>` (either prefix:
     a VOD mid-move must keep playing); refuse `..`, encoded slashes and control characters exactly
     as `publicMediaKey` does. For `index.m3u8`, rewrite every URI (segments and `#EXT-X-MAP`) to
     carry `?t=`. Headers: `cache-control: private, no-store` for the playlist, `private,
     max-age=300` for segments, the same CORS, `nosniff` and sandbox CSP as `/media`; single `Range`
     passthrough. No integrity sampling, no segment log, no receipts. Wrong or expired token: 401
     with no body detail; wrong state: 404.
6. **API.** `toVod` (`vods.ts:34-49`): for a playable VOD whose `storage_prefix` is public and whose
   state is public, keep the `/media` URL; otherwise, when `vodShown` already admits the caller
   (owner, active subscriber, or public mid-move), mint a VOD token (`sid` a fresh uuidv7, `cid` the
   channel, `exp = iat + min(duration + 3600, VOD_TOKEN_MAX_TTL_SECONDS)`) and return
   `${PLAYBACK_PUBLIC_URL}/vod/<id>/index.m3u8?t=…`; the thumbnail likewise. Withheld (mature)
   handling is unchanged. `vods.update` (visibility change) and `vods.remove` enqueue
   `vod-placement {vodId}` after commit through `services/api/src/media/vod-placement-queue.ts`
   (follow `media/clip-queue.ts`); a failed enqueue is logged and left to the sweep. Both handlers
   already write their `audit_log` row (`vods.ts:122`, :160); keep it. The placement job is a
   reconciler, not a decision: it writes no audit row and logs ids and counts only.
7. **Worker readers.** Retention (`housekeeping.ts`) deletes `storage_prefix` when
   `isVodOwnPrefix(id, storage_prefix)` and refuses anything else (keep the refusal tests; add
   `recordings/<id>/` acceptance and `recordings/` root, no-slash and traversal refusals). Account
   deletion, T0 evidence (`t0-media.ts:108`), NCII (`ncii-clock.ts:203`, `ncii-hash.ts:75`) list the
   VOD's `storage_prefix` (and, while a move is in flight, both own prefixes: a T0 must find every
   copy). Remove the contract step's one-argument `vodPrefix` wrappers (`vod/recorder.ts`,
   `housekeeping.ts`, `moderation/objects.ts`) once nothing uses them.
8. **Harness.**
   - `harness/src/safety-vod-exposure.ts` (`runVodExposureStep`, wired by the contract step as the
     `trust-safety` step "VOD exposure"): a streamer with VODs on goes live; while recording, a
     `/media/vods/<id>/index.m3u8` and a segment URL answer 404 (and the private objects exist, via
     the read-only bucket listing the scenario already uses); after the broadcast the public VOD
     plays via `/media`; switching it to `subscribers` makes `/media` 404 within 5 s and a
     subscriber's `playlistUrl` plays through `/vod/`; a non-subscriber gets no URL; after
     `vods.remove`, `/media` and the subscriber's old `/vod/` URL both answer 404 within 5 s; after
     the placement sweep (ops tick) no object of a non-public VOD is under `vods/`.
   - `vod-clips.ts:221-222`, `:300`: assert against `storage_prefix` and the new layout.

## Tests you must add

- `packages/storage`: `copy` (unit with injected responses; integration against the test store),
  `moveVodObjects` verification failure keeps the source.
- `services/origin`: state check matrix (every row of the selectors' VOD state table) on `/media`;
  `/vod/` token checks (missing, malformed, expired, wrong VOD, live token refused, VOD token
  refused on `/hls`), path traversal, playlist rewrite including `#EXT-X-MAP`, cache headers, HEAD,
  Range; the 5 s cache (state change visible after the TTL, not before).
- `services/media`: new recordings go to `recordings/`; resume keeps an existing prefix; finalize
  public moves before `ready` and private stays; T0 during finalize leaves nothing under `vods/`;
  recovery and VOD clips use `storage_prefix`.
- `services/api` (int): `playlistUrl` per audience and visibility; token TTL bound; enqueue on
  update and remove.
- `services/worker` (int): placement for each state, idempotence and crash-between-steps, NCII,
  DMCA and deleted `leave`, DMCA disable and restore finding objects under either prefix, sweep
  batching and migration of legacy `vods/` objects; retention, account deletion, T0
  evidence and NCII hashing find objects under either prefix.

## Done means

Follow `.claude/briefs/_done-means.md`, with this batch's rule: the orchestrator runs the gate; you
run targeted checks only and never run the gate, `podman`, `scripts/infra.ts` or harness scenarios.
Run `bun run test` and `bun run test:int` (one package at a time) in `packages/storage`,
`services/media`, `services/origin`, `services/api`, `services/worker`; `bunx tsc -p <pkg> --noEmit`
for each and for `harness`; `vp lint --deny-warnings` and `vp fmt` on your paths. Commit in your
worktree (`git commit -s`, Conventional Commits, message ending with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Final message: what you
built, test counts per package, branch and sha, the stores `copy` was proven against, contract
requests, anything left, and the live commands:
`bun harness/src/cli.ts run trust-safety --set steps=10` (the "VOD exposure" step; check the number
in `harness/src/safety.ts` after the contract step) and
`bun harness/src/cli.ts run vod-clips`.

## Contract step as landed

- Your base is main after the P1 contract step merge (`223b192`), which contains all of E7 and the W0 and P1 contract steps. Recheck line numbers against it.
- The migrations taken are `0028_enforcement_statements` and `0029_w0_protections`.
- The next free migration number is 0030.
- `0029_snapshot` is a copy of 0028.
- Current wrapper and reader locations:

| What                                                   | File:line                                            |
| ------------------------------------------------------ | ---------------------------------------------------- |
| `vodPrefix` wrapper                                    | `recorder.ts:26` (`VOD_PLAYLIST` re-exported at :25) |
| Recorder resume / upload                               | :201-211 / :213                                      |
| `vodPrefix` wrapper and retention SQL guard            | `housekeeping.ts:93` and :155                        |
| Retention `deletePrefix`                               | `housekeeping.ts` :181, :183                         |
| `vodPrefix` wrapper                                    | `moderation/objects.ts:45`                           |
| `t0-media`                                             | :108                                                 |
| `ncii-clock`                                           | :203                                                 |
| `ncii-hash`                                            | :87 and :161                                         |
| `account-deletion`                                     | :27 import; :371, :387, :391                         |
| `dmca/objects.ts`                                      | :111, still checks `startsWith("vods/")`             |
| `services/api/src/routes/vods.ts` local `VOD_PLAYLIST` | :28, still to be replaced with the contract export   |

- Contract helpers are in `@commonair/contracts/storage`: `vodPrefix(id, placement)`, `vodPlacement`, `isVodOwnPrefix`, `VOD_ROUTE`, `vodTokenPath`, `VOD_TOKEN_MAX_TTL_SECONDS`, and `PUBLIC_MEDIA_PREFIXES`.
- The recorder now contains ClockAnchor stamping; keep it.
- Caddy routes `/vod/*` to `origin:3003`.
- The `vod-placement` job is a stub on the retention queue, running every 60 s with data `{ vodId?: uuid }`. It is in `OPS_TICK_JOBS` and in the api `OPS_JOB_QUEUES`.
- Its harness step is trust-safety step 10, which is in `PENDING_SAFETY_STEPS`. On landing, remove 10 from that list in `harness/src/safety.ts` and update the pending assertion in `safety.test`. That file belongs to the orchestrator, so this is a contract request.
- Possible follow-up: reserve the username `vod` in `services/api/src/auth/identity.ts`, because Caddy's `/vod/*` would shadow sub-paths of a channel with that name.

## P1 contract step (merged before wave 2)

- Your base also contains the P1 contract step. When editing the dispatch in `services/origin/src/origin.ts`, keep the `digestHandler` construction and `if (rawPath.startsWith(P2P_DIGEST_ROUTE)) return digestHandler(req, rawPath);`, after `/media/` and before the HLS fallback.
