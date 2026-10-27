<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0009: Public media through the origin's `/media` route

- Status: accepted (2026-10-21); amendment 1 accepted (2026-10-27)
- Date: 2026-10-21

## Context

Avatars, banners, panels, emotes, thumbnails, clips and VODs live in the media bucket. The API
used to build their public URLs as `S3_PUBLIC_ENDPOINT/<bucket>/<key>`: the S3 API of the
object store, read anonymously. Garage, the FOSS default store, refuses anonymous reads on its
S3 API ("Garage does not support anonymous access yet"). None of these objects loaded in a
browser on the local stack.

The media bucket also holds objects that must never be public:

- `incoming/`: presigned uploads that have not been scanned yet (ADR 0006 Q6);
- `moderation/<case>/<flag>.jpg`: review frames;
- `moderation/ncii-hidden/`: objects hidden by the NCII 48-hour deadline;
- `moderation/dmca/`: objects disabled by a DMCA notice (E7-dmca; added by amendment 1);
- `recordings/`: VOD objects that are not publicly playable (amendment 1).

T0 media is moved to the separate evidence bucket and deleted from the media bucket, so no T0
object stays in it.

## Options

1. **Garage's web endpoint** (`[s3_web]`, bucket website access). It is host-routed
   (`<bucket>.<root_domain>`) and serves **every** key of a website-enabled bucket. Garage has no
   bucket or prefix policies, so the private prefixes above would be public. Moving them to a
   second bucket would change the moderation, upload and deletion code paths. It would also tie
   the URL shape to Garage.
2. **A filtering proxy.** A service reads the bucket with the service key and serves only an
   allowlist of public prefixes.

## Decision

Option 2, in the origin (the playback edge, always running, already reachable by browsers and
already behind Caddy's `/hls`, `/cdn` and `/relay-pull`):

- `GET|HEAD /media/<key>` serves the object at `<key>` from `S3_BUCKET_MEDIA`. It passes single
  `Range` requests through (MP4 seeking) and returns content type, length, range, ETag and
  last-modified. It adds CORS `*`, `nosniff`, a sandboxing CSP and `cache-control: public,
  max-age=300`. The short TTL lets a hidden object drop out of shared caches within minutes.
- Only keys whose first segment is `channels`, `clips`, `thumbnails` or `vods` are served. Each
  segment is percent-decoded alone, and empty, `.`, `..`, `/`, `\` and control-character
  segments are refused. Everything else is a 404 without touching storage, whether or not the
  object exists. The allowlist fails closed: a new private prefix needs no change here; a new
  public one does.
- `MEDIA_PUBLIC_URL` (new, default `http://localhost:3003/media`; compose
  `http://localhost:${ORIGIN_PORT}/media`; `https://<host>/media` behind Caddy) is the base of
  every public media URL: `mediaUrl()` returns `MEDIA_PUBLIC_URL/<key>`, and
  `instanceMediaBase()` (used to accept media references and to resolve NCII URLs) uses the same
  base.
- `S3_PUBLIC_ENDPOINT` keeps one job: the endpoint browsers reach for presigned uploads and
  downloads. Garage's web endpoint stays off (`infra/tests/compose.test.ts` checks this).

A CDN or a public bucket remains an optional adapter. An operator can point
`MEDIA_PUBLIC_URL` at a CDN that origin-pulls `/media/` from the origin. A store with real
prefix policies can also serve the public prefixes itself. Nothing requires either.

## Consequences

- Media bytes now pass through the origin (one extra hop on the local network). VOD playback is
  HLS, so the large transfers are segments; the CDN path above takes them off the origin when needed.
- Box art (`categories.box_art_key`) has no writer yet. When it gets one, its prefix must be
  added to the allowlist.
- The allowlist does not consult the database. A withheld VOD's objects are still readable at
  their UUIDv7 URLs, which nothing publishes. Hiding by moving to a private prefix (as NCII
  does) or deleting (as T0 does) is what removes public access.
- The trust-safety harness scenario reads clip 2 through its public URL. It checks that clip 1's
  URL and the would-be URL of its NCII-hidden copy both answer 404 while the hidden copy exists.

## Amendment 1: VOD objects stay private until published

