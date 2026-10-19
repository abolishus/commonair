<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing the **E3 web slice** for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md (design rules, house primitives), HANDOFF.md, docs/architecture.md,
docs/testing/e1-selectors.md, docs/testing/e2-selectors.md and **docs/testing/e3-selectors.md**
first. Do not look outside the repository. You work in your own git worktree: run
`git merge main --no-edit` first.

## You own (write only these)

- `apps/web/**`

## Contracts you must honor (read-only for you)

- `docs/testing/e3-selectors.md` (every test id and attribute exactly as written), E1/E2
  selectors unchanged. `relays.mine` / `relays.create` / `relays.remove`, `RelayNode`
  (`status`, `bytesVerified30d`, `lastReceiptAt`, `receipts30d`, `suspendedReason`),
  `PlaybackStart.source`, heartbeat `switchTo`/`throttled`. `packages/ui` house primitives.

## Build

1. **`/relays`** (signed-in only; redirect to `/signin` otherwise, as `/dashboard` does): list
   (`relay-row` with `relay-status` badge per `RELAY_STATUSES`, `relay-bytes-verified` via a
   bytes formatter, `relay-receipts`, last receipt as `<RelativeTime>`, `relay-suspended-reason`),
   refresh every 10 s while visible; `relays-empty` `<EmptyState>`; create form
   (`relay-create-name`, `relay-create-submit`) showing `relay-token` once with a copy
   `<IconButton tooltip>` and `relay-run-command` (built from the instance `PUBLIC_URL` injected
   at SSR, never hardcoded; the host part a placeholder) and a short "how to run a relay"
   explainer linking the relay README in the source repo (`instance.info` source URL);
   `relay-remove` through `<ConfirmDialog>`; toasts via `@commonair/ui/toast`. All strings via
   the i18n catalog. Responsive to 320 px, keyboard accessible.
2. **`relays-link`** on `/dashboard`.
3. **Player `data-source`** (`apps/web/src/player`): the source of the playlist currently
   playing; on `switchTo` load the new playlist, update `data-source`, keep `data-state`
   `playing` across the switch (no flash to `error`). Honor the heartbeat `throttled` hint:
   don't reset the counters a throttled beat did not record (they are deltas; carry them into the
   next beat).
4. Unit tests for the new pure logic (status → badge mapping, bytes formatting, run-command
   builder, heartbeat delta carry-over on `throttled`, switchTo source update).

`vp build` must pass (note any chunk-size warning in your final message).

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
