<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0018: `dataMode` as a playback token claim

- Status: accepted (2026-10-27; the maintainer accepted the recommended answers, see
  [Decisions at acceptance](#decisions-at-acceptance-2026-10-27))
- Date: 2026-10-27 (code checked at `ccf9c17`)
- Scope: the ADR 0018 candidate in [feature-wins.md §7](../product/feature-wins.md#7-decisions-needed)
  for W1b-data-mode (feature-wins §4.6, [W1-quick-wins](../../.claude/briefs/next/W1-quick-wins.md)):
  the claim in TypeScript, Go and the shared vectors, where it is minted, what reads it, and what
  it leaves alone (ADR 0005's caps, DVR).

## Context

Any-Connection Mode lets a viewer on a metered connection set a data budget (say 50 MB an hour).
The player picks renditions under it, drops to audio-only below the lowest rung, and shows a usage
meter. The budget controller is client code (`apps/web/src/player/budget.ts`, new). The question
for this ADR is what the server side needs to know, and how it learns it.

What the code has at `ccf9c17`:

- **The claim set.** `PlaybackClaims` is `v, sid, cid, path, src, rid?, iat, exp`, with a refine
  that `rid` is present exactly when `src` is `relay` (`packages/contracts/src/tokens.ts:19-42`);
  tokens live 120 s (`:44`). A VOD token is the same shape with path `vod/<id>` (`:26-33`,
  `packages/contracts/src/storage.ts:73-75`).
- **Signing strips unknown keys.** `signPlaybackToken` serialises `PlaybackClaims.parse(claims)`
  (`packages/tokens/src/index.ts:71-72`), and Zod drops keys the schema does not name, so a claim
  that is not in the contract never reaches a token. Verification parses with the same schema
  (`index.ts:100`).
- **The Go mirror** (`relay/internal/tokens/playback.go:42-52`) parses field by field and ignores
  unknown keys (`parseClaims`, `:88-131`). The relay binds a token to `src = relay`, its own relay
  id and the path (`Binding.Check`, `:175-183`).
- **Vectors.** `packages/tokens/vectors.json` holds one playback vector (a relay token); the Go
  tests read the same file (`relay/internal/tokens/tokens_test.go:24`, `:33`).
- **Minting.** `signFor` (`services/api/src/routes/playback.ts:66-79`; `signPlaybackToken` is
  called at `:78`) builds claims from the session id, channel, path and assignment. `playback.start`
  (`:141`) mints the first token; the heartbeat (`:213`) re-mints when the token is within 60 s of
  expiry (`:25`) or when a relay left the active set, in which case it reassigns the session to the
  origin and returns `switchTo` (`:313-351`).
- **The origin** authorises a viewer by token, path and `src in (origin, cdn)`
  (`services/origin/src/auth.ts:34-47`, called at `services/origin/src/handler.ts:93`) and
  synthesises the multivariant playlist from the source and rendition playlists
  (`handler.ts:139`, `services/origin/src/playlist.ts:176`), with a derived audio-only variant at
  `AUDIO_ONLY_BANDWIDTH` (`playlist.ts:157`).
- **P2P.** ADR 0005 §3 already keeps P2P off in data mode, in the player's policy only
  (`docs/decisions/0005-p2p-tracker.md:212-219`). The API writes a P2P grant when the player sends
  `p2pCapable` (`playback.ts:171-172`).
- **Integrity does not judge bytes.** `fetch_pattern` compares object counts (playlists, segments,
  parts) with claimed watch time (`packages/integrity/src/signals/fetch.ts:4-21`). An audio-only
  rendition has the same 1 s segments and parts as a video one. `packages/integrity/src/allowance.ts`,
  which feature-wins §4.6 names for "per-mode expected byte-rate bounds", is appeal stickiness
  (`allowance.ts:4-25`), not delivery accounting.
- **Native HLS has no level capping.** WebKit plays the multivariant playlist itself; hls.js's
  `autoLevelCapping` does not exist there (`nativeHls` on `playback.start`,
  `packages/contracts/src/api/router.ts:693`).

## Decisions

### 1. The claim: `dm`, a ceiling in bits per second

`PlaybackClaims` gains optional `dm`: an integer from 32 000 to 8 000 000, the viewer's bitrate
ceiling. Absent means data mode is off. The contract's refine adds: `dm` only with `src = origin`
and a live path (never `vod/…`).

- The player computes the ceiling from the budget (`MB/hour × 8 000 000 / 3600`; 50 MB an hour is
  about 111 kbit/s, below every video rung, so audio-only). The derived audio-only variant
  advertises 192 kbit/s (`AUDIO_ONLY_BANDWIDTH`), above that ceiling; it is the floor and is kept
  anyway (decision 5), and the meter shows what is actually spent.
- Short key, like `sid`, `cid` and `rid`: the token rides on every playlist and segment request.
- A number rather than a boolean, so the origin can keep every variant under the budget instead of
  a fixed "audio plus lowest rung", and the same token serves a 50 MB and a 300 MB budget.

**Why a claim, not a query parameter.** The token is the one per-session thing every hop already
verifies on every request and the API already refreshes. A separate unsigned parameter would be a
second channel each component parses on its own, and would not follow a `switchTo`.

### 2. TypeScript, Go and vectors change together (orchestrator)

In the W1 contract step, one commit:

- `packages/contracts/src/tokens.ts`: `dm` and the refine. Because signing strips unknown keys
  (Context), the contract must land before any minting code can carry it.
- `relay/internal/tokens/playback.go`: `DM int64` on `PlaybackClaims`, parsed with `jsonInt` when
  present, range-checked, and the same refine, so both verifiers agree on what is malformed.
- `packages/tokens/vectors.json`: a second playback vector, `playbackDataMode` (an origin live
  token with `dm`), beside the existing relay vector; both test suites verify both, and a
  `dm` on a relay token or a VOD path must fail in both.

`packages/tokens` and the vectors are orchestrator-owned (feature-wins §8 review outcome);
W1b-data-mode does not edit them. `v` stays `1`: the claim is optional and there are no deployed
verifiers to stay compatible with (no self-hosters, no public instance), so no version bump or
dual-format window is needed.

### 3. Minting: `playback.start` and the heartbeat

- `playback.start` and `Heartbeat` gain optional `dataMode`: the ceiling in bits per second, or
  null for off. On the heartbeat, absent means unchanged.
- `signFor` takes the ceiling and puts it in `dm`. On refresh it carries the previous `dm` forward
  unless the heartbeat changed it.
- A heartbeat that changes `dataMode` re-mints at once (not at the 60 s refresh point). Turning data
  mode **on** for a session on a relay or the CDN reassigns it to the origin with the existing
  `switchTo` path, re-recording `assigned_source`, as a relay leaving the set does today. Turning it
  **off** keeps the session where it is. The player reloads the multivariant playlist with the new
  token; on native HLS that is a source reload and a short rebuffer, which the UI mentions.

### 4. Data-mode sessions are origin sessions

`assignSource` gains `originOnly` (the W1 contract step, in `services/api/src/playback/delivery.ts`
beside ADR 0015's `avoidCdn`): a session that starts in data mode is never given to a relay or the
CDN.

**Why.** Relays receive the multivariant playlist from the origin with their own bearer, not the
viewer's token, and the CDN caches one playlist for everyone, so neither could serve a per-viewer
filtered playlist without new code in the relay (Go) and a CDN cache-key scheme. Data-mode sessions
are mostly audio (tens to a few hundred kbit/s), so keeping them on the origin costs little egress.
A side benefit: every data-mode session is fetch-judged, never `fetch_unjudged`. A relay-side
filter is a follow-up if data mode becomes a large share of viewers.

### 5. The origin filters the multivariant playlist

For a token with `dm`, the origin serves the synthesised multivariant playlist keeping only video
variants whose `BANDWIDTH` is at most `dm`, plus the audio-only variant, which is always kept and
listed first when no video variant fits. A pure function in `services/origin/src/playlist.ts`,
called from the multivariant branch after `synthesizeMultivariant`. The response is
`cache-control: private, no-store`. Media playlists and segments are not refused by rendition.

**Why.** This is what makes the budget hold on native HLS, where the player cannot cap levels, and
it protects the viewer from hls.js climbing on a burst of fast throughput. It defends the viewer's
budget, not the platform: a viewer who fetches a higher rendition directly only spends their own
data, so the origin has nothing to refuse.

### 6. ADR 0005 caps are untouched; data mode gets no P2P, server-side

ADR 0005's per-network cap (`maxSessionsPerNetwork`), `P2P_HTTP_SHARE` and the evidence rule do
not change. `playback.start` computes `p2pEnabled` as today and also requires no `dataMode`, so a
data-mode session never gets a grant even if a client sends `p2pCapable`; a heartbeat that turns
data mode on deletes the grant, as a gated stream's heartbeat does.

**Why.** ADR 0005 §3 already says data mode means no P2P, but only the player enforces it. Uploading
to peers spends the budget the viewer just set.

### 7. DVR and VODs are excluded from data mode

- The DVR route (ADR 0016, new `services/origin/src/dvr.ts` in W2) refuses a token carrying `dm`;
  the player hides DVR controls in data mode and says why (an i18n string). DVR v1 is source-only
  (the recorder copies the source path), so there is nothing under a budget to serve.
- VOD tokens never carry `dm` (decision 1's refine). VOD playback is source-only for the same
  reason; the player says data mode does not apply to VODs.

### 8. Integrity: no per-mode byte-rate bounds

`fetch_pattern` judges object counts, which an audio-only viewer meets exactly as a video viewer
does, so the claim changes nothing in `packages/integrity`. Per-segment fetch evidence is still
required (feature-wins §4.6: "the mode changes expected rates, not evidence requirements"). The
throttled-viewer harness step proves it: a 64 kbit/s Chromium and WebKit viewer on audio-only
stays verified.

**Why.** The planned bounds file is about appeals, and the signal they would bound does not exist.
Adding byte-rate checks only for data mode would create a new signal with no evidence it is needed.

## Consequences

- **W1 contract step (orchestrator):** the claim and refine (TS and Go), the second vector,
  `dataMode` on `playback.start` and `Heartbeat`, `assignSource`'s `originOnly`.
- **W1b-data-mode** owns `apps/web/src/player/{budget,stats,source}.ts`, the minting change in
  `services/api/src/routes/playback.ts` (decisions 3 and 6), and in the origin `auth.ts` and the
  filter in `playlist.ts` (decision 5). It does not need `packages/integrity/src/allowance.ts`
  or any `packages/integrity` path, so it no longer has to wait on W0-integrity for that reason
  (W0-integrity has merged in any case).
- **W2-dvr** refuses `dm` tokens in `dvr.ts`; W2-captions, which owns `playlist.ts` in W2, keeps
  the filter.
- **Tests.** Token vectors in TS and Go (valid `dm`; `dm` with `src = relay`, on a VOD path, out
  of range, as a string: all malformed). Origin unit tests: filter by ceiling, audio-only always
  kept, no video variant fits, `no-store`. API tests: `dm` carried across refresh, an immediate
  re-mint on change, relay and CDN sessions moved to the origin, no P2P grant. Budget controller
  unit tests. Harness: the throttled-viewer step stays verified on Chromium and WebKit.
- **Egress.** Data-mode viewers load the origin instead of relays and the CDN; audio rates keep it
  small. S1 dashboards should show the data-mode share of origin sessions.

## Alternatives considered

- **Client-only data mode** (no claim). Works in hls.js, but WebKit cannot cap, P2P stays a
  client promise, and DVR cannot refuse. Rejected.
- **A boolean claim** with a fixed "audio plus lowest rung" filter. Simpler, but ignores the budget
  the viewer set. Rejected for the ceiling.
- **A separate data-mode playlist URL** (`data.m3u8`). Cacheable by relays and the CDN without
  per-token filtering, but adds a path every hop must route and still needs the claim for P2P and
  DVR. Rejected for v1; reconsider with a relay-side filter.
- **Filter at relays too** (Go). Needed only if data-mode sessions leave the origin. Deferred
  (decision 4).
- **Per-mode byte-rate bounds in integrity** (feature-wins §4.6). The signal is count-based; see
  decision 8. Rejected.
- **Bump `v` to 2.** No deployed verifier needs the signal, and an optional field is
  backward-compatible within one repository's release. Rejected.

## Decisions at acceptance (2026-10-27)

The maintainer accepted the recommended answers.

1. **The claim** is added in the TypeScript contract, the Go relay mirror and `vectors.json`,
   by the orchestrator in the W1 contract step (`packages/tokens` is orchestrator-owned).
2. **Minting** stays in `services/api/src/routes/playback.ts` (`signFor`, `:66-79`; the W1 plan's
   `:77` is now `:78`).
3. **ADR 0005 caps are untouched**; data mode gets no P2P grant, now also enforced by the API.
4. **DVR is excluded** from data mode (feature-wins §4.6, §4.12), and so are VODs.
5. Head-agent calls recorded for review: `dm` is a ceiling in bits per second, data-mode sessions
   are origin-only, the origin filters the multivariant playlist, and integrity needs no per-mode
   bounds because it judges object counts, not bytes.
