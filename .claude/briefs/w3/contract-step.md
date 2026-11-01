<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Batch 7 contract step (W3, N3, N4)

The orchestrator lands this on `main` before wave 1: implement, then an independent review, then a
fix pass. It is one commit or a short series. Push it and wait for CI green. The decisions are in
[`batch7/README.md`](../batch7/README.md), (a)–(ad). Line numbers are from `b37203c4`; recheck
them. For the database, follow `.claude/skills/schema-change/SKILL.md`.

Nothing here implements a feature. This step creates the shapes, tables, crypto, seams, stubs
and scaffolding the twelve units build on, so that no two units ever write the same file. It is
large: split it into parallel parts with disjoint files, then integrate and review it whole, as in
batch 6. Suggested parts: (A) ADRs; (B) contracts, config and the env sync; (C) database; (D)
crypto packages and vectors; (E) API, worker, chat and origin seams; (F) web, harness and CI.

## 0. Where the code differs from the plans

- **User blocks already exist** (W1): `user_blocks` (`packages/db/src/schema/chat.ts:89-105`),
  `me.blocks.{list,ids,add,remove}` (`router.ts:330-357`), handlers in
  `services/api/src/routes/me-blocks.ts`. Live chat hides blocked users only in the browser
  (`apps/web/src/chat/blocks.ts`). Rooms need a **server-side** check (the chat service never reads
  blocks today).
- **Client frames are dispatched in `services/chat/src/server.ts`**, not in `core.ts` or
  `socket.ts`: `handleFrame` is at `:260-288`, and `ClientFrame` (`packages/contracts/src/chat.ts:18-42`)
  is the union to extend. `CHAT_LIMITS` is at `chat.ts:173`.
- **The raid policy is a column**, `channels.raidPolicy` (`schema/channels.ts:66`), not a
  setting. `RAID_RULES` is at `enums.ts:262`.
- **The outbox relay has no generic event-to-job table.** Hooks are called in order
  (`services/worker/src/outbox.ts:134-165`): `applyGoalProgress`, `notifyJobsFor` (public events
  only) and `w2JobsFor` (sees internal rows too, `services/worker/src/w2/outbox-jobs.ts:87-151`).
- **No suspension path writes an event.** The paths are `setSuspension`
  (`services/api/src/moderation/suspension.ts:25-76`, called from `routes/safety.ts:359`, `:555`,
  `routes/appeals.ts:470`, `dmca/strikes.ts:115`), inline in `routes/moderation.ts:189-207` and
  `:439-442`, and `suspendForT0` (`services/worker/src/moderation/t0.ts:97-104`). No event exists
  for a VOD or clip becoming public or non-public.
- **The worker never calls the API.** Only the API runs hash-list matching
  (`services/api/src/moderation/runtime.ts:93-138`). The worker's moderation runtime has no matcher.
- **`OUTBOUND_ALLOW_PRIVATE_NETWORKS`** (`packages/config/src/env.ts:544`) already lets harness
  overlays reach private addresses (`harness/compose.e6.yaml:17`). Check whether it also allows
  `http:`; federation and the Twitch mock need one or the other.
- **`channels.follower_count`** (`schema/channels.ts:69`) is maintained by the app (`routes/channels.ts:185-189`,
  `:217-224`, deletion `:282-291`), and integrity exclusion never decrements it
  (`packages/integrity/src/jobs.ts:788-791`): decision (aa).
- **Relays poll; nothing pushes to them.** They call register, heartbeat every 15 s and receipts
  (`relay/internal/apiclient/client.go:121-147`), and the heartbeat answer carries
  `originPublicKey` (`:76-79`). The cache has no purge (`relay/internal/cache/lru.go`).
- The latest migration is `0044_w2_indexes.sql`.

## 1. ADRs (part A)

- **0037 Portability.** Decisions (j)–(p): the bundle, move links, grants and the moved email,
  the standing statement, the import gates, and the internal upload route. Subscriptions are
  untouched on a move.
