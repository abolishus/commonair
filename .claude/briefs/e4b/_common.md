<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

## E4b rules every unit follows (read all of this)

**Slice.** E4b is money (PLAN.md): the manual adapter first, then Stripe against stripe-mock. The
spec every unit builds against is **`docs/testing/e4b-selectors.md`**: the payment-flow table
(API and worker behaviour), the routes and the test ids. Read it in full. If the spec and your
brief disagree, the spec wins; report the disagreement.

**Read first.** AGENTS.md (all of it: money rules, append-only columns, outbox, audit, design
rules, house primitives), HANDOFF.md "Session six in flight", docs/architecture.md "Money",
ADR 0003 §7 and ADR 0004, `packages/ledger/README.md` (conventions, rules, poster, holds,
reversals, payout batch), and the code you build on: `packages/contracts/src/api/router.ts`
(`money.*`, `coop.transparency`), `packages/contracts/src/api/entities.ts` (`SupportInfo`,
`RevenueSummary`, `RevenueLine`, `Treasurer*`, `Subscription`, `Tip`, `Payout`, `LedgerLine`,
`TransparencyMonth`), `packages/contracts/src/currency.ts` (`MONEY_LIMITS`,
`MANUAL_REFERENCE_PATTERN`), `packages/db/src/schema/money.ts` (+ migration
`0013_money_gifts_and_expiry.sql`), `packages/payments/src`, `packages/config/src/env.ts`
(`paymentsEnv`).

**Money rules (a reviewer marks any breach HIGH).**

- Integer cents with an explicit currency everywhere; never floats, `toFixed`, or `Number`
  arithmetic on fractions. The cut and payout rules come from `loadMoneySettings(db)` per
  operation (`@commonair/ledger`), never env or constants.
- Ledger writes only through `@commonair/ledger` (`post`, `postReversal`,
  `postChargebackReversal`, `releaseDueHolds`, `runPayoutBatch`, `postPayout`), inside the same
  database transaction as the state change. Read balances from the ledger (`creatorBalances`,
  `statement`, `monthlyAggregates`, `holdLots`), not from `payments`.
- Never put personal data or user free text into ledger descriptions/memos/metadata or audit
  `details` (ids and enums only). Treasurer reasons go to `disputes.reason` and the audit `reason`.
- Every outward state change writes its `events` outbox row in the same transaction; every
  treasurer action writes an `audit_log` row. Concurrency: state transitions are compare-and-set
  (`update … where status = <expected> returning`) or row-locked (`select … for update`), so a
  double confirm or a refund racing a chargeback cannot double-post (the ledger's idempotency keys
  are the second line of defence).
- Stripe is optional (AGENTS.md rule 3): nothing in the manual path may import or call Stripe.

**Web rules.** AGENTS.md "Design rules (web)" and "House primitives" are hard rules, and
`apps/web/tests/source-policy.test.ts` enforces them (no raw interactive HTML, no arbitrary
Tailwind values, no hex, tokens only, `t()` for every string, `<MoneyAmount>`/`formatMoney`
for money, `<RelativeTime>` for timestamps, `<ConfirmDialog>` for destructive confirmation,
`toast.*` from `@commonair/ui/toast`). Build pages only from `packages/ui` layouts, blocks and
components; the matching Storybook board (`packages/ui/stories/pages/<Board>.stories.tsx`) shows
the intended composition with sample data. A missing composition is a **contract request** to the
head agent (exact component, props and story), never page-local styling. Test ids may reach the
DOM through composition props; list such ids in `apps/web/tests/composition-ids.ts` and prove them
in `apps/web/tests/selectors-render.test.tsx` the way the e1–e3 ids are (you own your rows there;
add, never reorder others'). Every e1–e3 id stays intact.

**Process.** You work in your own git worktree: run `git merge main --no-edit` first, then
`bun install` if `node_modules` is missing. Do not edit contracts, db schema/migrations, config,
root `package.json`, `bun.lock`, scripts or root lint config: report a contract request instead
(the head agent applies them). No new npm dependencies unless your brief says so.

## Done means (session six process rules — every brief)

- **Targeted checks only.** The user runs the gate (`bun run verify`), image rebuilds, harness
  scenarios against the live stack, dev servers, Storybook and every browser/visual check. You do
  not. Run: your packages' `bun run test` and `bun run test:int` (the data services are already up
  at the `.env.example` defaults; never run `podman compose` or `scripts/infra.ts`),
  `bunx tsc -p <pkg> --noEmit`, `vp lint --deny-warnings <changed paths>`, `vp fmt <changed paths>`,
  `vp build` for `apps/web`. Do not run several packages' `test:int` at the same time.
- No files outside your ownership list changed (`git status`).
- Commit in your worktree with `git commit -s` (Conventional Commits), message ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, once your targeted checks pass.
- Final message: what you built, test counts per package, branch + commit sha, **contract
  requests** (exact changes needed in files you do not own), anything left undone, and the exact
  commands the user should run live to exercise your work.
