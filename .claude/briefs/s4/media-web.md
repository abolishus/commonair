<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are closing **media/web open items** for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md (design rules + house primitives), HANDOFF.md ("Open items"), docs/architecture.md,
docs/testing/e1-selectors.md and docs/testing/e2-selectors.md first. Do not look outside the
repository. You work in your own git worktree: run `git merge main --no-edit` first.

## You own (write only these)

- `services/media/**`
- `apps/web/**`

## Contracts you must honor (read-only for you)

- `packages/db` `vods.failed_reason` (new column, migration 0009) and `Vod.failedReason` in
  `packages/contracts/src/api/entities.ts`; `StreamHealth` / `HealthSample.warnings` (codes from
  `services/media/src/health/rules.ts`); `stream.health` in the router. E1/E2 selectors must not
  change. Other units edit `packages/integrity`, `services/worker`, `services/tracker`,
  `services/chat`, `packages/governance` and `services/api/tests` in parallel.

## Build

1. **Media: `vods.failed_reason`.** Wherever a VOD becomes `failed` (`src/vod/finalize.ts`,
   `src/vod/reconcile.ts`, recovery, …) write a stable code into `failed_reason` (e.g. `empty`,
   `stalled`, `upload_failed`, `crash_recovery`), never free text or personal data. Keep
   `removed_reason` for removals only: move the failure codes that are currently written to
   `removed_reason` (`VOD_EMPTY_REASON`, `VOD_STALLED_REASON`) to `failed_reason`, and document the
   codes in `services/media/README.md`. Tests for every path (integration with
   `createTestDatabase()` where they touch Postgres).
2. **Web: strings for media health codes.** Every warning code `services/media/src/health/rules.ts`
   can emit gets a translated message (title + one-line fix hint) in the web i18n catalog
   (`apps/web/src/i18n`), via `t("key")`. Add a small "Stream health" card on `/dashboard`
   that renders, while live, the latest sample's warnings from `stream.health` (polled every
   10 s while the tab is visible), using house primitives (`EmptyState` when healthy/offline,
   `Skeleton` while loading, CSS-variable colors only). Unknown codes fall back to a generic
   message showing the code. Test ids: `stream-health` (card, `data-state` = `offline` |
   `healthy` | `warning`), `stream-health-warning` (one row, `data-code` = the code). Add them to a
   new short section at the end of `docs/testing/e2-selectors.md`? **No** — you do not own docs;
   list them in your final message and the head agent adds them.
3. A unit test in `apps/web` that the catalog has a key for every code exported by the media
   rules (import the code list if it is exported; if not, add an exported `HEALTH_WARNING_CODES`
   const in `services/media/src/health/rules.ts` and have web import it only if web already
   depends on media — otherwise mirror the list in web and file a contract request to move it into
   `packages/contracts/src/enums.ts`).
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
