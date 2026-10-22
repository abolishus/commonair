<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

## E5 rules every unit follows (read all of this)

**Slice.** E5 is the co-op: memberships and shares, proposals with discussion, creator-council
review, votes and per-class tallies, the protected-decision rule, the council, patronage runs and
statements, and the transparency page. **The spec every unit builds against is
`docs/testing/e5-selectors.md`**: rules, flow tables, routes, test ids, the `e5-coop` scenario
and its test hook. Read it in full. If the spec and your brief disagree, the spec wins; report the
disagreement. Policy: `docs/decisions/0020-coop-policies.md`. Enforcement: ADR 0004.
Member-facing rules: `docs/governance/decision-process.md`.

**Read first.** AGENTS.md (all of it: append-only columns, outbox, audit, logging without PII,
money in integer cents, design rules, house primitives), then the contract the head agent
committed on `main` (`231b2c0`, `ede4cdd`, `12d930b`):

- `packages/contracts/src/api/router.ts` (`coop.*`, about line 1864), `api/entities.ts`
  (`MembershipView`, `ShareView`, `ProposalView`, `ProposalComment`, `CouncilView`,
  `ElectionView`, `PatronageStatement`, `PatronagePeriodView`, `TransparencyMonth`),
  `api/common.ts` (`finance` access, `VOTE_REFUSED`, `SECOND_APPROVER`), `shapes.ts`
  (`GovernanceChange`, `GovernanceRuleSnapshot`, `TallyBreakdown`, `PatronageLine`), `enums.ts`
  (co-op section, `SHARE_STATUSES` now has `refund_pending` and `cancelled`), `events.ts`
  (`coop.proposal.update` is public; the other `coop.*` events are internal), `internal.ts`
  (`QUEUES.coop`, `COOP_JOBS`, `CoopJob`, `CoopTickBody`, `CoopJobResult`,
  `INTERNAL_ROUTES.coopTick`).
- `packages/db/src/schema/coop.ts`, migrations `0001_protections.sql`,
  `0002_protections_hardening.sql` and **`0021_coop_protections.sql`** (read the header: it lists
  every new trigger), and `packages/db/tests/coop.int.test.ts` + `protections.int.test.ts`
  (what the database already refuses).
- `packages/governance` (rules, tally, council, elections, membership, inputs) and
  `packages/patronage` (formula, explain, inputs, run; `computePeriod` now takes `computedById`),
  `packages/ledger` (`sharePurchase`, `shareRefund`, `patronageAllocation`, `closePeriod`,
  `retainedSurplus`, `post`), `packages/payments` (`manualAdapter`, `CheckoutRequest`).
- `packages/config/src/env.ts` (`coopEnv`: `COOP_TEST_HOOKS`; `GOVERNANCE_BOOTSTRAP_JSON`).

**Rules a reviewer marks HIGH when broken.**

- **Database-first (ADR 0004).** The triggers are the enforcement layer; application checks come
  in addition and give clear errors. Never weaken, bypass or work around a trigger (no owner
  connection in services, no `session_replication_role`, no disabling triggers). If a trigger
  blocks a legitimate flow, stop and report a contract request. Your integration tests prove the
  application path works **and**, where your unit writes those tables, that the database refuses
  the bypass. Services connect as the app role; tests use `createTestDatabase().app`.
- **Vote integrity.** One vote per member per proposal (a change is an update of the member's
  own row); only the frozen electorate; only inside the window. A double vote, a vote outside the
  electorate or window, or a protected decision recorded as passed is HIGH.
- **One tally.** The TS `tally()` and the SQL `commonair_governance_tally` must agree; the
  `tallies` row (outcome, reason, every count) is checked by the trigger. A tally the DB and the
  API disagree on is HIGH.
- **Secret ballot.** A choice never goes into audit `details`, events, logs, notifications or any
  response other than the voter's own `myVote`. No running yes/no tally before the decision.
- **Money.** Integer cents with a currency; every posting through `post` in the same transaction
  as the state change; ledger rows append-only and balanced. An unbalanced or non-append-only
  posting, a share refunded without its posting, or a patronage allocation approved by the person
  who ran it is HIGH.
- **Audit and outbox.** Every governance, membership, council, share and patronage action writes
  its `audit_log` row and its `events` row in the same transaction (spec lists the actions).
  Audit `details`: ids, enums and numbers only. Free text the actor wrote goes to audit `reason`.
- **No personal data** in append-only columns, logs, events or audit `details`. Reference users
  by id.
- **Races.** State changes are compare-and-set or row-locked (lock order: payment → share →
  membership; proposal before votes; patronage period before its lines). A race that
  double-applies or loses a decision is HIGH.
- **Errors.** Map trigger exceptions (SQLSTATE `42501`, `23514`, `23505`, `P0001`) to the
  contract's error codes in the handler; never a 500 with SQL text, never a stack trace.

**Web rules** (units C and D, and anyone touching UI). AGENTS.md "Design rules (web)" and "House
primitives" are hard rules, enforced by `apps/web/tests/source-policy.test.ts` and
`packages/ui/tests/source-policy.test.ts`. Pages are built only from `packages/ui` layouts,
blocks and components; the co-op boards in `packages/ui/stories/pages/` (`Coop`, `Proposal`,
`Transparency`, and the new ones unit C adds) show the intended composition. A missing
composition is a contract request to unit C (batch 1) or the head agent, never page-local
styling. Every e1–e4c test id stays intact. User-facing strings go through i18n.

**Process.** You work in your own git worktree: run `git merge main --no-edit` first, then
`bun install` if `node_modules` is missing. Do not edit contracts, db schema/migrations, config,
root `package.json`, `bun.lock`, scripts, `compose.yaml` or root lint config: report a contract
request instead (the head agent applies them). No new npm dependencies unless your brief says
so. Never add anything to `trustedDependencies`.

## Done means (every brief)

- **Targeted checks only.** The user runs the gate (`bun run verify`), image rebuilds, harness
  scenarios against the live stack, dev servers, Storybook and every browser/visual check. You do
  not. Run: your packages' `bun run test` and `bun run test:int` (the data services are already
  up at the `.env.example` defaults; never run `podman compose`, `scripts/infra.ts` or `infra`'s
  `test:int`), `bunx tsc -p <pkg> --noEmit`, `vp lint --deny-warnings <changed paths>`,
  `vp fmt <changed paths>`, `vp build` for `apps/web`, `build-storybook` for `packages/ui`. Never
  run several packages' `test:int` at the same time. In zsh, pass several paths as separate words.
- No files outside your ownership list changed (`git status`).
- Commit in your worktree with `git commit -s` (Conventional Commits) and explicit paths, never
  `git commit -a`; message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`,
  once your targeted checks pass.
- Final message: what you built, test counts per package, branch + commit sha, **contract
  requests** (exact changes needed in files you do not own), anything left undone, and the exact
  commands the user should run live to exercise your work.

## Review (the head agent runs this; know what you will be held to)

An independent reviewer reads your diff against this file, the spec and AGENTS.md **before**
merge. Any HIGH is fixed and gets a focused re-review. Units A (API) and B (worker) also get a
**second, security-focused reviewer** (vote integrity, the protected-decision path, tallies, share
refunds, patronage postings, authorization, log hygiene) even when the first finds no HIGH.
