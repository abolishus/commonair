<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W3-dvr-relay: signed relay purge, relay-served DVR, relay `.vtt`

You are implementing unit W3-dvr-relay for CommonAir (repo: /Users/joshe/Repos/bcon). Read these
first:

- AGENTS.md, PLAN.md and docs/architecture.md.
- `.claude/briefs/batch7/README.md`. Decisions (x), (y), (z), the path ownership and the shared
  rules are binding.
- `.claude/briefs/w3/contract-step.md`:
  - §2.4 (the purge feed)
  - §2.6 (`RELAY_PURGE_JOBS`)
  - §2.7 (token rules)
  - §3.1 (`relay_purges`)
  - §4.3 (`signPurgeBatch` / `verifyPurgeBatch`, the Go mirror and the vectors)
  - §5.2 (media-state events)
- `docs/decisions/0016-live-dvr.md`, including Amendment 1, which the contract step writes.
  Decisions 3 and 5 and the amendment are your spec.
- ADR 0009 Amendment 1 ("immediately" means 5 s).
- ADR 0005 (relays).
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 2**, and the last W3 unit. Work in your own git
worktree, on branch `w3/dvr-relay`, cut from `main` after wave 1 merged.

## Why

DVR is origin-only today, because a relay cache cannot forget a removed segment. A signed purge
lets the origin tell every relay to drop a prefix. A relay that also re-reads its DVR playlist
every second stops serving removed media within about 5 s, even if a purge is lost. With both in
place, relays can carry DVR egress, which is origin egress today. The same pass fixes relay
captions: `.vtt` is counted as a segment and pinned for a day, so relay pulls cannot carry
SUBTITLES yet.

## You own (write only these)

- `relay/**` except `relay/internal/tokens/**` and `relay/module-licenses.json`. This covers
  `relay/internal/{cache,server,hls,relay,apiclient,purge}/**`; `purge` is new.
- `services/origin/src/dvr.ts`, its tests, and the `/relay-pull/dvr/` registration through the
  route registry.
- `services/api/src/relay/purges*.ts`, the purge feed route stub the contract step mounted.
- `services/worker/src/relay-purge/**`, `services/worker/src/jobs/relay-purge.ts`.
- The DVR lines of `services/api/src/routes/playback.ts`: a relay DVR grant for relay-assigned
  sessions.
- `harness/src/w3/dvr-relay/**`, `harness/tests/w3/dvr-relay*`.

**Read-only:**

- `relay/internal/tokens/**` (with `purge.go` from the contract step)
- `services/origin/src/{origin,handler,paths,playlist,vod,captions}.ts`
- `services/api/src/routes/relays.ts`
- `packages/{contracts,db,config,tokens,integrity}/**`

Anything else is a **contract request**. In particular, the `handler.ts` `captionsReachable` flip
for relay pulls is the orchestrator's at your merge (decision (y)): state it in your final message.

## Contracts you must honor

- The token rules allow `path = dvr/<vodId>` with `src = relay` (and `rid`), and still refuse
  `dm`. The TS and Go rules and their vectors come from the contract step.
- The signed purge envelope `{payload: {seq, items: [{seq, prefix, reason}]}, signature}` is
  signed with `PLAYBACK_SIGNING_KEY`. Relays verify it with `originPublicKey`, which comes in the
  heartbeat (`apiclient/client.go:76-79`).
- `relay_purges` (`seq` bigserial). `RELAY_PURGE_JOBS.emit` runs on `media.vod.state` (public
  false), `moderation.restriction` (restricted true), `channel.suspension` (suspended true) and
  `stream.offline` for an ended recording. The contract step wires these through the outbox hook.
- DVR state predicate, `VodStateCache` (5 s), `SegmentFetch.mode` and `SegmentLog` (origin).
- The relay ledger: receipts count bytes and segments (`Ledger.AddBytes` / `AddSegment`).

## Build

1. **Purge emitter (worker).** On each event, insert `relay_purges` rows with the prefixes:
   - `dvr/<vodId>/` for a VOD's DVR;
   - `live/<slug>/` for a T1 restriction or a suspension of a live channel;
   - `live/<slug>/captions/` where relevant.

   Use the same transaction as the job's dedupe marker, and make it idempotent per event id. A
   daily cleanup drops rows older than 7 days.

2. **Purge feed (API, `services/api/src/relay/purges.ts`).**
   - `GET /api/relay/purges?after=<seq>` uses relay bearer auth (the relay protocol's existing
     check). It returns the rows after `seq`, at most 500, signed with `signPurgeBatch`.
   - It holds the request up to 25 s when there is nothing new, waking on a Valkey pub/sub nudge
     from the emitter. The harness hook can shorten the hold to 1 s.
   - A relay that is behind by more than 7 days gets `{reset: true}` and must clear its DVR and
     live caches.