- **0038 Advisory jury.** Decision (u): eligibility, sampling exclusions, blurring and
  pseudonyms, the k = 10 publication, re-review flags, "never changes an outcome", and the
  `jury.enabled` default false.
- **0039 Fair draws, fair predictions and surge raids.** Decisions (s), (t), (v), (w).
- **ADR 0016 Amendment 1.** The signed relay purge protocol and relay DVR rules (x), and relay
  `.vtt` (y).
- **ADR 0031:** status accepted 2026-11-01 with decision (b) (panels by paste), and a "No counsel
  retained; post-launch review" note.
- **ADR 0035:** the maintainer confirmed the dual licence on 2026-11-01 (e).
- Each new ADR has a "Decisions at acceptance" section for the maintainer and the counsel note of
  decision (h).

## 2. Contracts (`packages/contracts`, part B)

### 2.1 Enums (`src/enums.ts`)

- `REPORT_SUBJECTS` (`:132`) gains `watch_room` (and the Postgres enum `reportSubject`, `_shared.ts:63`).
- `ROOM_AGE_BANDS = ["minor", "adult"]`; `ROOM_LIMITS = { maxMembers: 8, emptyEndMinutes: 10,
  retentionDays: 30, edgeCapSeconds: 5 }`.
- `FOLLOW_SOURCES = ["direct", "move_link", "import"]`; `MOVE_LINK_RULES = { maxActive: 10,
  perDay: 20 }`; `UNSUBSCRIBE_LISTS` (`:286`) gains `moved`.
- `PORTABILITY_SOURCES = ["commonair", "twitch"]`; `IMPORT_STATUSES` (`previewed`, `queued`,
  `running`, `done`, `failed`); `IMPORT_ITEM_KINDS` (`channel`, `panel`, `emote`, `schedule`).
- `GIVEAWAY_STATUSES` (`open`, `closed`, `drawn`, `cancelled`); `GIVEAWAY_RULES = { maxWinners: 10,
  maxOpenPerChannel: 1, maxDurationMinutes: 1440 }`.
- `JURY_VOTES = ["agree", "disagree", "unsure"]`, `JURY_REASON_CODES` (a short fixed list),
  `JURY_RULES = { panelSize: 7, casesPerPanel: 20, sampleDays: 30, k: 10 }`.
- `chat.surge.begin` trigger (`events.ts:567`) gains `raid`; `RAID_RULES` gains
  `surgeMinutes: 10` and `carryMinutes: 10`.
- `ENFORCEMENT_SOURCE_ACTIONS` (`:364-374`) gains `report.resolve`, `user.suspend` and
  `channel.suspend` (B7-followups builds the statements).
- `FEDERATION_RULES = { inboxMaxBytes: 262144, dateSkewSeconds: 43200, dropAfterDays: 7,
  keyRotateDays: 365 }`.

### 2.2 Shapes (`src/shapes.ts`)

- `ChannelChatSettings.surgeGuard` (`:61-87`) gains `onRaid: boolean` (default true).
- Channel settings `federation { enabled }`, with a full shape and a patch shape, following the
  chat settings pattern.
- Governance settings `jury.enabled` (ordinary; seeded false), `jury.panelSize` and
  `jury.casesPerPanel` (decision (u)).

### 2.3 Bundle (`src/portability.ts`, new; exported as `./portability`)

`PortabilityBundle` v1 (decision (j)):

```ts
{ v: 1, source, exportedAt, instance: {domain, software, version},
  channel: { title, description, tags, language, mature, categorySlug, categoryName },
  panels: [{ title, body, link, image: { file } | null }],
  emotes: [{ code, tier, animated, file }],
  schedule: [{ startsAt, endsAt, title, category }],    // carried, never applied
  standing: StandingStatementEnvelope | null }
```

- Image bytes live in the archive under `files/`; a manifest lists each file's size and SHA-256.
- Limits match the studio's: the emote count is `MAX_EMOTES`, plus the panel count and per-file
  byte caps.
- `parseBundle` refuses unknown versions.
- The Zod schemas live here. `packages/twitch` and the worker import them.

### 2.4 API (`src/api/entities.ts`, `src/api/router.ts`)

