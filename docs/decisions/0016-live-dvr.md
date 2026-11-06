<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0016: Live DVR

- Status: accepted (2026-10-27; the maintainer accepted the recommended answers, see
  [Decisions at acceptance](#decisions-at-acceptance-2026-10-27)).
  [Amendment 1](#amendment-1-the-signed-relay-purge-relay-dvr-and-relay-captions) (relay purge,
  relay DVR, relay captions) proposed 2026-11-01, maintainer to accept.
  [Amendment 2](#amendment-2-relay-issuance-for-dvr) (relay issuance for DVR) accepted by the
  orchestrator 2026-11-06, for post-launch review
- Date: 2026-10-27 (code checked at `ccf9c17`)
- Gates: W2-dvr ([W2 plan](../../.claude/briefs/next/W2-feature-wave.md)); its v2 gates
  W3-dvr-relay ([W3 plan](../../.claude/briefs/next/W3-feature-wave.md))

## Context

Free Live DVR (feature-wins §4.12) lets any viewer of a live stream drag back, then press L to be
live again. Twitch's Stream Rewind is limited to subscribers and Turbo; ours is free, and it is
honest about the difference between watching live and catching up. Debate log items 3 and 21 chose
a storage-backed v1 over a recorder buffer, and found that the VOD prefix was public. What the code
has today:

- **The recording is already in object storage, privately.** The recorder copies the source path
  (`-c copy`) and, when the channel has VODs enabled, uploads each closed segment and then the
  playlist under the VOD's `storage_prefix` (`services/media/src/vod/recorder.ts:4-13`, `:207`,
  `:251-272`), re-rendering the playlist on each poll (`:66`). Segments are 4 s
  (`services/media/src/settings.ts:55`). VODs are off by default (`channels.vod_enabled`,
  `packages/db/src/schema/channels.ts:54`).
- **ADR 0009 amendment 1 has landed.** New recordings go under `recordings/<vodId>/`, which no
  public route serves (`packages/contracts/src/storage.ts:13-20`); `/media/vods/…` checks the VOD's
  state before serving (`services/origin/src/media.ts:131-153`); non-public VODs play through the
  token-checked `/vod/<vodId>/<file>?t=…` route (`services/origin/src/vod.ts:4-14`), whose token is a
  `PlaybackClaims` with `path = vod/<vodId>` (`storage.ts:67-73`), behind a 5 s per-VOD state cache
  shared by both routes (`services/origin/src/origin.ts:131-148`). Caddy routes `/vod/*` to the
  origin (`infra/caddy/Caddyfile:201`). The `/vod` route serves only `ready` VODs, so nothing reads a
  recording while it is live.
- **The origin has three live pull routes** (`/hls`, `/relay-pull`, `/cdn`,
  `services/origin/src/handler.ts:5-9`) plus `/media`, `/vod` and the P2P digest route, dispatched by path
  prefix in `origin.ts:145-150`. There is no general route seam yet; the W2 contract step adds one
  (`W2-feature-wave.md:20`).
- **Relays cannot forget.** The relay cache is an LRU with `Get` and `Put` and size eviction only
  (`relay/internal/cache/lru.go:47-67`); nothing purges an entry on removal. Relay tokens are bound
  to a path prefix (`relay/internal/tokens/playback.go:173-179`), and the API mints them for the
  broadcast's `live/<slug>` path (`services/api/src/routes/playback.ts:66-77`, `:154`).
- **Live tokens are short.** Playback tokens live 120 s (`packages/contracts/src/tokens.ts:44`) and
  heartbeats refresh them; the player always sends the current one
  (`apps/web/src/player/controller.ts:126-129`).
- **Counting has no mode.** The heartbeat (`packages/contracts/src/api/entities.ts:273`) carries
  played seconds, rendition and latency but no playback mode; concurrency ranks live sessions with no
  notion of catching up (`packages/integrity/src/concurrency.ts:19`, `:93`). W1's contract adds
  `playbackMode`.
- **Mature and restricted streams are gated at start** (`services/api/src/routes/playback.ts:116-151`).

ADR 0012 already set two things DVR depends on: every output's PDT equals the source PDT, and part 2
(deferred to W1) gives chat sent from DVR a null `media_ts`. ADR 0012 also left two questions to
this ADR: MediaMTX native recording (R2) and a production rung-skew gauge.

There are no self-hosters and no public instance, so nothing below needs a migration window.

## Decisions

### 1. Storage-backed, source-only v1

DVR reads the live recording from object storage: the recorder's playlist and segments under
`recordings/<vodId>/`. No new buffer, no new process, no recorder rewrite. MediaMTX native recording
(ADR 0012's R2, which that ADR left for this one) is not needed and is not taken.

The recording is the source copy, so DVR is **source-only**: no ABR ladder in DVR. The player says
so. Recording the ladder would multiply storage writes and cost by the rung count for a feature
whose first question is whether people use it; it stays a v2 option, costed in `infra_costs` if
taken. Since nothing in DVR is re-encoded, no production rung-skew gauge is needed for DVR. That
closes the item ADR 0012 deferred to DVR (its Consequences and acceptance item 6).

Because DVR reads the VOD recording, **a broadcast has DVR only while it records a VOD**. A channel
with VODs off has no DVR in v1, and the studio says that turning on VODs turns on DVR. A DVR-only
recording (deleted at broadcast end) is a v2 option. The creator can turn DVR off while keeping
VODs (`channels.dvr_enabled`, new, default `true`).

The DVR window is `channels.dvr_window_seconds` (new), capped by a new instance setting
`DVR_MAX_WINDOW_SECONDS` (`packages/config/src/env.ts` and `.env.example`, default 7200). The
minimum distance behind live is set by upload lag: a segment is readable only after it closes and
uploads (4 s segments), so the DVR playlist ends roughly two segments behind the live edge, and the
player switches to the live route for anything closer.

### 2. A token-checked `/dvr/` origin route, with visibility inherited from the VOD

New `services/origin/src/dvr.ts`, registered through the W2 route seam:
`GET|HEAD /dvr/<vodId>/<file>?t=…`. The token is a `PlaybackClaims` with `path = dvr/<vodId>`,
`src = "origin"`, the live session's id, and the live 120 s lifetime, refreshed by heartbeats like
the live token. No new crypto and no new relay vectors. `playback.start` returns
`dvrWindowSeconds` (zero when there is no DVR) and the DVR URL with the session.

The route reads `recordings/<vodId>/index.m3u8`, cuts it to the window, and rewrites every URI to
carry the token, as `/vod` does. Responses are `cache-control: private`.

**Visibility inherits the VOD gate.** The API mints a DVR token only when the caller may watch the
live stream (including the mature and restriction gates) **and** the VOD's visibility would admit
them (`vodShown`): a `public` VOD gives everyone DVR, `subscribers` gives subscribers DVR, `private`
gives DVR only to the owner. Why: a viewer must not be able to rewind into content they could not
watch as a VOD five minutes later.

### 3. State is re-checked on every playlist request

Each DVR playlist request checks, through the shared 5 s per-VOD state cache: the VOD is
`recording`, not removed, the broadcast is live and not T1-restricted, and the channel is not
suspended. Segment requests check the same cached state. After a mid-stream T0, restriction or
removal the cached state no longer admits the VOD, so DVR answers 404 within 5 s on every origin instance
(ADR 0009 amendment 1's meaning of "immediately"). This is a new predicate beside `vodPlacement`
in `@commonair/contracts/storage`, so the origin and tests share one definition.

### 4. In-progress recordings stay private

Unchanged from ADR 0009 amendment 1: in-progress objects live under `recordings/`, the `/dvr/`
route is their only reader, and finalize moves them to `vods/` on publish when the VOD is public.
DVR adds no public path to a recording.

### 5. Origin-only: relays and the CDN never serve DVR in v1

DVR segments are relay-ineligible. A relay cache cannot purge a removed segment (it has no purge
path), so a relay-served DVR would keep serving removed media until LRU eviction. The binding already
enforces this: relay tokens cover `live/<slug>` and a DVR path is not under it, and the `/dvr/`
route refuses any `src` but `origin`. The CDN pull route (`/cdn/live/…`) does not cover `/dvr/`, and
`private` responses are not cacheable. The draft line that relays cache DVR without changes is
deleted.

**v2 prerequisite: a signed relay purge.** W3-dvr-relay first adds a signed purge message the relay
verifies and applies to its cache, with the `e2e-relay` scenario proving that a removal purges a
cached DVR segment; only then may relay tokens cover DVR paths.

### 6. Counting: "watching live" and "catching up"

Heartbeats carry a playback mode and `behindLiveSeconds` (both new: the W1 contract step adds the
mode, and feature-wins §4.12 adds `behindLiveSeconds`). A session in DVR mode counts
as **catching up**:

- it is not a live viewer: it does not count toward concurrent viewers, discovery ranking,
  transcode thresholds or patronage viewer-hours;
- its played seconds still accrue verified watch time for the verified-watch gate (feature-wins
  §4.12, "Integrity and T&S").

The split lives in `packages/integrity/src/concurrency.ts`. The integrity fetch signal
(`packages/integrity/src/signals/fetch.ts`) judges an origin session by the per-session fetch
counters the origin records, today only on the `/hls` route
(`services/origin/src/handler.ts:154-165`). So that DVR seconds can verify at all, the `/dvr/`
route records its playlist and segment fetches for the session too, marked as DVR (new), and the
signal judges each mode's claimed seconds against that mode's fetches. A client that claims `live`
while fetching only from `/dvr/` shows no live fetches and fails the signal, so it gains nothing. The public count shows both numbers.

### 7. DVR is excluded from data mode

Data mode (W1, [ADR 0018](0018-data-mode-claim.md)) caps the rendition. DVR has only the source
rendition, so a data-mode session cannot rewind: the `/dvr/` route refuses a token carrying `dm`
(ADR 0018 decision 7), and the player hides the DVR control in data mode rather than silently
using more data than the viewer asked for.

### 8. `media_ts` is null for messages sent from DVR

Chat sent while the sender is in DVR mode carries a null `media_ts`, so the Timeline Spine places it
by receive time, not at the old media time the sender was watching (ADR 0012 part 2's clamp, "DVR
null"). Anchoring it to the rewound time would let a late viewer insert messages into the past.

## Consequences

- W2-dvr builds `dvr.ts` on the route seam, the DVR token path, a `dvr` state predicate in
  `@commonair/contracts/storage`, the channel fields and the instance cap (contract step), the
  count split in `packages/integrity`, DVR fetch accounting for the fetch signal (decision 6), and
  `apps/web/src/player/dvr*.tsx`. Caddy gains
  `handle /dvr/*` → origin.
- DVR egress is origin egress in v1, plus object reads from the bucket; it is shown in Analytics.
- Channels with VODs off have no DVR. That is a real limit of v1 and the studio says so.
- Removal latency for DVR equals the VOD routes' 5 s.
- `live-dvr` harness: DVR minutes are not counted live but do verify; removed and in-progress
  segments answer 404 through `/media` and through `/dvr/` after removal; a relay request for a DVR
  segment is refused; a `subscribers` VOD's DVR refuses a non-subscriber.
- Captions in DVR: if W2-captions lands its track under the VOD prefix (ADR 0011 decision 6), the
  DVR playlist can add the `SUBTITLES` rendition; otherwise it follows in v2.

## Alternatives considered

- **A recorder buffer (local disk or Valkey) for the last N minutes.** Lower lag behind live, but
  a second copy of the media to purge on removal and a new owner key across hosts. Kept as v2,
  "recorder-buffer v2 with a Valkey owner key" (feature-wins §4.12 open questions).
- **Recording the ladder.** Rejected for v1 on cost (decision 1).
- **Serving DVR from `/vod/`.** Rejected: `/vod/` serves only `ready` VODs with a long-lived token;
  DVR is part of a live session and needs live-length tokens and a different state predicate.
- **Relays cache DVR now.** Rejected until a signed relay purge exists (decision 5).
- **DVR without inheriting VOD visibility.** Rejected: it would open rewinding to viewers who may
  not watch the VOD (decision 2).

## Decisions at acceptance (2026-10-27)

The maintainer accepted the recommended technical defaults:

1. **Storage-backed, source-only v1.** No ladder recording; v2 option.
2. **Visibility** inherits the VOD's.
3. **Private in-progress prefix**, as ADR 0009 amendment 1 already decided.
4. **Origin-only.** Relays do not cache DVR until a signed relay purge exists; that purge is the v2
   prerequisite (W3-dvr-relay).
5. **Count semantics.** DVR sessions are "catching up": they accrue verified watch time for the gate
   but are not live viewers, and only live feeds discovery and patronage.
6. **Data mode.** DVR is excluded.
7. **`media_ts`** is null for messages sent from DVR (ADR 0012 part 2).

Also settled here (no separate question was asked): DVR needs the VOD recording in v1, the creator
can turn DVR off, and the window cap is an instance setting with a 2 h default.

## Amendment 1: the signed relay purge, relay DVR and relay captions

- Status: proposed (maintainer to accept; see
  [Amendment 1 decisions at acceptance](#amendment-1-decisions-at-acceptance))
- Date: 2026-11-01 (code checked at `3bb7af9b`)
- Gates: W3-dvr-relay ([batch 7 contract step](../../.claude/briefs/w3/contract-step.md) §2.4,
  §2.7, §3.1, §4.3, §5.2; [brief](../../.claude/briefs/w3/W3-dvr-relay.md)); batch 7 decisions
  (x) and (y)

**No counsel retained; listed for post-launch review** (batch 7 decision (h)). Nothing in this
amendment turns on a legal question; the note is recorded for consistency.

Decision 5 kept DVR origin-only until a signed relay purge exists. This amendment defines that
purge and the rules under which relays may then serve DVR. It also settles relay captions, which
batch 6 left counted and pinned like segments.

What the code has at `3bb7af9b`: relays poll the API (register, a heartbeat every 15 s, receipts;
`relay/internal/apiclient/client.go:121-147`), and the heartbeat answer carries `originPublicKey`,
the public half of `PLAYBACK_SIGNING_KEY` (`:76-79`). The relay cache (`relay/internal/cache/lru.go`)
has no purge. Relays count every fetched file toward receipts (`Ledger.AddSegment` / `AddBytes`,
`relay/internal/server/server.go:448-451`), `.vtt` included.

### A1.1 Purges are rows, emitted from the media-state events

- **Events** (contract step, batch 7 decision (z)): `media.vod.state` and `media.clip.state`
  (`{id, channel_id, public, reason}`, written on every path that makes a VOD or clip public or
  non-public) and `channel.suspension` (`{channel_id, suspended}`, written on every suspension
  path). They are internal: never offered to apps.
- **Emitter.** The outbox hook `b7JobsFor` maps `media.*.state`, `channel.suspension` and
  `moderation.restriction` (and `stream.offline` for an ended recording) to
  `RELAY_PURGE_JOBS.emit`. The job inserts `relay_purges` rows (`seq` bigserial, `prefix`,
  `reason`, `created_at`) in the same transaction as its dedupe marker, idempotent per event id:
  - `dvr/<vodId>/` when a VOD stops being public or its recording ends;
  - `live/<slug>/` when a live channel is T1-restricted or suspended;
  - `live/<slug>/captions/` where only captions must go.
- **Prefixes.** A prefix ends in `/` and matches
  `^(?:live|dvr)/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*/)+$`, at most 256 bytes: only the relay's own
  cache trees, and no segment starts with a dot, so `..` cannot occur.
- **Reasons.** The `reason` is a code, never free text (ADR 0004). The origin writes only
  `RELAY_PURGE_REASONS` (`vod_hidden`, `clip_hidden`, `restricted`, `suspended`,
  `recording_ended`); the wire rule is `^[a-z][a-z0-9_]{0,31}$`, so a relay accepts codes added
  later and only logs and counts them.
- **Retention.** A daily cleanup drops rows older than 7 days (`RELAY_PURGE_RULES.retentionDays`).

### A1.2 The purge feed: a long poll with a signed answer

- **Request.** `GET /api/relay/purges?after=<seq>`, with the relay protocol's bearer auth.
- **Answer.** The rows after `after`, oldest first, at most 500 (`RELAY_PURGE_RULES.maxItems`;
  more rows wait for the next poll), as the signed envelope `{ payload, signature }`
  (`RelayPurgeFeed`). `payload` is the base64url of the canonical JSON of a `PurgeBatch`
  `{ seq, items: [{ seq, prefix, reason }], reset? }`.
- **The `seq` cursor.** Item `seq`s are the rows' `relay_purges.seq`, strictly ascending.
  `payload.seq` is the cursor: the last item's `seq` when there are items, otherwise the request's
  `after` (or, for a reset, the newest row's `seq`, or `after` if there is none). The relay
  applies every item, then sends `payload.seq` as the next `after`; a row at or below a relay's
  cursor is never sent to it again.
- **Hold.** With nothing new, the API holds the request up to **25 s**, woken early by a Valkey
  pub/sub nudge from the emitter, then answers an empty batch. A harness hook shortens the hold to
  1 s.
- **Reset.** A relay whose `after` is older than the retained rows (rows after it have been
  deleted, so it is more than 7 days behind) gets a signed batch with `reset: true` and no items
  (the key is present only when true; a batch carrying both is malformed). "Older than the retained rows" is
  not read from the rows themselves: `bigserial` leaves gaps (rolled-back inserts), so
  `min(seq) > after + 1` would reset relays for nothing. The cleanup job records the highest `seq`
  it deleted as a watermark, and a request whose `after` is below that watermark gets the reset.
  The watermark is kept in Valkey (`KEYS.relayPurgeWatermark`), only ever raised, and written
  before the delete; a cursor above every issued `seq` (a database reset) is also answered with a
  reset. The relay evicts every
  cached `live/` and `dvr/` object and continues from the answer's `seq`. Replaying a reset only
  empties the cache again, which is safe. A relay that restarts has an empty cache and starts from
  0, receiving the retained rows.
- **Signature** (`packages/tokens`: `signPurgeBatch`, `verifyPurgeBatch`; Go mirror
  `relay/internal/tokens/purge.go`; vectors under `purge` in `packages/tokens/vectors.json`, tested
  in TS and Go, including the reset cases): Ed25519 with the origin's playback key, which relays
  already trust as `originPublicKey`. As with receipts, `payload` and `signature` are base64url
  (no padding; the signature is 86 characters) and the signed bytes are the JSON of the Zod-parsed
  payload in schema key order (`seq`, `items`, `reset`). The relay verifies the signature over the
  bytes before parsing, then refuses bytes that are not the canonical encoding of what they parse
  to (`non_canonical`) and any schema violation (`malformed`). The contracts mirror
  (`RelayPurgeBatch`) is kept equal to `PurgeBatch` by a test in `packages/tokens`.
- **A bad signature** refuses the whole batch (logged and counted); the relay keeps its `after`
  and polls again with backoff. So does a non-reset batch whose `seq` is below the relay's cursor,
  or with an item outside `(after, seq]` (a replayed old batch never moves the cursor back).
- **Why signed, if the channel is authenticated.** The purge is an instruction to the relay's cache
  from the origin, and the relay already holds the origin's key: a signature makes it the origin's
  instruction whatever path carried it. A replayed old batch is refused (above), and could only
  purge again anyway, which is safe;
  a withheld batch is covered by A1.3.

### A1.3 Relay DVR rules

From this amendment on, the token rules (TS refine in `packages/contracts/src/tokens.ts`, Go
`Binding.Check` in `relay/internal/tokens/playback.go`, and the vectors) allow a `dvr/<vodId>`
path with `src = relay` and a matching `rid`; a token carrying `dm` is still refused (decision 7). The API mints **no** relay DVR token until W3-dvr-relay lands; origin- and
CDN-assigned sessions keep origin DVR, so the CDN still never serves DVR.

A relay serving DVR:

- pulls from the origin's `/relay-pull/dvr/<vodId>/…`, with the live pull's relay auth and the same
  state checks and window cut as `/dvr/` (decision 3);
- refreshes the playlist when its copy is more than **1 s** old;
- serves a segment only while its current playlist lists it **and** its last successful playlist
  fetch is under **5 s** old, else answers 404;
- evicts the VOD's whole prefix at once on a 404 or 403 from the origin, and on a purge;
- keeps a prefix tombstone for 60 s after a purge, so an in-flight fill for a purged prefix is
  dropped instead of cached;
- caches segments with an expiry of the DVR window, and answers with
  `cache-control: private, no-store`;
- counts DVR bytes and segments toward its receipts, so ADR 0016 decision 6's fetch judging uses the
  relay's evidence for relay-served DVR.

**Removal latency.** Without any purge, removal reaches a relay within about 5 s: the origin's
shared state cache refuses the playlist within 5 s (decision 3), and a relay re-reads it at most
1 s later and evicts; a relay that cannot reach the origin stops serving 5 s after its last good
fetch. A purge evicts as soon as the long poll delivers it.

### A1.4 Relay captions (decision (y))

Caption files under `/captions/` ending in `.vtt` change while a stream is live, and they are not
media segments. The relay neither counts them (no `AddSegment` / `AddBytes`) nor pins them: they
are cached for 30 s and served with `max-age=30` (not `immutable`), with a Go test for each rule.
When W3-dvr-relay merges, the orchestrator sets `captionsReachable` for relay pulls
(`services/origin/src/handler.ts:157-161`), so relay viewers get the `SUBTITLES` rendition.

### A1.5 Consequences of the amendment

- Relays can carry DVR egress, which was all origin egress in v1.
- Removal on relays is bounded twice: by the purge (about as fast as the outbox) and by the 5 s
  stale-playlist rule (even if every purge is lost).
- Relays stop counting caption polls as delivered segments, so receipts measure media only.
- The purge feed is one more long-lived request per relay, held at most 25 s.

### Amendment 1 decisions at acceptance

For the maintainer. Each item is the recommended default; accepting the amendment accepts them.

1. **Purge before DVR (x):** relays may serve DVR only with the signed purge in place.
2. **Feed:** `relay_purges` rows from the media-state events, a 25 s long poll, at most 500 rows,
   7-day retention, a signed `reset: true` batch for a relay further behind.
3. **Signature:** Ed25519 with the origin playback key, verified with `originPublicKey`.
4. **Relay DVR:** 1 s playlist refresh, 5 s stale-playlist rule, immediate eviction on 404/403 or
   purge, 60 s tombstones, `private, no-store`, counted in receipts; still no CDN DVR.
5. **Captions (y):** `.vtt` on relays is neither counted nor pinned (30 s cache, `max-age=30`);
   `captionsReachable` flips for relay pulls at the W3-dvr-relay merge.

## Amendment 2: relay issuance for DVR

- Status: accepted (by the orchestrator, 2026-11-06, with the conservative defaults below; listed
  for the maintainer's post-launch review)
- Date: 2026-11-06 (code checked at `079cfc83`)
- Gates: the release follow-up "issuance gives a relay nothing for DVR pulls"

**No counsel retained; listed for post-launch review.** Nothing here turns on a legal question.

**The gap.** Relay receipts are checked against `relay_issuance`, which the origin computes per
relay and minute as sessions × what MediaMTX produced in that minute (`services/origin/src/issuance.ts`).
A relay that serves only DVR pulls nothing live, so a minute with only DVR sessions on it had
sessions and zero bytes issued. The worker reads that as a gap in the record (`gap_minutes`), so
the receipt is "issuance unknown", which proves nothing for the fetch signal (decision 6). A DVR
session on a channel with no live viewer could never verify through a relay; the `relay-dvr`
harness scenario kept a live viewer to work around it (`5b133a98`).

**A2.1 What the origin counts.** `/relay-pull/dvr/` (A1.3) records every whole segment it serves
a relay (GET, 200, not HEAD and not a range) in a per-VOD Valkey sorted set (`issuance:dvr:<vodId>`,
`services/origin/src/dvr-issuance.ts`): member `<bytes>:<durationMs>:<file>` (the duration from the
recording's EXTINF, 0 for an init segment), score the latest pull time. Entries older than
`DVR_MAX_WINDOW_SECONDS` + 20 minutes are trimmed on write and the key expires after the same.
Every object a relay serves it first pulls from the origin, so these pulls are a superset of what
any relay can serve.

**A2.2 Which pulls a minute can use.** A relay caches a DVR segment for at most the DVR window
(A1.3), so an object served in the minute `[start, end)` was pulled in
`[start − DVR_MAX_WINDOW_SECONDS, end)`. Only those count: the bound is scoped to the window.

**A2.3 One DVR session's allowance.** DVR plays at 1× (the player pins DVR to rate 1), so in a
minute a session fetches at most **120 s** of the recording (`DVR_ISSUANCE_SPAN_SECONDS`): 60 s of
playback plus a seek's buffer refill and room-sync catch-up. The allowance is the heaviest pulled
segments, largest first, until their durations cover 120 s plus one segment (playback starts and
ends inside a segment), plus the largest init segment. For the recorder's uniform 4 s segments
this is at least what any contiguous 120 s weighs; the receipt verifier's tolerance applies on top.
Nothing pulled means nothing issued, as for live.

**A2.4 Which sessions get it.** A relay session that has rewound (its last heartbeat mode is `dvr`,
or it has credited `dvr_seconds`) gets, per field, the larger of its live allowance and its
broadcast's DVR allowance (the largest over the broadcast's VODs, whatever their status, so a
recompute after the stream ended gives the same answer). A session that never rewound keeps the
live allowance alone. Using `dvr_seconds` as well as the mode keeps a session that returned to
live covered for the minutes it spent in DVR, which the 5-minute recompute revisits.

**A2.5 What does not change.** No contract or schema change: `relay_issuance` keeps its columns,
the receipt has no mode (A1.3), and the worker's check, tolerance and standing rules are as before.
The live formula is unchanged for sessions that never rewound. Origin- and CDN-assigned DVR
sessions are judged on the origin's own fetch log as before.

**Consequences.**

- A DVR-only relay session can verify; the `relay-dvr` scenario no longer needs a live viewer for
  that (dropping it is left to the harness owner).
- A rewound session's live minutes are bounded by max(live, DVR) instead of live: a relay can
  over-report a rewound session by up to about two minutes of the heaviest recording segments per
  minute and stay verified. That is the price of not knowing, per minute, which mode a session was
  in; the heartbeat mode history would tighten it and is not stored.
- One more Valkey write per DVR segment a relay pulls (pulls, not viewer fetches: a relay pulls
  each segment once per window), and one range read per VOD with rewound relay sessions per
  recomputed minute.

### Amendment 2 decisions (taken by the orchestrator, conservative)

1. **Span:** 120 s of media per DVR session per minute (60 s at 1× plus a buffer refill).
2. **Rewound:** mode `dvr` or `dvr_seconds > 0`; such a session gets max(live, DVR) per field.
3. **Scope:** pulls in `[start − DVR_MAX_WINDOW_SECONDS, end)` (the instance cap, not the
   channel's window, so a channel's later change of window never shrinks a past minute).
4. **Key:** `issuance:dvr:<vodId>` lives in the origin until the orchestrator moves it to
   `KEYS` in `@commonair/contracts/internal`.
