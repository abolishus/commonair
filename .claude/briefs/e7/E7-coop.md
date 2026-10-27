<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E7-coop: rejoin, retry, a cheaper membership view, board elections you can use

You are implementing unit E7-coop for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/E7-platform-debts.md`,
`.claude/briefs/e7/contract-step.md` (§1.3 `coop.join` and §9 "Shared-file rules"),
`docs/testing/e7-selectors.md` (Co-op rows and the `e5-coop` scenario line),
`docs/testing/e5-selectors.md`, `docs/decisions/0004-governance-enforcement.md` and
`docs/decisions/0020-coop-policies.md`. Do not look outside the repository. Work in your own git
worktree on a branch named `e7/coop`, created from the E7 contract-step commit the orchestrator
gives you (run `git merge main` first if main moved).

## Why

E5 left four follow-ups (HANDOFF.md:40-46, ADR 0020 :55-58 and :74): a viewer who qualified by
subscription and exited can never rejoin (the membership sync respects the exit forever and only
a new share re-enrols); every co-op page shows a skeleton forever when its load fails; the
membership view computes streaming hours for every channel owner on each call; board elections
are read-only in the web although the API can nominate and vote. Stripe shares and patronage
payouts are M1's, not yours.

## You own (write only these)

- `services/api/src/coop/**`, `services/api/src/routes/coop.ts`
- `packages/governance/src/inputs.ts` and `packages/governance/src/membership.ts` (only if the
  rejoin needs a rule change there), with tests in `packages/governance/tests/`
- `services/worker/src/coop/**` (only if the membership sync must change for rejoin) and
  `services/worker/tests/coop*.ts`
- `services/api/tests/coop.int.test.ts`, `services/api/tests/coop.test.ts`
- Web: `apps/web/src/routes/_app/coop.*.tsx` (existing files only: no new route),
  `apps/web/src/components/coop/**`, `apps/web/src/i18n/coop.ts` (your catalog; the E5 test
  requires every key to be used and the catalog to stay disjoint),
  `apps/web/tests/coop*.test.ts(x)`, `apps/web/tests/coop-fixtures.ts`
- Harness: `harness/scenarios/e5-coop.ts`, `harness/src/coop.ts`, `harness/src/coop-*.ts`,
  `harness/tests/coop.test.ts`

Read-only: `packages/contracts/**`, `packages/db/**`, `harness/src/e7/selectors.ts`,
`docs/testing/*`, every other i18n file, `apps/web/src/routeTree.gen.ts`. Anything else is a
**contract request** with the exact diff. Do not edit ADR 0020; propose wording in your final
message.

## Contracts you must honor (read-only for you)

- `packages/contracts/src/api/router.ts`: `coop.membership` (:1902-1909), `coop.exit`
  (:1940-1948), the new `coop.join` (`user`, `write` bucket, `POST /coop/membership/{class}/join`,
  input `{ class: "viewer" }`, output `MembershipView`), `coop.elections.list/nominate/vote/create`
  (:2090-2133: `nominate` `{ id, statement ≤ 5000 }`, `vote` `{ id, candidateIds (1-50) }` approval
  ballot up to the seats), `coop.board`.
- `events.ts` `coop.membership.update` (write it on join, as `exit` does via `membershipEvent`).
- Tables `memberships` (`packages/db/src/schema/coop.ts`, `memberships_active_uq` one active row
  per user and class), `membership_history` (trigger-written), `stream_hours`
  (`schema/media.ts:77-95`, index `stream_hours_channel_idx (channel_id, hour_start)`),
  `channels.owner_id` (unique).
- ADR 0004/0020 rules: voluntary exits are respected by the sync; governance writes go through the
  database protections; never weaken a trigger.
- `docs/testing/e7-selectors.md`: `membership-rejoin-viewer`, `coop-load-error`/`coop-retry`,
  `election-nominate`, `election-candidate`, `election-ballot`, `election-voted`; existing
  `election-item` (`e5-selectors.md:200`).

## What is there today (verified at `9c51c93`)

- `services/api/src/coop/membership.ts`: `activate` (:67-80) inserts an active row with a basis;
  `membershipView` (:82-160) loads memberships, shares, hours and subscriptions in parallel and
  calls `eligibleHoursByUser(db, from, now, cap)` (:96) which sums eligible hours for **every**
  channel owner (`packages/governance/src/inputs.ts:31-48`) to read one user's value (:139);
  `subscriptionQualifies` decides the viewer basis (:142-…); `exit` (:314-…) sets
  `status = exited`, `exitedAt`, audits `membership.exit`, emits the event.
- `packages/governance/src/membership.ts:58-80`: `exitWindowDays`/`exitRespected`: the sync never
  re-enrols a viewer whose latest viewer row is `exited`; only a share purchase does today.
- The contract step stubs `coop.join` in `membershipHandlers` and maps it in `routes/coop.ts`.
- Web: co-op pages load through `apps/web/src/components/coop/use-coop.ts` (`Loaded<…>`); a failed
  load leaves `null` and the pages render `<SkeletonGroup>` forever (e.g.
  `routes/_app/coop.proposals.$id.index.tsx:66-71`). Elections are listed read-only on
  `/coop/council` (`components/coop/council.tsx:104-120`, `election-item`).

## Build

1. **`coop.join` (viewer rejoin).** Signed in; no active viewer membership (`CONFLICT`); the
   caller's current subscriptions qualify under the live rules (`subscriptionQualifies`, same
   inputs as the view; else `FORBIDDEN` with a message saying what is needed). One transaction
   with the user lock the exit path uses: insert an active viewer row with basis `subscription`,
   audit `membership.join` (ids, class, basis), `coop.membership.update` event. The membership
   history trigger records it. Make sure the sync keeps it: with the new row the latest viewer row
   is active, so `exitRespected` no longer applies; if the sync would still drop it, fix the rule in
   `packages/governance/src/membership.ts` with a test. Return the refreshed `MembershipView`.
   A viewer who qualifies by share keeps the share path (`buyShare`); `join` never creates a share.
2. **Cheaper membership view.** Add `eligibleHoursForUsers(db, userIds, from, to, cap)` to
   `packages/governance/src/inputs.ts` (join through `channels.owner_id = any(userIds)` so the
   `stream_hours_channel_idx` range scan serves it) and use it in `membershipView` for the one
   user. Keep `eligibleHoursByUser` for the sync. Prove equality with the old function on a
   fixture with several owners and the daily cap; check `EXPLAIN` uses the channel index in an
   integration test (assert on the plan text loosely, or document the check if the planner choice
   is data-dependent). No migration is needed (`channels.owner_id` is unique, `stream_hours` has
   the channel index).
3. **Retry instead of a skeleton forever.** Every co-op page and panel distinguishes loading,
   loaded and failed; failed renders `coop-load-error` with `coop-retry` that re-runs the load
   (no full page reload). Put the state in `use-coop.ts` so every page gets it.
4. **Board elections you can use** on `/coop/council` (no new route): for an `election-item` in
   `nominating`, a member of its class can stand (`election-nominate` → statement → submit); in
   `voting`, an eligible member sees the candidates (`election-candidate`) and an approval ballot
   (`election-ballot-<candidateId>`, at most `seats` checked, `election-ballot-submit`), then
   `election-voted`. Admins get "schedule an election" only if it fits the page without a new route
   (otherwise leave it API-only and say so). Errors from the API (not a member, closed, already
   voted) show inline; ballots are secret (never show who voted for whom).
5. **Membership page.** `membership-rejoin-viewer` exactly as `e7-selectors.md` says (button →
   `ConfirmDialog` → `coop.join` → refreshed view; toast on error).
6. **Harness `e5-coop`.** Add the rejoin case from `e7-selectors.md`: a viewer who is a member by
   subscription only exits (`membership-exit-viewer`), the sync does not re-enrol them (tick
   `membership-sync` through the existing coop test hook), then `membership-rejoin-viewer` makes the
   viewer row `active` with basis `subscription`. `--set via=api` uses `coop.join`. If the
   scenario has a cheap place for a nominate-and-vote check against a scheduled election, add it
   too; otherwise leave elections to unit and web tests and say so.

## Tests you must add

- Governance unit: `eligibleHoursForUsers` equals `eligibleHoursByUser` for the same users; cap
  and window boundaries; empty user list.
- API integration (`createTestDatabase()`): join after exit (active, basis `subscription`, audit,
  event, history row), join with an active viewer row → 409, join without a qualifying
  subscription → 403, join never touches shares; the sync keeps a rejoined viewer and still
  respects a plain exit; the membership view's hours equal the old computation.
- Web: retry state on each co-op page (failed → retry → loaded), rejoin button visibility rules,
  nominate and ballot (max seats, secret), selector ids present.
- Harness: `coop.test.ts` cases for any pure helper you add.

## Done means

Follow `.claude/briefs/_done-means.md`, except that the orchestrator runs the gate this batch:
run only targeted checks (`bun --bun vp test run` in `packages/governance`, `services/api`
(and `test:int`), `services/worker` if you touched it (its `test:int` not at the same time as the
API's), `apps/web`, `harness`; `bunx tsc -p` for each; `vp lint --deny-warnings` and `vp fmt` on
your paths; `vp build` in `apps/web` and confirm `git diff apps/web/src/routeTree.gen.ts` is
empty). Never run `bun run verify`, `podman`, `scripts/infra.ts` or a harness scenario; give the
user the exact `bun harness/src/cli.ts run e5-coop` commands (web and `--set via=api`). `git
status` shows only your paths. Commit in your worktree (`git commit -s`, Conventional Commits,
ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Final message: what you
built, test counts per package, branch and sha, contract requests (exact diffs), proposed ADR 0020
follow-up wording and README text, and anything left undone.