**Watch rooms:** `watchRooms.{create, get, invite, join, leave, close, mine}`. Join takes an invite
nonce. The output carries the age band, members (`ChannelAvatar` data) and the chat token
audience.

**Portability:**

- `portability.links.{list, create, revoke}`, owner only, scope `channel:manage`.
- `portability.links.resolve({channel, nonce})`, public; the landing page uses it.
- `portability.grants.{set, mine}` for viewers.
- `portability.move.{set, clear}` (`channels.moved_to`, owner).
- `portability.bundle.create` (export kind `bundle`; `EXPORT_KINDS` gains `bundle`).
- `portability.imports.{upload, preview, start, get, list}`.
- `channel.follow` input gains an optional `moveLink: {nonce}`.

**Giveaways:** `interact.giveaways.{current, open, enter, close, draw, cancel, verify}`. `verify`
is public: the commitment, the revealed seed, the pseudonym list and the winners (never the salt).
`instance.info().features.giveaways` is added.

**Jury:** `jury.{optIn, optOut, status, panel, cases, vote}` (juror) and
`jury.results({period})` (public). An admin `jury.flags.list` shows re-review flags.

**Fair predictions:**

- `interact.predictions.bet` input gains `mediaTs` (nullable) and `playbackMode`.
- `Prediction` gains `lockMediaTs`, `resolvedBy` and a `result` card: `{pool, winners, payoutSum}`.

**Raids:** `chat.surge.state` gains `raid {fromChannel, verifiedCount} | null`.

**Twitch import:**

- `twitchImport.{status, connect, preview, start}`.
- `connect` returns the authorize URL. The callback is a raw route (§5.3).
- `status` says whether the import is available: credentials plus `TWITCH_IMPORT_ENABLED`.

**Federation:**

- `federation.settings.{get, update}` (studio); `federation.followers.{list, remove}` (studio).
- `federation.admin.blocks.{list, add, remove}` (admin, audited).
- `federation.admin.keys.rotate({channel?})` (admin, audited).
- `instance.info().features.federation`.

**Relay:** the relay protocol gains a purge feed, `GET /api/relay/purges?after=<seq>`, answered
with a signed envelope `{payload: {seq, items: [{seq, prefix, reason}]}, signature}` (§4.3).

Every new procedure is a `notImplemented` stub (501) in a file the owning unit fills (§5.1).

### 2.5 Chat protocol (`src/chat.ts`)

- `ClientFrame` gains `room.join {roomId, token}`, `room.part`, `room.send {roomId, body}` and
  `room.sync {roomId, playheadWallclock, mode}`.
- `ServerFrame` gains `room.state`, `room.message`, `room.sync {target}` and `room.closed {reason}`.
- `CHAT_LIMITS` gains the `room` body length and rate.
- `NOTICE_CODES` gains `room_age_band`, `room_blocked`, `room_banned`, `room_full` and `room_closed`.

### 2.6 Events and internal (`src/events.ts`, `src/internal.ts`)

**Internal events** (decision (z), never offered to apps):

- `media.vod.state {vod_id, channel_id, public, reason}`
- `media.clip.state {clip_id, channel_id, public, reason}`
- `channel.suspension {channel_id, suspended}`
- `channel.moved {channel_id, moved_to}`
- `portability.import.finished {import_id}`
- `jury.panel.drawn {panel_id}`
- `federation.inbox.received {item_id}`

**Public events:** `channel.giveaway.begin` and `channel.giveaway.end` (EventSub catalog,
overlays).

**Job payloads and names:**

- `WATCH_ROOM_JOBS.retention`
- `PORTABILITY_JOBS.{moved, build, import}`
- `GIVEAWAY_JOBS.close` (timed close)
- `JURY_JOBS.{draw, close}`
- `FEDERATION_JOBS.{inbox, deliver, fanout, rotate, sweep}`
- `TWITCH_JOBS.import`
- `RELAY_PURGE_JOBS.emit`

**Keys:**

