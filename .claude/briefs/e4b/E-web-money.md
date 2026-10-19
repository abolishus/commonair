<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **E4b unit E, web-money** for CommonAir (repo: /Users/joshe/Repos/bcon).
Read AGENTS.md, PLAN.md, docs/architecture.md and `.claude/briefs/e4b/_common.md` first, then
`docs/testing/e4b-selectors.md` in full, `packages/ui/README.md`, `packages/ui/DEVIATIONS.md`,
and the E4a design rules in `.claude/briefs/e4/_common.md` (they still apply to everything you
add in `packages/ui`). Do not look outside the repository.

## You own (write only these)

- apps/web: `src/routes/_studio/revenue.tsx`, `src/routes/_admin.tsx` (the platform-tools layout
  on `AdminShell`), `src/routes/_admin/treasury.tsx`, `src/routes/_app/transparency.tsx` (replace
  the placeholders), `src/routes/_studio.tsx`, `src/routes/_studio/dashboard.tsx` (only to add
  `revenue-link`; keep every e1–e3 id), `src/components/money/**` (new), `src/lib/money.ts`
  (new; code-to-key maps typed as `MessageKey` allowed), `src/lib/nav.ts`,
  `src/components/site-chrome.tsx`, `src/i18n/money.ts` (your catalog, spread into `en.ts`; the
  nav strings you add go here too), `tests/money*.test.ts(x)`, `tests/nav.test.ts`, and your rows
  in `tests/composition-ids.ts` and `tests/selectors-render.test.tsx`
- packages/ui: new files under `src/blocks/data/` for anything the Revenue/Transparency/treasury
  pages need that does not exist, `src/blocks/data/index.ts`, their stories under
  `stories/blocks/data/` and tests under `tests/blocks/data/`; additive prop changes to existing
  `src/blocks/data/*` blocks (e.g. per-row/per-segment `data-*` passthrough on `DataTable` rows,
  `BreakdownBar` legend items, `StatCard`) with their stories and tests; and
  `stories/pages/{Revenue,Transparency}.stories.tsx` if you change props they use

Unit D owns the Support dialog, `/settings/subscriptions`, chat and the form blocks in parallel.
You add **their** nav entry (`account-subscriptions-link` → `/settings/subscriptions`; the route
file exists). Do not edit `tests/selectors.test.ts` or `tests/i18n.test.ts`; the head agent adds
the e4b doc to them after both web units merge. Never edit `packages/ui/src/blocks/forms/*`; if
you need a forms change, report a contract request.

## Contracts you must honor (read-only for you)

- `money.revenue`, `money.revenueLedger`, `money.payoutAccount`, `money.tiers`,
  `money.setTiers`, `money.treasurer.*`, `coop.transparency` and their DTOs (`RevenueSummary`,
  `RevenueLine`, `TreasurerPayment`, `TreasurerPayout`, `TransparencyMonth`); `MONEY_LIMITS`;
  `Me.role` (`treasurer`) from the bootstrap.
- The test ids in the spec's "Navigation", "/revenue", "/treasury" and "/transparency" sections.
- The API is being built in parallel (units A and B). Code against the contract types; tests mock
  the oRPC client the way the existing web tests do.

## Build

1. **Nav**: studio sidebar + `/dashboard` `revenue-link`; account menu
   `account-subscriptions-link` (everyone signed in) and `account-treasury-link` (treasurers
   only); footer `footer-transparency-link`. Extend `nav.ts` data + `nav.test.ts`.
2. **`/revenue`** (Revenue board, `packages/ui/stories/pages/Revenue.stories.tsx`): `PageHeader`
   with the month `FilterBar` (current month and the eleven before it); `StatGrid` of
   `StatCard`s (available with progress toward the minimum, held, owed when > 0, earned with the
   delta vs `previousNet`); `BreakdownBar` by source; `DataTable` subscribers by tier; the
   revenue ledger `DataTable` with `StatusBadge` types, `MoneyAmount colorNegative`, "load more"
   paging; the CSV statement (built in the browser from `revenueLedger` pages of the selected
   month: header row, ISO timestamps, cents as integers and a formatted column, no names of
   anonymous tippers, values CSV-escaped and formula-injection safe — prefix `=`,`+`,`-`,`@`
   cells with `'`); the payout account `Card` (manual instructions or an onboarding link); the
   tier editor `FormSection` (three tiers: name, `AmountField` price, benefits; validation as
   the API's: increasing prices within `MONEY_LIMITS`). Loading: `Skeleton*`; empty: `EmptyState`.
3. **`/treasury`** (no board: build it from `AdminShell`, `PageTabs`, `DataTable`, `ActionRow`,
   `Dialog`, `ConfirmDialog`, `FormSection`, `AmountField`, `StatusBadge`): payments (reference
   search; pending list; confirm; refund/chargeback dialog), payouts (run, result, rows, mark
   paid dialog), payout accounts form, costs form. Treasurers only: anyone else gets the app's
   not-found page (no flash of the page; guard in `beforeLoad` like `/relays`, plus the role).
   Every action toasts success and refreshes its list; errors via `toastActionError`.
4. **`/transparency`** (Transparency board): public. Period `FilterBar` (last 3 / 6 / 12
   months), `StatGrid` (revenue, payouts, costs, surplus summed over the months), "where every
   dollar went" `BreakdownBar` (creator payouts, costs by category, co-op retained), a monthly
   `DataTable` (`transparency-month-row`), and a `MetricPanel` for relay egress share from
   `egressBySource`. The patronage formula and statement cards are E5 (leave them out; no dead
   UI). `EmptyState` when there are no months.
5. Money always via `<MoneyAmount>` / `formatMoney` with the DTO's currency, timestamps via
   `<RelativeTime>`, all strings via `t()`.

## Tests you must add

- `src/lib/money.ts` pure logic: month options, delta math, CSV builder (escaping, injection
  guard, integer cents), tier-form validation, nav visibility by role.
- SSR render of each page with every spec id present (`selectors-render.test.tsx` rows, mocked
  data), treasury guard (non-treasurer → not found), nav tests.
- packages/ui: behaviour + a11y + SSR/hydration for any new block and new props.

## Done means

See `_common.md` "Done means". Your packages: `apps/web` (`bun run test`, `tsc`, `vp build`) and
`packages/ui` (`bun run test`, `tsc`, `bun run build-storybook`, then delete
`storybook-static/`), lint/fmt on changed paths.