- Status: accepted (2026-10-27; the four questions answered by the maintainer, see
  [Decisions at acceptance](#decisions-at-acceptance-2026-10-27))
- Date: 2026-10-27 (code checked at `9c51c93`)
- Gates: W0-media-exposure (`.claude/briefs/next/W0-prerequisites.md:29`)

### Context

The allowlist above serves every key under `vods/` (`services/origin/src/media.ts:17`, checked
at `:55`) and never consults the database. Three kinds of VOD object sit there anyway:

- **In-progress recordings.** The recorder uploads each closed segment, then the open playlist,
  to `vods/<vodId>/` while the broadcast is live (`services/media/src/vod/recorder.ts:23`,
  `:193`–`:226`). Finalize PDQ-scans the whole recording only after the broadcast ends and refuses
  to publish on a T0 match (`services/media/src/vod/finalize.ts:110`, `:158`–`:173`). Until then
  the segments of a VOD that may never be published are already readable at
  `/media/vods/<vodId>/…`; the "never published" guarantee rests on nobody knowing the UUIDv7.
- **Restricted VODs.** `subscribers` and `private` are enforced only when the API decides whether
  to list a VOD and return its URL (`services/api/src/media/visibility.ts:57`–`:71`, `:101`–`:114`;
  `services/api/src/routes/vods.ts:44`). The objects are at the same public prefix, so a URL
  leaked once (or kept after a subscription lapses, or after the owner switches a VOD to
  `private`, `vods.ts:112`) plays forever.
- **Removed VODs.** An owner removal only sets `removed_reason` and `expires_at = now`
  (`vods.ts:144`); `vod-retention` deletes the objects on its next hourly run
  (`services/worker/src/housekeeping.ts:141`–`:189`, `services/worker/README.md:44`). T1-restricted
  broadcasts (`broadcasts.restricted_at`, `visibility.ts:66`) and suspended channels
  (`visibility.ts:110`) keep their objects public indefinitely.

The prefix is hard-coded in four places that must agree: `services/media/src/vod/recorder.ts:23`,
`services/worker/src/housekeeping.ts:88` (and the SQL guard at `:150`),
`services/worker/src/moderation/objects.ts:43`, and the harness (`harness/scenarios/vod-clips.ts:222`).
`packages/contracts` has no storage-layout module (`packages/contracts/package.json` exports).
The storage port has no copy operation (`packages/storage/src/index.ts:28`–`:48`), and the only
mover reads the whole object into memory (`services/worker/src/moderation/objects.ts:47`–`:58`).
The origin already holds a database handle (`services/origin/src/auth.ts:16`–`:17`), a TTL cache
(`services/origin/src/cache.ts:103`) and token-carrying playlist rewriting
(`services/origin/src/handler.ts:110`–`:116`).

### Decision 1: a private `recordings/` prefix for every VOD that is not publicly playable

Options:

1. **Per-request checks only.** Keep everything under `vods/`; the origin looks up the VOD row on
   each `/media/vods/<id>/…` request. Smallest change. But the public prefix then holds private
   bytes, and ADR 0009 lets an operator point a CDN, or a store with real prefix policies, at
   the public prefixes directly. Either bypasses the check. A bug in one predicate exposes every
   recording.
2. **A separate private bucket.** Strong isolation. But every VOD code path takes one bucket
   (`finalize.ts:36`, `housekeeping.ts:176`, `objects.ts`), a second bucket adds an env var,
   `ensureBucket`, Caddy and `selfhost.sh` wiring, backups and the 0024 allowlist. ADR 0009
   already rejected moving private prefixes to a second bucket for the same churn.
3. **A private prefix in the same bucket** that the allowlist does not name.

Decision: option 3. The prefix is **`recordings/<vodId>/`**. It holds a VOD's objects while
it records and processes, and whenever its effective state is not "public and playable": ready,
`visibility = public`, no `removed_reason`, broadcast not restricted, channel not suspended. Only
then do the objects live under `vods/<vodId>/`. The allowlist is unchanged, since it already fails
closed for an unnamed prefix. One private prefix (rather than `recordings/` plus a separate
`restricted/`) keeps the rule binary: public or not.

Consequences: a T0 match found during recording or finalize never had a public object, which
makes the "never published" claim in `finalize.ts:8` true at the storage layer. Removal and
re-scoping become object moves (Decision 3).

### Decision 2: restricted VODs play through a token-checked origin route

Options:

1. **Presigned GETs** from the API for each object. A VOD playlist names thousands of segments
   (4 s segments, `services/media/src/settings.ts:55`), the presign is a bearer URL to the store,
   and on a self-hosted instance it needs a new Caddy passthrough to Garage (ADR 0024).
2. **The API proxies the bytes.** Rejected for the same reason as ADR 0024 option 4.
3. **An origin route with a playback token.** `GET|HEAD /vod/<vodId>/<file>?t=<token>`, reading
   `recordings/<vodId>/<file>`. The token is a `PlaybackClaims` (`packages/contracts/src/tokens.ts:19`)
   with `path = "vod/<vodId>"`, `src = "origin"`, signed with the existing key, so no new crypto or
   relay test vectors. The origin rewrites the playlist so each segment URI carries the token, as
   the live route does (`handler.ts:115`). It returns `cache-control: private` and records no
   integrity or receipt samples. Caddy gains `handle /vod/*` → origin.

Decision: option 3. `toVod` (`vods.ts:34`–`:49`) mints the token only when `vodShown` already
admits the caller. The token lifetime is the VOD's duration plus one hour, capped by a new
`VOD_TOKEN_MAX_TTL_SECONDS` (12 h). The VOD playlist is loaded once, so the 120 s live TTL
(`tokens.ts:36`) would cut playback off. Thumbnails of restricted VODs use the same route.

Consequences: a token leaked by a subscriber works for at most that window, and Decision 3's
state check revokes it as soon as the VOD's state changes. The owner gets a token for a ready
`private` VOD. Recording and processing VODs get no playable URL (`vods.ts:35`, unchanged).

### Decision 3: removal takes effect at once; objects follow state through one reconciler

Moving 3,600 objects for a four-hour VOD takes time, so a move alone cannot make removal
immediate. Options:

1. **Move only.** Removal is visible once the move finishes (seconds to minutes) plus cache TTL.
2. **State check plus move.** Both origin routes check the VOD's effective state, cached per VOD
   for 5 s in a `TtlCache`, before touching storage: `/media/vods/<id>/…` requires "public and
   playable", `/vod/<id>/…` requires "not removed, not restricted" plus the token. The move then
   brings storage in line, so a CDN or a direct store read is also covered.

Decision: option 2. One idempotent worker job, `vod-placement {vodId}`, computes where a VOD's
objects belong and moves them there. Finalize moves a VOD itself before it is `ready` (below).
`vods.update` (visibility) and `vods.remove` enqueue the job directly after commit. Every other
state change (T1 restriction and clearing, channel suspension and reinstatement, the DMCA and
NCII flows) is picked up by a sweep that runs **every minute**, selects VODs whose
`storage_prefix` does not match `vodPlacement` of their current database state, and enqueues
them in batches.

The draft had every writer emit an `events` outbox row in its transaction, with an hourly sweep.
That was changed at acceptance: those writers (`moderation/scan.ts`, `routes/moderation.ts`,
`moderation/restriction.ts`, `routes/admin.ts`, the DMCA and NCII jobs) belong to other units,
and the origin state check below closes the exposure within 5 s whether or not the objects have
moved yet. The move only brings storage in line for a CDN or a direct store read, so a one-minute
reconciler over database state is enough and touches no other unit's files. A move:

1. server-side copies each object (a new `copy(bucket, from, to)` on the storage port, S3
   CopyObject; Garage and SeaweedFS both document it, and W0-media-exposure's integration test in
   `packages/storage` must prove it against the pinned Garage image, and against SeaweedFS too if
   ADR 0033 is accepted before that unit lands);
2. updates `vods.storage_prefix` and `thumbnail_key` in one transaction;
3. deletes the source prefix.

A crash between steps leaves both copies, and a rerun finishes the move. Finalize runs the move to
`vods/` _before_ its `ready` transaction (`finalize.ts:208`–`:238`), so a VOD is never `ready` with
its objects missing.

`vodPlacement(state)` returns `public`, `private` or `leave`. `public` needs status `ready`,
`visibility = public`, no `removed_reason` (any reason, including `dmca`), broadcast not
restricted and channel not suspended; otherwise `private`, except that it returns `leave` (do not
move anything) when:

- a hidden NCII item covers the VOD: its objects are in `moderation/ncii-hidden/`
  (`services/worker/src/moderation/ncii-clock.ts:193`–`:216`);
- a DMCA item covering it has its objects hidden and not restored (`dmcaHidden`): E7-dmca's
  `dmca-disable` moves them to the private `moderation/dmca/<original key>` and `dmca-restore`
  moves them back to the same keys, so placement must not move them meanwhile. The VOD carries
  `removed_reason = 'dmca'` while disabled, which also keeps it from being `public`;
- `status = 'deleted'`: nothing is left to move.

Consequences: removal answers 404 within 5 s on every origin instance. A CDN in front of `/media`
keeps a copy up to the 300 s TTL (`media.ts:94`), as ADR 0009 already accepts for hidden
objects. Retention's prefix guard (`housekeeping.ts:150`) accepts exactly `vods/<id>/` or
`recordings/<id>/`, and every reader that lists a VOD's objects reads `storage_prefix` instead of
rebuilding it: T0 evidence (`t0-media.ts:108`), NCII (`ncii-clock.ts:203`, `ncii-hash.ts:75`),
account deletion (`account-deletion.ts:370`), clip cutting (`services/media/src/clips.ts:126`),
recovery (`services/media/src/recovery.ts:107`).

### Decision 4: the layout lives in `@commonair/contracts/storage`

Decision: a new `packages/contracts/src/storage.ts`, exported as `./storage`, holding
`PUBLIC_MEDIA_PREFIXES` (moved from `media.ts:17`), `VOD_PUBLIC_PREFIX = "vods/"`,
`VOD_PRIVATE_PREFIX = "recordings/"`, `vodPrefix(id, "public" | "private")`, `isVodOwnPrefix`,
`VOD_PLAYLIST`, `VodPlacementState` (with `nciiHidden` and `dmcaHidden`), a pure
`vodPlacement(state)` used by the worker job and the origin check, `VOD_ROUTE`, `vodTokenPath` and
`VOD_TOKEN_MAX_TTL_SECONDS` (a constant, not an env variable). The four local copies are
deleted. The alternative, `@commonair/config`, holds env and identity, not wire layout. This is
the contract step listed for W0 (`.claude/briefs/next/README.md:38`, under W0's "Contract step").

### Decision 5: migrating existing objects

Decision: deploy in one release, safe in either order:

1. The origin state check (Decision 3) closes the exposure at deploy, before any object moves.
2. New recordings start under `recordings/`. A `recording` VOD resumed across the upgrade keeps
   its `storage_prefix` (`services/media/src/lifecycle.ts:196`–`:212`), and finalize moves it like
   any other.
3. The first `vod-placement` sweeps move every existing non-public VOD from `vods/` to
   `recordings/`, in batches, logging counts only (never keys).

`vods.storage_prefix` already exists (`packages/db/src/schema/media.ts:152`), so no schema
migration is needed. The alternative is a one-shot script run by `selfhost.sh upgrade`. That adds
an operator step, and a crash mid-run still needs the sweep's idempotence.

### Consequences

- In-progress, restricted, removed, T1-restricted and suspended-channel VOD objects are never
  under a public prefix. The W0 harness case: `trust-safety` asserts that `/media/vods/<id>/…`
  answers 404 for a recording VOD, a `subscribers` VOD and a just-removed VOD, and that
  `/vod/<id>/…` plays for the subscriber and refuses a stale token after removal.
- `harness/scenarios/vod-clips.ts:222` and `infra/README.md:226`–`:231` change with the layout.
- Visibility changes cost a server-side copy of every object. Toggling a long VOD repeatedly
  is bounded by the job's per-VOD deduplication.
- The origin reads Postgres on the `/media/vods/` path, at most one query per VOD per 5 s per
  instance.
- Clips are unchanged: `clips/<id>.*` stays public even when the source VOD is restricted
  (`visibility.ts:85`–`:86` hides only the listing). A follow-up, not this amendment (answer 2).
- Mature-labelled public VODs stay under `vods/` (answer 1).

### Decisions at acceptance (2026-10-27)

The maintainer accepted amendment 1 with the recommended answers. Where an answer differs from
the draft, the text above was updated to match.

1. **Mature-labelled public VODs** stay under `vods/`; their URLs stay withheld from non-adults by
   the API (`visibility.ts:123`–`:147`). Moving them is a recorded follow-up.
2. **Clips of `subscribers` or `private` VODs** stay public at `clips/`. Recorded as a follow-up
   (it needs a matching private clip prefix and a clip placement rule).
3. **VOD token cap**: 12 h, accepted. No refresh.
4. **"Immediately" = 5 s**, the per-instance state-cache window, accepted. No cross-instance
   invalidation.

Also settled at acceptance:

- Existing objects move by the worker sweep (decision 5), not a one-shot script.
- The writers do not emit outbox events: a one-minute database-state sweep plus direct enqueues
  from `vods.update` and `vods.remove` (decision 3 says why). This differs from the draft.
- E7-dmca's private `moderation/dmca/` prefix, the `dmca` `removed_reason`, the `dmcaHidden`
  `leave` rule and the `status = 'deleted'` `leave` rule are part of this amendment (decision 3).
  The draft predated E7-dmca.
- `copy` (S3 CopyObject) must be proven by an integration test in W0-media-exposure against Garage,
  and against SeaweedFS if ADR 0033 lands first.