- `KEYS.roomPresence(roomId)` and `KEYS.roomSync(roomId)`
- `KEYS.rehearsalModerationSamples(broadcastId)` and `RehearsalReport.moderation.samples` (int ≥ 0;
  batch 6 follow-up)
- `KEYS.raidCarry` is not needed: the carry writes `KEYS.verifiedWatch` with a TTL. Check that
  key's shape at `internal.ts` and document it.

**Internal routes:**

- `INTERNAL_ROUTES.uploadCommit` (decision (p)): `{channelId, userId, key, purpose}` → `{key, url}`
  or a refusal code.
- Harness test hooks: run room retention now; age a room; run the jury draw now; set the purge feed
  hold to 1 s.

### 2.7 Tokens and relay tokens

- `packages/contracts/src/tokens.ts` refines (`:42-49`) allow `dvr/<vodId>` with `src = relay`
  (still refusing `dm`), mirrored in `relay/internal/tokens/playback.go` (`Binding.Check`
  `:199-208`, `:129-146`) and in vectors. The API keeps minting origin-only DVR tokens until
  W3-dvr-relay changes `playback.ts` (decision (x)).

## 3. Database (`packages/db`, part C)

### 3.1 `0045_b7.sql` (generated from schema changes)

**Rooms:**

- `watch_rooms`: id, host user, channel, broadcast, `age_band`, `invite_hash`, `created_at`,
  `ended_at`, `end_reason`.
- `watch_room_members`: room, user, `joined_at`, `left_at`; unique active per room and user.
- `watch_room_messages`: room, author id, body, `created_at`.
- All referenced by user id; covered by the deletion worker.

**Portability:**

- `move_links`: channel, `nonce_hash`, `created_by`, `created_at`, `revoked_at`, `expires_at`.
- `follows.source` (default `direct`) and `follows.move_link_id` (FK set null).
- `follow_portability_grants`: user, channel, `created_at`; PK (user, channel); cascade on user and channel.
- `channels.moved_to` (https URL), `channels.moved_at`.
- `portability_imports`:
  - who and where: user, channel, source, status;
  - the preview (public data only) and the result (per item: imported, skipped or rejected, with an opaque reason);
  - the emote-art assertion (`asserted_at`, `assertion_version`);
  - `standing_verified`, `created_at`, `finished_at`.
- `portability_signing_keys`, shaped like `integrity_signing_keys`.

**Giveaways:**

- `giveaways`: channel, title, prize text, eligibility jsonb, `winner_count`, `keyword`, status,
  `seed_commitment`, `seed` (null until drawn), `salt`, `opens_at`, `closes_at`, `drawn_at`,
  `created_by`.
- `giveaway_entries`: giveaway, user, pseudonym, `created_at`; PK (giveaway, user).
- `giveaway_winners`: giveaway, user, rank.

**Jury:**

- `jury_optins`: user, `opted_in_at`, `opted_out_at`.
- `jury_panels`: period, `seed_commitment`, `seed`, `opened_at`, `closed_at`.
- `jury_seats`: panel, user.
- `jury_cases`: panel, subject kind (`moderation_case` or `report`), subject id, clause ref,
  `pseudonym_map` (kept server-side only).
- `jury_votes`: case, seat, vote, reason code, `created_at`.
- `jury_flags`: case, `created_at`, `resolved_by`, `resolved_at`.

**Predictions:** `predictions.lock_media_ts`, `predictions.resolved_by`, `prediction_bets.media_ts`.

**Federation:**

- `federation_actors`: channel, enabled, `key_id`, public key PEM, encrypted private key,
  `key_created_at`.
- `federation_actor_keys`: history; not served.
- `federation_followers`: channel, remote actor id, inbox, shared inbox, `created_at`; unique per
  (channel, actor).
- `federation_domain_blocks`: domain, `created_by`, `created_at`.
- `federation_inbox_items`: raw headers and body, `received_at`, `processed_at`, outcome; 7-day
  cleanup.
- `federation_deliveries`: inbox URL, `first_failed_at`, `last_attempt_at`, status.
- `federation_objects`: stable id, kind (`note` or `video`), subject (broadcast, VOD or clip),
  `published_at`, `deleted_at`.

