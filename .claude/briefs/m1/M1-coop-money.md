<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# M1-coop-money: co-op shares by Stripe Checkout, and paying patronage out

You are implementing unit M1-coop-money for CommonAir (repo: /Users/joshe/Repos/bcon). Before you
start, read:

- AGENTS.md, PLAN.md and docs/architecture.md.
- `.claude/briefs/batch8/README.md`. Decisions U1, (b), (c) and (r), the path ownership, the
  shared rules and the money rules are binding.
- `.claude/briefs/b8/contract-step.md`:
  - §0 (the existing share and patronage rules);
  - §2.1–§2.3 (`patronage_payouts`, its trigger, `patronagePayoutReversed`);
  - §2.5 (your `stripe-events/shares.ts`);
  - §2.7 (`coop.patronage.payouts` and `coop.patronage.pay`);
  - §4.3–§4.4.
- ADR 0020 (the co-op), ADR 0007 Amendment 1 and `.claude/briefs/m1/M1-connect.md`. Its transfer
  service is merged and is what a Connect patronage payout uses.
- `packages/ledger/README.md` (the `share_purchase`, `shareRefund` and `patronagePayout` rows).
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 2**: work in your own git worktree, on branch
`m1/coop-money`, cut from `main` after wave 1 merged.

## Why

- **Shares.** `buyShare` refuses every provider but manual, with `manual_shares`
  (`services/api/src/coop/membership.ts:236-238`).
- **Patronage.** Patronage allocations credit each member's patronage payable
  (`packages/ledger/src/rules.ts:1063-1080`), but nothing pays them out. `patronagePayout`
  (`:1095-1112`) is called only by its unit test.

This unit lets a member buy their share by card through Stripe Checkout, on stripe-mock. It also
gives treasurers a payout path for patronage, manual first and Connect second. **The manual path
stays the default for shares** (rule 3, and the post-launch review item on card payment for
shares). **No live key** (decision (b)).

## You own (write only these)

- `services/api/src/coop/{membership,shares,patronage-payouts}.ts`. `patronage-payouts.ts` is new,
  for `coop.patronage.{payouts,pay}`.
- `services/api/src/money/stripe-events/shares.ts`.
- `services/worker/src/coop/patronage-payout*.ts` (new) and `services/worker/src/jobs/patronage-payout.ts`.
- `apps/web/src/routes/_app/coop.membership.tsx`, `apps/web/src/components/coop/{shares,patronage-payouts}*`
  (new), and `apps/web/src/routes/_app/coop.patronage.$periodId.tsx` (the payout section).
- `apps/web/src/i18n/locales/{en,es}/m1-coop.json` and `keys/m1-coop.gen.ts`.
- `harness/src/b8/coop-money.ts`.
- Tests named after these files.

**Read-only:** `packages/{ledger,payments,contracts,db,config}/**`, `services/api/src/money/**`
(except your handler file), `services/worker/src/money/transfers*.ts` (M1-connect's: call it, do not
change it), and `services/api/src/coop/patronage.ts`. Anything else is a **contract request**. That
includes the terms and privacy wording for card share purchases and patronage payouts, marked "not
reviewed by counsel (none retained)".

## Build

1. **Shares by Stripe.**
   - When `PAYMENTS_PROVIDER = stripe` **and** a new co-op setting `shares.cardPayments` is true,
     `buyShare` starts a Stripe Checkout for the viewer share price. The setting is an ordinary
     governance setting, seeded false by the contract step (§2.7).
   - Otherwise `buyShare` keeps answering `manual_shares` under Stripe, as today.
   - It writes the same `payments` (`membership_share`) and `membership_shares` rows as the manual
     path, with the same advisory lock (`membership.ts:250-251`).
   - `checkout.completed` for that payment (`stripe-events/shares.ts`) confirms the payment, posts
     `share_purchase`, and activates the membership through the existing membership hooks, all in
     one transaction with the outbox event.
   - A failed or expired checkout releases the pending share as the manual expiry does
     (`services/worker/src/money/expire.ts:58`, `cancelShares`).
2. **Share refunds per the bylaws** (ADR 0020).
   - A member who leaves gets the share refunded through the existing `coop.shares.refund` flow
     (`refund_pending` → refunded).
   - For a Stripe-paid share, the treasurer's action requests the refund at Stripe through the same
     outstanding-request guard as other refunds. It calls `requestProviderRefund` from
     `stripe-refunds.ts` (read-only for you).
   - The `shareRefund` posting follows `charge.refunded`.
   - Never refund automatically on leaving. The bylaws' timing is the treasurer's call, and the UI
     says so.