3. **Relay (Go).**
   - **`purge` package.** A long-poll loop beside the heartbeat with backoff. It verifies every
     batch with `verifyPurgeBatch` and refuses the batch on a bad signature (logged, counted). It
     applies each prefix to the cache: add a `DeletePrefix` to `cache.LRU`/`Store`, and keep
     prefix tombstones for 60 s so that in-flight fills for a purged prefix are dropped. It
     persists the last `seq` in memory, and in the state dir if the relay has one; a restart
     starts from 0 and the API answers with recent rows.
   - **DVR serving.** Register `/dvr/` in `server.go:201-203`. The token must be `src=relay`,
     with a matching `rid` and path `dvr/<vodId>`. The relay pulls from the origin's new
     `/relay-pull/dvr/<vodId>/…`:
     - The playlist has a 1 s TTL.
     - A segment is served only if the current playlist lists it **and** the last successful
       playlist fetch is under 5 s old.
     - Otherwise it answers 404. A 404 or 403 from the origin evicts the VOD's prefix at once.
     - Segments are cached with expiry at the window length.
     - Responses send `cache-control: private, no-store`.
     - Bytes and segments are counted toward receipts as DVR. Add a mode to the ledger entry if
       the receipt format allows it; otherwise file a contract request.
   - **`.vtt` (decision (y)).** Paths under `/captions/` that end in `.vtt` are cached with a 30 s
     expiry and served with `max-age=30` (not `immutable`). They are not counted (no
     `AddSegment` / `AddBytes`, `server.go:448-451`). Add a Go test for each.
4. **Origin (`dvr.ts`).** Register `/relay-pull/dvr/` with the relay-pull auth the live pull uses.
   It has the same state checks and window cut as `/dvr/`, and URIs in the playlist are
   relay-relative. `dvrTokenRefusal` (`:234-242`) keeps refusing `src=relay` on the viewer `/dvr/`
   route: viewers of a relay use the relay. Every fetch goes to `SegmentLog` with `mode: "dvr"` and
   the relay id.
5. **API (`playback.ts`, DVR lines only).** For a relay-assigned session that passes every DVR gate
   (W2-dvr's matrix, unchanged), mint the DVR token as `src=relay` for that relay and point
   `dvrPlaylistUrl` at the relay's `/dvr/<vodId>/index.m3u8`. Origin- and CDN-assigned sessions keep
   origin DVR, so the CDN still never serves DVR. Integrity: the DVR fetch judging for
   relay-served DVR is the relay receipts' (ADR 0016 decision 6 through receipts). Check that
   `packages/integrity/src/signals/fetch.ts` accepts relay evidence for `dvr`, and file a contract
   request if it does not.

## Tests you must add

- **Go** (`go test ./...`, `go vet ./...`):
  - purge verify: the vectors, a tampered batch, the wrong key;
  - `DeletePrefix` on the LRU and on coalesced in-flight fills;
  - tombstones;
  - the long-poll loop with a fake API: backoff, reset;
  - DVR route: token checks (`src`, `rid`, path, `dm`), a segment not listed, a stale playlist
    (over 5 s) gives 404, origin 404 evicts, headers, ledger counting;
  - `.vtt`: not counted, 30 s expiry, the header.
- **Worker integration:** each event writes the right prefixes once (idempotent), and cleanup.
- **API integration:**
  - the feed's paging, signature and hold, and the wake on nudge;
  - the reset past 7 days;
  - the relay DVR grant matrix (relay-assigned vs origin vs CDN, plus W2-dvr's gates).
- **Origin integration:** `/relay-pull/dvr/` auth, state refusals, the window, `SegmentLog`
  entries.
- **Harness `e2e-relay` extension steps** (in `harness/src/w3/dvr-relay/**`):
  - `dvr-relay`: a relay-assigned viewer rewinds; the segments come from the relay (the relay's
    ledger rises, origin `/dvr/` fetches for that session stay 0); the session verifies.
  - `dvr-purge`: remove the VOD (or a T0 fixture) mid-stream. The relay answers 404 for a cached
    DVR segment within 5 s, and the purge row reached the relay (its `seq` advanced).
  - `relay-vtt`: with captions on, a relay pull's multivariant carries SUBTITLES (after the
    orchestrator's `handler.ts` flip). The `.vtt` responses carry `max-age=30`, and the receipt
    segment count does not include them.

## Done means

Follow `.claude/briefs/_done-means.md`:

- `go test ./...` and `go vet ./...` in `relay/`.
- `bun run test` / `test:int` in `services/origin`, `services/api` and `services/worker` (one
  `test:int` at a time).
- `bunx tsc -p` for each.
- `bun --bun vp test run` in `harness`.
- `vp lint --deny-warnings` and `vp fmt`.
- `reuse lint`.

`git status` shows only your paths. Commit with `git commit -s`.

The final message must state the `handler.ts` change the orchestrator applies, and any receipt or
integrity contract request. Tell the user to run `bun harness/src/cli.ts run e2e-relay --set
w3=dvr-relay,dvr-purge,relay-vtt` against `stack --harness`.