**Relay purge:** `relay_purges`: seq (bigserial), prefix, reason, `created_at`; 7-day cleanup.

### 3.2 `0046_b7_protections.sql`

- **Age band** (ADR 0017 decision 3): a trigger on `watch_room_members` insert refuses a member
  whose band, from `users.birth_date` on `current_date`, differs from the room's; a null or
  invalid birth date; an `adult` room on mature content (channel, broadcast or category) without
  `mature_confirmed_at`; and a full room (8 active members).
- **Follower count:** a trigger maintains `channels.follower_count` as the count of non-excluded
  follows. Remove the app's `±1` updates in `routes/channels.ts` and `account-deletion.ts` in the
  same change, and recount once in the migration (decision (aa)).
- **Draws:** `giveaways.seed_commitment` is immutable once set. `seed` can be set once, and only
  if `sha256(seed) = seed_commitment`. The same rule holds on `jury_panels`. `giveaway_winners`
  and `jury_votes` are append-only. `giveaway_entries` refuses inserts after `closes_at` or once
  the status is not `open`.
- **One open giveaway per channel:** a partial unique index.
- **Predictions:** a bet with `media_ts >= lock_media_ts` is refused; owner, moderators and
  editors cannot bet (check the role tables).
- **Jury:** a seat refuses a non-member (no active membership), a staff account, or a user without
  a live opt-in; a vote comes only from that panel's seat; `jury_cases` refuses T0 cases, NCII
  cases, cases under legal hold and `watch_room` reports.
- **Federation:** `federation_actor_keys` is append-only.
- **Move links:** at most `MOVE_LINK_RULES.maxActive` unrevoked links per channel.

### 3.3 Seed

- `jury.enabled = false`, `jury.panelSize = 7`, `jury.casesPerPanel = 20`.
- `surgeGuard.onRaid` default true; `federation.enabled` default false in channel settings.

## 4. Crypto (part D)

### 4.1 `packages/draw` (new, AGPL)

- `commit(seed) → hex sha256`; `verifyReveal(seed, commitment)`.
- `draw(seed, entries: string[] (sorted), count) → indices`, an HMAC-SHA256 with counter-based
  rejection sampling (no modulo bias), WebCrypto only.
- `pseudonym(salt, userId)`.
- `vectors.json` (commitments, draws over fixed lists including edge sizes 0, 1, 2^k ± 1,
  count ≥ entries) tested exhaustively.
- Used by giveaways and the jury.

### 4.2 `packages/federation` (new, AGPL)

Draft-cavage HTTP Signatures (ADR 0030 decision 4), on WebCrypto RSASSA-PKCS1-v1_5 SHA-256:

- `signRequest({method, url, headers, body, keyId, privateKey})` signs `(request-target)`, `host`,
  `date` and `digest`.
- `verifyRequest(req, publicKeyPem)` checks the date skew, digest equality and that `keyId`
  belongs to the actor.
- `digest(body)`; `generateActorKey()`; PEM import and export.
- `vectors.json` with signatures captured from Mastodon's documented examples plus tamper cases.

N4-delivery adds `activities.ts` and `objects.ts` (stubs exported from `index.ts` here).

### 4.3 Standing statement and purge signing (`packages/tokens`)

- **`src/standing.ts`:** `StandingStatement` (decision (n)), `sign` and `verify` with Ed25519,
  `deriveKid`. It reuses the attestation envelope pattern (`attestation.ts` `canonicalize`), but
  as its own file. AGPL; the SDK does not inline it.
- **Purge envelope:** `signPurgeBatch` and `verifyPurgeBatch` with the origin playback key
  (`PLAYBACK_SIGNING_KEY`), modelled on `signReceipt`; Go mirror in
  `relay/internal/tokens/purge.go`. Vectors in `vectors.json` (`standing`, `purge` sections),
  tested in TS and Go.

### 4.4 Package skeletons

- `packages/twitch` (new, AGPL): `package.json`, tsconfig, a workspace entry and an empty
  `src/index.ts`. Add `@commonair/twitch` to `services/{api,worker}/package.json` and
  `apps/web/package.json`; the web imports `panelPaste`. N3-import fills it.

