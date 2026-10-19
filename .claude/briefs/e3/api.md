<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing the **E3 API changes** for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md, HANDOFF.md, docs/architecture.md, `services/api/README.md` and
**docs/testing/e3-selectors.md** first. Do not look outside the repository. You work in your own
git worktree: run `git merge main --no-edit` first.

## You own (write only these)

- `services/api/**` **except** `src/routes/legal.ts`, `src/lib/legal.ts`, `tests/legal*` and
  `tests/round3.int.test.ts` (other units own those right now)

## Contracts you must honor (read-only for you)

- `packages/contracts` (`relays.*`, `RelayNode` with `lastReceiptAt`/`receipts30d` — already
  computed in `src/routes/relays.ts` `relayStats`), heartbeat input `draining`,
  `KEYS.relays`, `packages/db` (`relay_nodes`, `relay_receipts`, `relay_issuance`,
  `playback_sessions`), `packages/integrity` (another unit is changing it and `services/worker` in
  parallel: the worker now removes a relay from `KEYS.relays` when it suspends one).

## Build

1. **Retired vs offline.** Today `requireRelay` answers 401 "retired" for every `offline` relay,
   so a relay the worker timed out (or that drained) can never rejoin. Make retirement explicit:
   `relays.remove` retires by rotating `token_hash` to a fresh random value (the old token can
   never authenticate again), sets `offline`, removes it from `KEYS.relays`, audits. An `offline`
   relay whose token still matches may `register` again (→ `pending` → health check → `active`)
   and heartbeat. `suspended` relays authenticate (so they learn their status) but never enter
   assignment until `reinstate`.
2. **Draining.** `heartbeat` with `draining: true`: set `offline`, remove from `KEYS.relays` at
   once, audit nothing (operational), return `{ status: "offline" }`. Relay-assigned sessions get
   `switchTo` on their next playback heartbeat (existing path — make sure it triggers on a relay
   that is no longer in `KEYS.relays`, including suspended ones, and that the new token/playlist
   points at the origin; `assigned_source` stays as recorded but document what integrity sees).
3. **Status freshness.** `relays.mine` must reflect worker-side suspension immediately (it reads
   Postgres — confirm) and the drain (`offline`). Make sure `reinstate` republishes to
   `KEYS.relays` only after a passing health check.
4. Integration tests for the open origin items that are API-side, if any; update
   `services/api/README.md` (relay lifecycle: pending → active → degraded/offline/suspended,
   retire, drain, rejoin).

## Tests you must add

- Integration (`tests/relays.int.test.ts` or a new `tests/relays-e3.int.test.ts`): retire kills
  the token (register and heartbeat 401); an offline (timed-out) relay re-registers and becomes
  active; draining heartbeat removes it from `KEYS.relays` and a relay-assigned playback session
  gets `switchTo` with an origin playlist on its next heartbeat; a suspended relay heartbeats and
  sees `suspended`, is not assigned, and `reinstate` brings it back after a health check.
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
