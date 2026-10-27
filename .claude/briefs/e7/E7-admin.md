<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E7-admin: egress report, incidents, integrity flags

You are implementing unit E7-admin for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/E7-platform-debts.md`,
`.claude/briefs/e7/contract-step.md` (§6, §8 and §9 "Shared-file rules"),
`docs/testing/e7-selectors.md`, `docs/decisions/0005-p2p-tracker.md` (delivery sources) and the
header of `packages/integrity/src/allowance.ts`. Do not look outside the repository. Work in your
own git worktree on a branch named `e7/admin`, created from the E7 contract-step commit the
orchestrator gives you (run `git merge main` first if main moved).

## Why

Admins cannot see what delivery costs (egress by source is the number DigitalOcean bills and the
one P1 is meant to move), cannot post a status-page incident, and cannot review integrity flags,
although all three tables are written today. `admin.egress`, `admin.incidents`,
`integrity.flags` and `integrity.decide` answer 501.

## You own (write only these)

- `services/api/src/routes/admin.ts`: the `egress` (:19) and `incidents` (:77) handlers only.
- `services/api/src/routes/integrity.ts`: `flags` and `decide` (:10-11). `channelSummary` (:9)
  stays `notImplemented` (W2-rollup-analytics owns it); update the file comment (:4).
- `services/api/src/admin/**` (new: queries and DTO mapping for the three features)
- `services/api/tests/admin-e7.test.ts`, `services/api/tests/admin-e7.int.test.ts` (new)
- Web: `apps/web/src/routes/_admin/admin.egress.tsx`, `admin.incidents.tsx`, `admin.integrity.tsx`
  (fill the placeholders; never add/rename route files), `apps/web/src/components/admin/**` (new),
  `apps/web/src/i18n/e7-admin.ts` (keys prefixed `admin.egress.`, `admin.incidents.`,
  `admin.integrity.`), `apps/web/tests/e7-admin*.test.ts(x)` (new)
- Harness: `harness/scenarios/e7-admin.ts` (new scenario, auto-discovered), `harness/src/e7/admin.ts`
  (new: page drivers, DB seed helper), `harness/tests/e7/admin.test.ts` (new)

Read-only: `packages/**` (contracts, db, integrity: W0-integrity owns `packages/integrity` in
wave 2), `services/api/src/routes/instance.ts`, the admin nav (`apps/web/src/lib/nav.ts`,
`components/safety/access.ts`, `routes/_admin.tsx`, done in the contract step),
`harness/src/e7/selectors.ts`, every i18n file but yours. Anything else is a **contract request**
with the exact diff.

## Contracts you must honor (read-only for you)

- `packages/contracts/src/api/router.ts:2599-2607` `admin.egress` (`admin`; input `{ from, to }`
  timestamps; output `EgressReport`), `:2632-2648` `admin.incidents` (`admin`; input
  `{ id?, title (1-140), status, components: string[], body (≤5000) }`; output `{ id }`),
  `:2224-2253` `integrity.flags` (`admin`; `PageInput` + `subjectType?`, `decision?`, `channel?`;
  output `page(IntegrityFlag)`) and `integrity.decide` (`admin`; `{ id, decision: "excluded" | "allowed", reason (1-1000) }`;
  output `IntegrityFlag`).
- `api/entities.ts:931-942` `EgressReport` (`totals` and per-broadcast `bytes` keyed by
  `DELIVERY_SOURCES` = `origin`, `relay`, `p2p`, `cdn`; every key present, 0 when none),
  `:811-820` `IntegrityFlag`, `:944-…` `StatusComponent` / the `instance.status` incidents shape.
- Tables: `egress_samples` (`packages/db/src/schema/media.ts:121-136`, PK broadcast/bucket/source,
  index on `bucket_start`), `incidents` (`schema/safety.ts:332-340`), `integrity_flags`
  (`schema/safety.ts:44-64`).
- `docs/testing/e7-selectors.md` "Integrity", "Egress", "Incidents" and the `e7-admin` scenario.

## What is there today (verified at `9c51c93`)

- `admin.ts:19` and `:77`, `integrity.ts:9-11` are `.handler(notImplemented)`.
- `instance.status` (`services/api/src/routes/instance.ts:40-85`) reads `incidents` (open, or
  resolved in the last 7 days, 20 newest) and marks an open incident's components degraded; its
  component ids are the probe names (`db`, `valkey`, … plus `deps.probes`). Nothing writes
  `incidents`.
- `egress_samples` is written by the worker's segment consumer (one row per broadcast, minute and
  source). Nothing reads it.
- Integrity flags are written by `packages/integrity/src/jobs.ts` with `decision` `pending_review`
  or `excluded`; an admin `allowed` decision is already honoured by scoring as an allowance
  (`allowance.ts:10-12`, `:55`, `:86`: it needs `decided_at`). `details` is JSON from the signal.

## Build

1. **`admin.egress`.** `from < to`, range at most 31 days (else `BAD_REQUEST`); sum `bytes` from
   `egress_samples` with `bucket_start >= from and < to` by source (totals) and by broadcast and
   source, joined to `broadcasts` → `channels` for the slug, ordered by total bytes descending,
   capped at 200 broadcasts (say so in a comment; the totals cover everything). Integers in JS
   `number` are fine (bytes; use `::bigint` sums cast safely and assert `Number.isSafeInteger`).
2. **`admin.incidents`.** Create (no `id`) or update (`id`; `NOT_FOUND` if missing). Unknown
   component ids (not in the status probe set) → `BAD_REQUEST`. `status = resolved` sets
   `resolved_at` (once; reopening clears it). Audit `incident.open` / `incident.update` /
   `incident.resolve` (admin actor; details: id, status, components; never the body). No outbox
   event (the status page reads the table; the catalog has no incident event: if you think one is
   needed, that is a contract request).
3. **`integrity.flags`.** Keyset paging newest first (`created_at`, `id`), filters by subject type,
   decision and channel slug (via `channel_id`). `details` passed through as stored: check what the
   signals write (`packages/integrity/src/signals/*`) and drop any key that could be personal data
   (raw IPs, user agents) before it leaves the API; document the allow-list in code.
4. **`integrity.decide`.** One transaction, `for update`: set `decision`, `decided_by_id`,
   `decided_at` (CAS on the current decision; deciding the same value again → `CONFLICT`); audit
   `integrity.flag.decide` with `reason` in the audit row's `reason` column (admin text, not user
   PII) and details `{ flagId, from, to, signal, subjectType }`. An `allowed` decision on a
   session/user flag is what `allowance.ts` reads: add an integration test that a rescoring after
   the decision no longer counts the signal (call the integrity job function directly; do not edit
   `packages/integrity`).
5. **Web pages** (admins only; the guard and sidebar exist from the contract step): `/admin/egress`
   (range inputs defaulting to the last 24 h, totals as stat tiles, per-broadcast table, bytes via
   a shared formatter if `packages/ui` has one, else a local `formatBytes` in your components),
   `/admin/incidents` (list from `instance.status`, create/edit form, status `ChoiceToggle`,
   `ConfirmDialog` for resolve), `/admin/integrity` (filters, list, decide panel with required
   reason). Every selector from `e7-selectors.md`; `<EmptyState>`, `<Skeleton*>`, error with retry;
   `<RelativeTime>` for timestamps; 320 px; keyboard; no native tooltips.
6. **Harness `e7-admin`** (`needs: ["api", "web", "media", "worker", "browser"]` as fits;
   `--set via=api` supported): sign up an admin (grant the role with the role CLI helper the other
   scenarios use, `harness/src/money-db.ts` `grantRole`), stream a short test pattern and watch it
   so `egress_samples` gets rows, then the egress page shows a row for that broadcast with
   `data-origin > 0`; open an incident on `db`, see it on `instance.status` (component degraded),
   resolve it; seed a `pending_review` integrity flag for a fresh viewer's session with a DB helper
   in `harness/src/e7/admin.ts` (owner connection from `DATABASE_URL`, like `harness/src/safety-db.ts`),
   decide it `allowed` on `/admin/integrity`, and check the audit row. Do not edit
   `harness/src/registry.ts`: the orchestrator adds `e7-admin` to `FULL_REQUIRED` after you merge.

## Tests you must add

- Unit: range validation, totals with missing sources filled with 0, the details allow-list.
- API integration (`createTestDatabase()`): egress sums across minutes and sources, range and
  ordering, 403 for a non-admin; incident create/update/resolve/reopen, unknown component, audit
  rows, `instance.status` reflects it; flags paging and filters; decide CAS, conflict, audit,
  allowance effect.
- Web: each page renders empty, loaded and error states; the forms submit the right inputs;
  selector ids present.
- Harness: pure helpers in `harness/tests/e7/admin.test.ts`; the scenario registers
  (`validateScenario`).

## Done means

Follow `.claude/briefs/_done-means.md`, except that the orchestrator runs the gate this batch:
run only targeted checks (`bun --bun vp test run` and `test:int` in `services/api`; `apps/web`
and `harness` tests; `bunx tsc -p` for each; `vp lint --deny-warnings` and `vp fmt` on your
paths; `vp build` in `apps/web` and confirm `git diff apps/web/src/routeTree.gen.ts` is empty).
Never run `bun run verify`, `podman`, `scripts/infra.ts` or a harness scenario; give the user the
exact `bun harness/src/cli.ts run e7-admin` commands. `git status` shows only your paths. Commit
in your worktree (`git commit -s`, Conventional Commits, ending with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Final message: what you built, test
counts per package, branch and sha, contract requests (exact diffs), the proposed
`services/api/README.md` text, and anything left undone.

## Contract step as landed (`66e95da`)

Your base is `66e95da` (`feat(e7): contract step` + review fixes), not `9c51c93`; recheck line numbers against it.

- DMCA suspensions go through `setSuspension(…, "dmca_repeat_infringer")` (`services/api/src/moderation/suspension.ts`) and are lifted only through `liftDmcaSuspensionInTx` or `reconcileDmcaTerminationInTx` (`packages/db/src/account-actions.ts`), which takes the account-actions lock itself.