### 4.5 SDK licence (decision (e))

- Change the SPDX header of every `packages/contracts/src` file that
  `packages/sdk/scripts/build.ts` inlines to `AGPL-3.0-or-later OR Apache-2.0`. Find them with
  `bun run --filter @commonair/sdk build -- --dry-run`, or with the list `unlicensedInline`
  prints; do not guess.
- Update `REUSE.toml` if annotations cover them.
- The SDK licence test and a build without `--allow-unlicensed-inline` must pass.

## 5. Seams (part E)

### 5.1 Stubs (one file per unit)

**Route files with `notImplemented` handlers:**

- `routes/{watch-rooms,portability,jury,twitch-import,federation}.ts`
- `routes/interact/giveaways.ts` (registered in `routes/interact.ts`)
- `services/api/src/relay/purges.ts` (mounted beside the relay protocol in `routes/relays.ts`)

**Hook stubs**, each called from the shared file named:

- `services/api/src/watch-rooms/evidence.ts`: `watchRoomEvidence(tx, roomId)`, called from the
  new `watch_room` branch of `subjectInfo` in `routes/safety.ts:69`. Like `message_set`, the
  report row's `channel_id` is null.
- `services/api/src/portability/attribution.ts`: `attributeFollow(tx, {followerId, channelId, moveLink})`,
  called from the follow handler in `routes/channels.ts`.
- `services/worker/src/deletion/watch-rooms.ts`: `deleteRoomData(tx, userId)`, called in
  `account-deletion.ts` beside the chat-message delete (`:329-332`). It removes the user's room
  messages and memberships and ends the rooms they host.
- `services/worker/src/exports/watch-rooms.ts` and a `portability` section: stub collectors
  registered in `EXPORT_FILES` (`collectors.ts:510`). Also a `bundle` export kind dispatched in
  `exports/build.ts` to `services/worker/src/exports/bundle.ts` (a stub).

**Worker job stubs** registered in `src/jobs/index.ts` under
`// Batch 7: W3, N3, N4.`: `watch-room-retention` (daily), `portability-moved`,
`portability-build`, `portability-import`, `giveaway-close`, `jury-draw` (monthly) and
`jury-close`, `federation-{inbox,deliver,fanout,rotate,sweep}`, `import-twitch`, `relay-purge`.

### 5.2 Outbox and media-state events (decision (z))

**Event writes.** Write `media.vod.state` and `media.clip.state` in the same transaction on every
path that makes a VOD or clip public or non-public:

- finalize to `ready` with public visibility (`services/media/src/vod/finalize.ts`);
- visibility updates (`routes/vods.ts`, `routes/clips.ts`);
- removal and restore (moderation, DMCA disable and restore, NCII, T0);
- expiry jobs.

Write `channel.suspension` on every suspension path listed in §0. Add a test per path, and a
grep-backed test that lists the paths, so a new path without an event fails.

**Outbox hook.** In `outbox.ts`, add `b7JobsFor(tx, handled, now)` beside `w2JobsFor`, in a new
`services/worker/src/b7/outbox-jobs.ts`. Map:

- `stream.online` → `FEDERATION_JOBS.fanout` (only when `FEDERATION_ENABLED` and the channel is
  federated)
- `media.*.state`, `channel.suspension`, `moderation.restriction` → `FEDERATION_JOBS.fanout` and
  `RELAY_PURGE_JOBS.emit`
- `channel.moved` → `PORTABILITY_JOBS.moved`
- `federation.inbox.received` → `FEDERATION_JOBS.inbox`
- `jury.panel.drawn` → nothing (audit only)

Use stable job ids. Unit-test the mapping.

### 5.3 HTTP, Caddy and the internal route

- **`services/api/src/http.ts` raw routes** call stub handlers in `services/api/src/federation/http.ts`:
  `/.well-known/webfinger`, `/.well-known/nodeinfo`, `/nodeinfo/2.1`, `GET /ap/channels/<uuid>`,
  `.../outbox`, `.../followers`, `POST /ap/channels/<uuid>/inbox`, `POST /ap/inbox` (shared).
