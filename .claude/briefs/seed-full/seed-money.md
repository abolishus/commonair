<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# seed-money: subscriptions, tips, payments, disputes, payouts, fraud holds, costs and the ledger

You are implementing unit seed-money for CommonAir (repo: /Users/joshe/Repos/bcon).

Read these first:

- AGENTS.md
- PLAN.md
- docs/architecture.md
- `.claude/briefs/seed-full/README.md`
- `.claude/briefs/seed-full/common.md`. It holds the shared rules, the read-only contract and the
  tests every unit adds, and all of it applies here.

Do not look outside the repository.

- Branch: `seed/money`, from `main` after seed-social merges.
- Wave 1. seed-coop depends on your output (share purchases and patronage need revenue), so
  publish what coop needs early.

## You own (write only these)

- `harness/src/seed/money.ts`, `harness/src/seed/money/**`
- `harness/tests/seed/money*.test.ts`

## Contracts you must honor (read-only for you)

- `harness/src/money-actors.ts`: `ApiSupporter`, `ApiTreasurer`, `ApiCreator`, `ApiPublic`.
- `harness/src/money.ts`: splits, `expectedFigures`, ledger checks.
- `harness/src/stripe.ts`: the webhook builders and `StripeWebhook`.
- `@commonair/ledger`.
- The money procedures in `@commonair/contracts`.
- `services/api/src/routes/money.ts`, read only to learn what each step needs.
- The FOSS default is the `manual` provider, and the money scenario's `PROVIDERS` lists both
  providers. Seed with stripe-mock when the stack has it. Otherwise use the manual provider, and
  record which one you used in `notes`.

## Build

Every ledger, payout and fraud row comes from the API, the webhooks or the worker. Never insert
them yourself.

1. **Subscriptions.**
   - viewer1 subscribes to the fixed streamers at all three tiers, including one gift.
   - Bulk viewers subscribe in a power-law across channels.
   - Give some subscriptions each lifecycle state the API supports: active, cancelled at period
     end, expired, past due.
   - Drive checkout through `ApiSupporter` and complete each payment with signed webhooks (the
     same path `scenarios/money` uses).
2. **Tips.** Many small tips with varied amounts and currencies, if more than one is enabled.
   viewer1 sends several. streamer2 receives enough to show a real revenue page.
3. **Refunds and disputes.**
   - At least one full refund.
   - At least one partial refund, if the API supports partial refunds.
   - Disputes in each state: opened, won and lost, via the `dispute` webhook builder.
   - `disputeReachedLedger` must hold for each one.
4. **Payout accounts and payouts.**
   - Payout accounts for the fixed streamers: streamer1 is verified, and streamer2 is held, as its
     purpose says.
   - `ApiTreasurer` runs a payout, so `/treasury` has paid, pending and held payees.
5. **Fraud flags.** Trigger at least one flag that the treasurer can release and one that stays
   held, through whatever the fraud rules react to (read the API to find it). If a flag can only be
   triggered by something unsafe, such as velocity against real limits, leave the table pending
   and send a contract request for a test hook.
6. **Infra costs and treasury.** The treasurer records several months of `infra_costs` and the
   treasury postings, through the API. If the API accepts a period or `occurredAt`, spread these
   over `historyDays`. If it doesn't, note that the revenue and transparency charts only show the
   current period.
7. **Checks before returning.** Run `unbalancedTransactions` and `inconsistentLedgerRows` over
   what you wrote. Both must be empty.
8. **Store.** Publish `store.extra.money`:
   - `provider`;
   - `subscriptionsByUser`, mapping a handle to `{ channelSlug, tier, status }[]` (coop's
     viewer-membership basis needs it);
   - `revenuePeriod`, the UTC month that holds the revenue;
   - `paidCreators`, the list of creator handles.

## Tests you must add

- The tests in common.md.
- Plan splits match `splitPayment` / `expectedFigures` for every planned payment.
- Every subscription and dispute state appears at `small`.
- No float arithmetic: all amounts are integer cents.
- Currency is explicit.
- `subscriptionsByUser` agrees with the plan.

## Routes you fill

- `/revenue`
- `/settings/subscriptions`
- `/treasury`
- `/transparency`: revenue and costs
- `/dashboard`: revenue tiles
- the money events in `/$channel` chat history

## Done means

common.md "Done means", plus:

- the flags the run needs, for example the stripe-mock profile;
- which provider you seeded with.
