<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **server-side P2P evidence in integrity scoring** for CommonAir (repo:
/Users/joshe/Repos/bcon). Read AGENTS.md, HANDOFF.md ("Open items", the P2P contract request),
docs/architecture.md and **docs/decisions/0005-p2p-tracker.md** first. Do not look outside the
repository. You work in your own git worktree: run `git merge main --no-edit` first.

## You own (write only these)

- `packages/integrity/**`
- `services/worker/**`

## Contracts you must honor (read-only for you)

- `@commonair/contracts/internal`: `KEYS.p2pPeer` (HASH `swarm`, `net`, `first`, `last`,
  `announces`), `KEYS.p2pSwarm` (ZSET sessionId → last announce ms), `P2P_EVIDENCE`
  (`windowMs`, `minSwarmNetworks`, `peerTtlSeconds`), `p2pSwarmId`. The tracker
  (`services/tracker`, built in parallel by another unit) is the only writer; you only read.
- `playback_sessions.assigned_source` never holds `p2p` for new sessions (the API records the HTTP
  source; see `services/api/README.md`). Do not depend on it being `p2p`.
- Another unit is building `services/tracker` in parallel; do not touch it or `services/api`.

## Build

1. **Evidence loader** in `packages/integrity` (next to the existing Valkey store/evidence
   loaders, `src/store.ts` etc.): for a batch of session ids and a window end `t`, pipeline
   `HGETALL KEYS.p2pPeer(sid)`; a session is a candidate when `last >= t - windowMs`. For each
   distinct swarm, `ZRANGEBYSCORE KEYS.p2pSwarm(swarm) (t - windowMs) +inf` then `HGET … net` for
   members (pipelined, bounded: cap members read per swarm, e.g. 500, and document it). The
   session is **evidenced** when its swarm's in-window members span `>= minSwarmNetworks`
   distinct `net` values (itself included). Members must also belong to the same channel (the
   swarm id is `<channelId>:<infoHash>`; check the prefix against the session's channel).
   Return evidence facts per session (`{evidenced, swarmNetworks, announces}`), never throwing on
   Valkey errors (treat as not evidenced, count it).
2. **Scoring** (`src/signals/fetch.ts` and its callers): replace the `assignedSource === "p2p"`
   share with evidence. For an evidenced **origin** session, the expected-segment bar for
   `too_few_segments` / `no_media_fetched` uses `P2P_HTTP_SHARE`; `too_many_segments` is still
   judged against share 1 (the honest lone peer that falls back to HTTP must never trip it).
   Non-evidenced sessions are judged exactly as today regardless of `p2pCapable` or heartbeat
   `bytesP2p`. Relay sessions: keep the receipt-based rules; apply the reduced "too few" bar to
   relay objects for evidenced relay sessions too. Keep the legacy `assignedSource === "p2p"`
   path judged like an origin session **without** the reduced share unless evidenced (old rows).
   Add a measure (`p2pEvidenced`, `swarmNetworks`) to the explanation so streamers/admins see why.
3. **Worker wiring** (`services/worker`, `score-sessions` job and anything that builds
   `SessionFacts`/evidence): load P2P evidence alongside heartbeat/fetch evidence per batch, pass
   it to scoring. Count Valkey evidence errors in the existing integrity metrics.
4. `packages/integrity/README.md` and `services/worker/README.md`: document the rule, keys,
   window, and the residual risk from ADR 0005.
5. While you are in the worker: **verify-receipts gap** found in the E3 survey —
   `packages/integrity/src/jobs.ts` (~:452) `gap_minutes` subquery does not filter
   `relay_issuance` by `relay_id`, so another relay's issuance counts as coverage. Fix it with a
   regression test. Also make suspension remove the relay from `KEYS.relays` (`relays:active`)
   in the same job so assignment stops immediately (not on the relay's next heartbeat).

## Tests you must add

- Unit: evidence predicate (window edges, exactly `minSwarmNetworks`, one network many sessions =
  not evidenced, other channel's swarm ignored, member cap), fetch checks for evidenced vs not
  (too-few uses reduced share only when evidenced; too-many always share 1; client `bytesP2p`
  never matters), legacy `p2p` rows.
- Integration (real Valkey + `createTestDatabase()`): write `p2pPeer`/`p2pSwarm` keys as the
  tracker would, run the scoring job over sessions with fetch evidence at ~15 % of expected:
  evidenced session verifies, the same session without a second network is flagged
  `too_few_segments`. The relay_id gap fix and immediate `relays:active` removal on suspension.
## Done means (session four process rules — every brief)

- **Targeted checks only.** The user runs the gate (`bun run verify`), image rebuilds, harness
  scenarios against the live stack, dev servers and every browser/visual check. You do not. Run:
  your packages' `bun run test` and `bun run test:int` (the data services are already up at the
  `.env.example` defaults; never run `podman compose` or `scripts/infra.ts`), `bunx tsc -p <pkg>
  --noEmit`, `vp lint --deny-warnings <changed paths>`, `vp fmt <changed paths>`, `vp build` for
  `apps/web`, `go test ./...` / `go vet ./...` for `relay/`. Do not run several packages'
  `test:int` at the same time (shared Postgres/Valkey load makes timing tests flaky).
- No files outside your ownership list changed (`git status`).
- Commit in your worktree with `git commit -s` (Conventional Commits), message ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, once your targeted checks pass.
- Final message: what you built, test counts per package, branch + commit sha, **contract
  requests** (exact changes needed in files you do not own), anything left undone, and the exact
  commands the user should run live to exercise your work.