- **More raw routes:**
  - `/.well-known/commonair-portability`, served from `portability_signing_keys`;
  - the Twitch OAuth callback `/api/twitch-import/callback` (stub in
    `services/api/src/twitch-import/callback.ts`).
- **`INTERNAL_ROUTES.uploadCommit`:** a handler in `services/api/src/moderation/internal-commit.ts`
  that calls the existing `commitUpload` with the given purpose, behind the
  `INTERNAL_SECRET_HEADER` check (`http.ts:115-116`). Add an integration test that a T0
  fixture image is refused and enqueues the T0 job exactly as a user upload does.
- **`infra/caddy/Caddyfile`** (near `:178-182`): `handle /.well-known/webfinger`, `/.well-known/nodeinfo`,
  `/.well-known/commonair-portability` and `/nodeinfo/*`, rewritten under `/api`; `handle /ap/*`
  to the API (content negotiation stays in the API: an HTML `Accept` on an actor id redirects to
  the channel page). `/m/*` stays on web.

### 5.4 Chat, interact web and player

- **Chat dispatch.** `server.ts` `handleFrame` dispatches the `room.*` ops to
  `services/chat/src/watch-rooms.ts` (a stub `WatchRooms` class with `join/part/send/sync`).
  `core.ts` gives it the filter pipeline and the bus. The bus control ops gain `room.close` and
  `room.kick`, for bans issued during a room.
- **Plugins.** The registry registers `services/chat/src/plugins/giveaway.ts` (a stub; no-op
  while `GIVEAWAYS_ENABLED` is false).
- **Interact web state.** `apps/web/src/chat/interact/{state,client,use-chat-interact}.ts` gain
  giveaway state and calls, and the prediction bet passes `mediaTs` and `playbackMode` from the
  player seam (`playheadWallclock`, `playbackMode`).
- **Chat panel mounts.** `chat-panel.tsx` mounts `GiveawayCard` (stub, renders null) and a
  `WatchRoomDrawer` slot (stub).
- **Player.** No change: rooms use `setTargetLatency` (`controller.ts:334`), `seekToWallclock`
  and `playheadWallclock`.

### 5.5 Config (`packages/config/src/env.ts`, `.env.example`; a test keeps them in sync)

- `GIVEAWAYS_ENABLED` (bool, default false; api, worker, chat).
- `TWITCH_IMPORT_ENABLED` (bool, default false; api, worker), `TWITCH_API_BASE_URL`
  (default `https://api.twitch.tv/helix`), `TWITCH_AUTH_BASE_URL` (default
  `https://id.twitch.tv/oauth2`), `TWITCH_IMAGE_HOSTS` (default `static-cdn.jtvnw.net`).
- `FEDERATION_ENABLED` (bool, default false; api, worker).
- `PORTABILITY_SIGNING_KEY` (`__generate_ed25519__`, worker only; `init-env` handles it).
- `API_INTERNAL_URL` and `INTERNAL_API_SECRET` on the worker schema.
- Regenerate the self-host key lists (`bun scripts/selfhost/unit-env.ts`).
- Read every value through `loadEnv`.

### 5.6 Media seam (batch 6 follow-up)

- `ModerationDeps.valkey` (`services/media/src/moderation/moderation.ts:67`) widens to `incr` and
  `expire`, so B7-followups can count rehearsal samples. Wire it in the media service.

## 6. Web scaffolding (part F)

- **Placeholder routes:**
  - `_app/m.$channel.$nonce.tsx`, `_studio/move.tsx`, `_studio/import.tsx`;
  - `_app/$channel_.giveaways.$giveawayId.tsx` (public verify page; `$channel_` as in W2, because
    `$channel.tsx` has no outlet);
  - `_app/coop.jury.tsx`, `_admin/admin.federation.tsx`.
