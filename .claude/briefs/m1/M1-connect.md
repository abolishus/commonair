<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# M1-connect: Stripe Connect transfers at payout time (stripe-mock only)

You are implementing unit M1-connect for CommonAir (repo: /Users/joshe/Repos/bcon). Before you
start, read:

- AGENTS.md, PLAN.md and docs/architecture.md.
- `.claude/briefs/batch8/README.md`. Decisions U1, (b), (c), (f) and (r), the path ownership, the
  shared rules and the money rules are binding.
- `.claude/briefs/b8/contract-step.md`:
  - §0 (`payoutSent` reused);
  - §2.1–§2.2 (`payout_transfers` and its trigger);
  - §2.3 (`payoutTransferReversed`);
  - §2.4 (`createTransfer`, `retrieveTransfer`, `PaymentAdapter.transfer?`, the
    `stripe-transfers.ts` stub);
  - §2.5–§2.7 (your handler file, `money.treasurer.transfers`, the internal events);
  - §4.3–§4.4.
- ADR 0007 item 6 (`:52-54`) and its Amendment 1. W2-splits (`services/api/src/money/splits.ts`)
  and ADR 0036 (the fraud floor; held payees are never paid).
- `packages/ledger/src/payouts.ts`, the batch and lifecycle.
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 1**: work in your own git worktree, on branch
`m1/connect`, cut from the contract step's sha. M1-gifts-refunds runs beside you, in other money
files.

## Why

Payout runs record `provider: stripe` payouts for creators onboarded to Express, but move no money
(ADR 0007 item 6). The client has no transfer call (`packages/payments/src/stripe-client.ts:57-71`).
Express onboarding exists (`services/api/src/money/stripe-connect.ts`). This unit makes a payout run
create one Connect transfer per payout row, so per split recipient (W2-splits). It records the
transfer in the ledger, and returns failed and reversed transfers to the payee's payable.
**stripe-mock only** (decision (b)). The manual adapter stays the default and moves nothing.

## You own (write only these)

- `packages/payments/src/stripe-transfers.ts`.
- `packages/ledger/src/payouts.ts`, its send and cancel paths for Connect.
- `services/api/src/money/{stripe-connect,transfers}.ts`.
- `services/api/src/money/stripe-events/transfers.ts`.
- `services/worker/src/money/transfers*.ts` (new) and `services/worker/src/jobs/payout-transfers.ts`.
- `apps/web/src/components/treasury/payout-transfers*`.
- `apps/web/src/i18n/locales/{en,es}/m1-connect.json` and `keys/m1-connect.gen.ts`. This is
  your own namespace, so you never share `m1-money` with M1-gifts-refunds in the same wave.
- `harness/src/b8/money-connect.ts`.
- Tests named after these files.

**Read-only:** `packages/payments/src/{adapter,stripe-client,stripe,stripe-events}.ts`,
`packages/ledger/src/rules.ts`, `packages/{contracts,db,config}/**`,
`services/api/src/money/{splits,checkout-treasurer,stripe-events,stripe-webhook}.ts`. Anything else
is a **contract request**. That includes the terms and privacy wording for Connect payouts, marked
"not reviewed by counsel (none retained)".

## Contracts you must honor

- **`payout_transfers`** and its trigger: one transfer per payout; the status machine;
  `provider_ref` set once; `reversed_cents` only upward; refused for a manual or non-`scheduled`
  payout.
- **Ledger rules:** `payoutSent` (clearing → `cash:stripe`) at transfer creation;
  `payoutTransferReversed` on a reversal; `payoutCancel` on a definite create failure.
- **`PaymentAdapter.transfer?`** and `StripeClient.createTransfer` and `retrieveTransfer`.
- **Error classes:** `StripeOutcomeUnknown` against `StripeRequestError`.
- **Internal events** `money.payout_transfer.{created,failed,reversed}`, written in the same
  transaction as the state change (outbox).
- **`money.treasurer.transfers`**, and the test ids `payout-transfers` and `payout-transfer-status`.

## Build

