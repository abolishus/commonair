<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0016: Live DVR

- Status: accepted (2026-10-27; the maintainer accepted the recommended answers, see
  [Decisions at acceptance](#decisions-at-acceptance-2026-10-27))
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