- **Mounts:**
  - a federation settings section on the studio stream settings page (stub
    `components/federation/settings.tsx`);
  - a portability section on `/settings/privacy` (stub `components/portability/grants.tsx`);
  - the jury results slot on `routes/_app/transparency.tsx` (stub
    `components/transparency/jury-results.tsx`);
  - the watch-room evidence renderer in the mod queue item (stub
    `components/safety/watch-room-evidence.tsx`);
  - the "moved to" notice on the channel page (stub `components/portability/moved-notice.tsx`).
- **Nav entries** for the new studio pages and the jury.
- **Empty namespaces** (decision (ac)): `en` and `es` `{}`, then `bun run i18n:gen`.
- **`SEED_ROUTES` rows** for every new route (`harness/src/seed/routes.ts`; seed publishes a
  `giveawayId` and a move-link nonce in `store.extra`).
- **`docs/testing/b7-selectors.md`** (routes; test ids, including N4-web's `federation-enabled`,
  `federation-handle`, `federation-followers`, `federation-follower-remove`, `federation-block-add`
  and `federation-blocks`; scenario steps), checked by
  `apps/web/tests/selectors.test.ts` with a `PENDING_B7_IDS` list.

## 7. Harness and CI (part F)

- **`harness/src/w3/steps.ts`:**
  - `WATCH_ROOM_STEPS`, `PORTABILITY_STEPS`, `TWITCH_IMPORT_STEPS`, `FEDERATION_STEPS`, each with
    a `PENDING_*` list and prerequisites.
  - `W3_EXTENSIONS`:
    - `interact: [giveaway, surge-raid, fair-prediction]`
    - `e5-coop: [jury]`
    - `e2e-relay: [dvr-relay, dvr-purge, relay-vtt]`
    - `trust-safety: [sor-resolve]`
    - `integrity-basic: [group-appeal-threshold]`
    - `rehearsal: [moderation-samples]`
  - A `PENDING_W3_EXTENSIONS` list, and `W3_EXTENSION_UNITS` mapping each extension to its unit
    and file.
  - Same shape as `harness/src/w2/steps.ts`. Wire `ctx.param("w3","")` into those scenarios.
- **Scenario stubs** `watch-room`, `portability`, `twitch-import` and `federation` (pending steps),
  `inFull` true, in `FULL_REQUIRED` (`harness/src/registry.ts:33`).
- **The `w3` shard** in `FULL_SHARDS` (`harness/src/shards.ts:11-25`): not path-filtered.
- **Overlays:**
  - `harness/compose.n3.yaml`: fake `OAUTH_TWITCH_*`, `TWITCH_IMPORT_ENABLED=true`, and the
    `TWITCH_*_BASE_URL` overrides pointing at the in-harness mock. Reachability as the
    `harness/src/e9/receiver.ts` callback; `OUTBOUND_ALLOW_PRIVATE_NETWORKS` for the worker.
  - `harness/compose.n4.yaml`: `FEDERATION_ENABLED=true` and `OUTBOUND_ALLOW_PRIVATE_NETWORKS`.
  - `harness/compose.w3.yaml`: `GIVEAWAYS_ENABLED=true`.
  - All layered for the `w3` and `interact` shards and their scenarios. Follow how
    `stack --harness` picks overlays.
- **The notify shard** (batch 6 follow-up): read the scenario-step durations of the latest full
  run's `verify (harness notify)` job. If it is over about 12 minutes, move `rehearsal` to `w3`.
  Record the numbers in the `shards.ts` comment.
- **CI:** `scripts/ci-changes.ts` needs nothing new (the `w3` shard is not filtered). Confirm that
  the matrix picks it up from `FULL_SHARDS`.

## 8. Done means

- `bun run verify` is green in CI on the pushed commit, and every stub returns `notImplemented` or a
  pending harness step.
- No unit-owned behaviour is implemented here, except the seams, the event writes, the triggers
  and the crypto with vectors.
- `vectors.json` sections are tested in TS and Go.
- The new ADRs are written with status "proposed (maintainer to accept)".
- PROGRESS "In flight" gets a "Batch 7 contract step merged" paragraph listing what landed, what
  differs from this file, and the notify-shard numbers.
