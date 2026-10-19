<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are closing **open test items** for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
HANDOFF.md ("Open items") and docs/architecture.md first. Do not look outside the repository. You
work in your own git worktree: run `git merge main --no-edit` first.

## You own (write only these)

- `services/chat/tests/**` and, only if a test exposes a real bug, `services/chat/src/**`
- `packages/governance/tests/**` (and `packages/governance/src/**` only for a bug a test exposes)
- `services/api/tests/round3.int.test.ts` (and `services/api/src/routes/appeals*` / the appeals
  handler only for a bug the flake exposes)

## Contracts you must honor (read-only for you)

- `packages/contracts`, `packages/db`, `packages/config`, `packages/integrity`. Other units edit
  `packages/integrity`, `services/worker`, `services/tracker`, `services/media` and `apps/web` in
  parallel.

## Build

1. **Chat: OAuth revocation on an open socket.** Add an integration test proving that when an
   OAuth/bot token (or session) a chat socket authenticated with is revoked, the socket stops
   being able to send (closed or refused per the chat service's existing revocation mechanism —
   read `services/chat/src` and `services/chat/README.md` to find it). If no mechanism exists,
   report it as a finding with a proposed design instead of building a large feature.
2. **Governance:** unit tests for `subscriptionQualifies` (`packages/governance/src/membership.ts`)
   — boundaries, statuses, tiers, dates — and integration tests for `closeElection`
   (`src/elections.ts`) with `createTestDatabase()`: tallying, ties, quorum, idempotence on a
   second close, closing before the end time.
3. **API flake:** `services/api/tests/round3.int.test.ts` › appeals › "create → queue → resolve
   overturned → the integrity allowance sees it" fails about one run in three, and only in some
   runs: the first assertion (`loadAllowances(...).get(aliceSession)` is undefined) finds an
   allowance `{ since: … }` before any appeal is resolved. Find the root cause (shared state
   between tests in the file, the faked `api.deps.now` clock in the "heartbeat floor" describe,
   flag `createdAt`/`decided_at` timing, `x.at >= c.started` in `packages/integrity/src/allowance.ts`,
   …) and fix the test or the code. Prove it with 10 consecutive green runs of that file.

## Tests you must add

- As above. Name the root cause of the flake in your final message.
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