1. **`stripeTransfer`** (`stripe-transfers.ts`):
   - build the form: `amount`, `currency`, `destination` (the payee's Express account),
     `transfer_group` (the payout run id), and `metadata` with the `payout_id` and `transfer_id`
     only, never a name or email;
   - use the idempotency key `payout-transfer:<payout_id>`;
   - map the answer to `{providerRef, amountCents, currency}`.
2. **Sending a payout run with Stripe.** The run already reserves and moves payouts to `scheduled`.
   For each `stripe` payout, enqueue `payout-transfers` with a stable job id per payout. The job:
   1. **Inserts** a `pending` transfer row with the idempotency key, in one transaction.
   2. **Checks** the payee after commit: the account has `payoutsEnabled` (`retrieveAccount`), and
      no fraud hold applies (ADR 0036 rules; the trigger is the backstop). If not, the payout goes
      back to the payable through `payoutCancel`, the transfer is marked `failed` with
      `failure_code = "account_not_ready"` or `"held"`, and nothing is called.
   3. **Calls** `transfer` outside any transaction.
   4. **On success:** in one transaction, the transfer becomes `created`, the payout becomes
      `paid`, `payoutSent` is posted, and the event is written. The existing payout-sent email goes
      out as today.
   5. **On a definite 4xx:** the transfer becomes `failed`, and the payout is cancelled through
      `payoutCancel`, so the amount returns to the payee's payable for the next run. Treasurers see
      it.
   6. **On an unknown outcome:** the transfer stays `pending` and the job retries with the
      **same** idempotency key, so Stripe answers with the same transfer. After the retries run out,
      the treasurer view shows "outcome unknown", and `retrieveTransfer` (by the id in a later
      answer) or a manual resolve settles it.
3. **Reversals** (`stripe-events/transfers.ts`):
   - `transfer.reversed` and `transfer.updated` with `amount_reversed` above the recorded
     `reversed_cents` post `payoutTransferReversed` for the difference.
   - They raise `reversed_cents`, set `reversed` when it is complete, and write the event and an
     audit row (actor system).
   - The reversed money lands back in the payee's payable, so it is paid in a later run. It never
     disappears.
   - A redelivered event changes nothing, because the cumulative idempotency key catches it.
4. **Treasurer view.**
   - `money.treasurer.transfers` lists transfers by run, with status, amounts, `failure_code` and
     reversed cents.
   - The `payout-transfers.tsx` tab shows them with `<MoneyAmount>`, `<RelativeTime>` and
     `<EmptyState>`.
   - Creators see nothing new except their payout turning `paid`.
5. **`stripe-connect.ts`:** the onboarding return path (`PAYOUT_RETURN_PATH`, `:22`) refreshes
   `payoutsEnabled`, so a creator who finishes onboarding is paid in the next run.

## Edge cases

- A payee whose Express account was deleted at Stripe: the 4xx `resource_missing` cancels the
  payout and marks the account not ready. Use the existing `account.updated` sync path.
- A currency other than the account's default: Stripe refuses it with a 4xx. Test the mapping.
- A payout of 0 is never transferred. It is below the payout minimum anyway; assert it.
- Two runs racing for the same payout: the unique `payout_id` index lets only one transfer exist.
- A reversal arriving before the `created` update commits (event order): the handler locks the
  transfer row. A reversal for an unknown transfer id is `ignored` with a warn log, and Stripe
  redelivers it.
- No live key path: `assertTestKey` (`stripe-client.ts:50-53`) already refuses live keys. Add a
  test that the transfer path calls it.

## Tests you must add

- **Unit:** the form building, the key, the answer mapping, the error classification, and the
  reversal difference computation.
- **Ledger:** payout reserve → transfer → sent → reversed balances to zero against the payable.
- **Integration against stripe-mock** (API and worker, one at a time):
  - a run with two split recipients creates two transfers with distinct keys;
  - a manual-adapter run creates none;
  - a not-onboarded payee is cancelled back to the payable;
  - an injected timeout keeps the transfer `pending` and the retry reuses the key;
  - a signed `transfer.reversed` (partial, then full) posts twice and then ignores a redelivery;
  - audit and outbox rows are written;
  - the trigger refuses a transfer for a manual payout.
- **Web unit:** the list states, and axe.
- **Harness** `harness/src/b8/money-connect.ts`, steps in `e4b-money`:
  - `connect-transfer`: the seeded Express creator is paid by a run, and the transfer exists on
    stripe-mock;
  - `transfer-reversed`: a signed local `transfer.reversed` returns the amount to the payable.
  - The ledger balances after each step.

## Reviewer focus

- One transfer per payout row, with an idempotency key stable across retries.
- A reversal returns to the payable through a ledger reversal, and is never lost.
- A failure cancels through `payoutCancel`.
- Nothing moves with the manual adapter.
- There is no live key path.
- No name or email is in Stripe metadata or in logs.
- Held payees are never transferred to.

## Done means

Follow `.claude/briefs/_done-means.md`:

- `bun run test` and `test:int` in `packages/payments`, `packages/ledger`, `services/api` and
  `services/worker`, one at a time;
- `bunx tsc -p` for each;
- `bun --bun vp test run` in `apps/web` and `harness`, and `vp build`;
- `vp lint --deny-warnings` and `vp fmt`;
- the i18n check;
- `reuse lint`.

`git status` shows only your paths. Commit with `git commit -s`.

Then tell the user to run:

```bash
bun harness/src/cli.ts run e4b-money --set b8=connect-transfer,transfer-reversed
```

They should also check the transfers tab under `en`, `es` and `en-XA`, at 320 px, in dark and
light themes, keyboard only.