3. **Patronage payouts.**
   - `coop.patronage.pay({periodId})`, by treasurers, with two approvers as for write-offs: the
     first call records a request, and a second treasurer approves it. It needs the period
     `approved` with allocations, and it is audited.
   - It creates one `patronage_payouts` row per member with a positive allocation, in one
     transaction.
   - **Manual adapter** (the default): rows are `pending` until a treasurer marks each `paid` with a
     reference. That posts `patronagePayout` (Dr patronage payable, Cr cash:manual).
   - **Stripe:** for members with a ready Express account, the `patronage-payout` job calls
     M1-connect's transfer service, with the key `patronage-payout:<periodId>:<userId>`. On success
     it posts `patronagePayout` with `cash:stripe`. Members without an account stay `pending` for
     the manual path.
   - A reversal posts `patronagePayoutReversed` and returns the amount to the payable.
   - `coop.patronage.payouts` lists rows for treasurers. A member sees only their own row on the
     period page.
4. **Web.**
   - `coop.membership.tsx` shows "Pay by card" only when the instance and the setting allow it,
     otherwise the bank-transfer instructions as today (`share-buy-stripe`).
   - The period page gets a treasurer payout section (`patronage-payouts`, `patronage-pay`) and the
     member's own payout status.
   - Use `<MoneyAmount>`, `<ConfirmDialog>`, `toast.*` and `<EmptyState>`. Strings go in `m1-coop`,
     in `en` and `es`.

## Edge cases

- **Two share purchases racing:** one pending share per user, through the advisory lock and the
  existing share trigger.
- **A share paid by card after the member left during checkout:** book it, then mark the share
  `refund_pending`, so the treasurer refunds it. Never activate it.
- **A patronage payout** for a member whose account was deleted: the row stays `pending`, the money
  stays in the payable, and the treasurer sees "account deleted". No personal data is copied into
  the row or the ledger memo.
- **Rounding:** allocations are already integer cents. Payouts never split them.
- **The trigger's overpay guard:** a second `pay` call is idempotent and never creates a second row
  per member.

## Tests you must add

- **API integration (stripe-mock):**
  - a Stripe share purchase end to end with a signed `checkout.completed`;
  - the setting off answers `manual_shares`;
  - the manual path is unchanged;
  - a Stripe share refund goes through the guard and posts on `charge.refunded`;
  - patronage pay needs two approvers and is audited;
  - a manual patronage mark-paid posts;
  - a member's view shows only their own row.
- **Worker integration:**
  - the patronage Connect payout via M1-connect's service, with an injected failure;
  - a reversal returning to the payable;
  - a redelivered webhook changing nothing.
- **Ledger checks** after each: balances, and payable totals equal to allocations minus payouts.
- **Web unit:** the card-or-bank choice, the payout section states, and axe.
- **Harness** `harness/src/b8/coop-money.ts`, steps in `e5-coop`:
  - `share-stripe`: the setting is turned on by the step, then a share is bought by card on
    stripe-mock and membership is activated;
  - `patronage-payout`: an approved period is paid out manually for one member and through Connect
    for the seeded Express member.
  - The ledger balances after each.

## Reviewer focus

- A share purchase posts per the bylaws and activates membership in the same transaction.
- Refunds follow ADR 0020 and the shared refund guard.
- Patronage payouts go manual first, need two approvers, and never overpay.
- `manual_shares` is still the default.
- No personal data in ledger memos.

## Done means

Follow `.claude/briefs/_done-means.md`:

- `bun run test` and `test:int` in `services/api` and `services/worker`, one at a time;
- `bunx tsc -p` for each;
- `bun --bun vp test run` in `apps/web` and `harness`, and `vp build`;
- `vp lint --deny-warnings` and `vp fmt`;
- the i18n check;
- `reuse lint`.

`git status` shows only your paths. Commit with `git commit -s`.

Then tell the user to run:

```bash
bun harness/src/cli.ts run e5-coop --set b8=share-stripe,patronage-payout
```

They should also check the membership page and the period payout section by hand under `en`, `es`
and `en-XA`, at 320 px, in dark and light themes, keyboard only.
