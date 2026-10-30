<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Payment fraud review

How treasurers and admins work the payment fraud floor
([ADR 0036](../decisions/0036-payment-fraud-floor.md)): what each flag means, the four-eyes
procedure, what confirming does and does not do, and how an admin releases a confirmed flag.

The floor exists because channel income can be paid on to other accounts (Ledger Splits): stolen
cards pay a channel, the money is paid out, the chargebacks arrive after it is gone. A flag
**holds the payee's payouts** until two people agree; the database refuses to release a held
payout while a flag holds it, so no code path or hand-written update can pay out early.

## Where flags come from

| Kind                  | Shown as              | Raised by                                         | What it means                                                                                                                                                             |
| --------------------- | --------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payer_velocity`      | Payment burst         | the `money-fraud-scan` job (every 15 minutes)     | One payer made more than 10 successful payments, to any channels, within 60 minutes. Every payee of that burst is flagged. Typical of stolen cards being tested.          |
| `payer_concentration` | Few payers            | the `money-fraud-scan` job                        | Over the last 30 days the payee took at least 500.00, and either the top three payers brought at least 80 % of it, or accounts younger than 7 days brought at least half. |
| `new_payee`           | Large first payout    | the monthly payout run                            | The payee's first payout ever is 500.00 or more.                                                                                                                          |
| `manual`              | Raised by a treasurer | a treasurer, from the treasury's Fraud review tab | Someone has a reason to look closer (a report, a pattern of chargebacks).                                                                                                 |

The thresholds are `PAYMENT_FRAUD_RULES` in `packages/contracts/src/enums.ts`. Refunded and
charged-back payments do not count; anonymous tips still count by the payer's account (anonymity
hides the payer from the channel, not from this review). Evidence shows ids, counts and amounts
only.

A payee has at most one undecided flag of each kind. After a flag is decided, the scan does not
raise the same kind again on the same evidence: only payments made after the decision count, so
clearing a payee is not undone by the next scan.

## What a flag does to payouts

- Raising a flag moves the payee's unpaid payouts (`pending`, `scheduled`, and `held` because the
  payout account was not ready) to **held, "Held for fraud review"** (`fraud_review`). Paid and
  failed payouts are not touched.
- While the flag holds, every new payout run creates the payee's payout held for review, and
  "mark paid" is refused.
- Turning the payee's payout account on does not release fraud holds.

A flag holds while it is **open** or **reviewed**, and when it is **confirmed** until an admin
releases it. A **cleared** flag holds nothing.

## The four-eyes procedure

Everything happens in **Treasury → Fraud review** (the `/treasury` page, treasurers only). Each
flag shows its kind, the payee, the evidence in words, how many payouts it holds and who did what.

1. **Review** (any treasurer except the payee). Read the evidence, check the payee's payments in
   the Payments tab and their revenue history, then record a recommendation: _clear_ (release the
   payouts) or _confirm_ (keep them held). A note is optional; it is visible to treasurers only
   and is never copied into the audit log. Do not paste personal data into it. Reviewing releases
   nothing.
2. **Decide** (a second person: another treasurer, or an admin). The decider cannot be the
   reviewer, whoever raised the flag, or the payee; the Decide button says so, and the database
   refuses it anyway (the API answers `FORBIDDEN` with reason `second_approver`). Choose:
   - **Clear**: when the payee has no other holding flag, their held payouts become `pending`
     again (or wait for the payout account if it is not ready), and the next "mark paid" pays them.
   - **Confirm**: the payouts stay held. Later payout runs keep creating the payee's payouts held.

A held payee waits for you: keep reviews short, and prefer clearing quickly when the evidence has
an innocent explanation (a big community event, a channel's first raid of new viewers).

Every raise, review, decision and release writes an audit row (`money.fraud.raise`,
`money.fraud.review`, `money.fraud.decide`, `money.fraud.release`; details are the flag id, kind
and status only) and an internal `money.fraud.flag` event, in the same transaction.

## What confirming does and does not do

Confirming **does**: keep every unpaid payout of the payee held, including payouts created by later
runs, until an admin releases the flag. The reserved money stays reserved in the ledger.

Confirming **does not**: suspend the account, refund payers, cancel the payouts or notify anyone.
Those are separate decisions:

- To return reserved money to the creator's balance (for example before refunding payers),
  cancel the held payouts through the existing payout cancel path.
- Refunds and chargebacks go through the Payments tab as usual.
- Suspending the account is a moderation action with its own notices and appeals
  ([ADR 0019](../decisions/0019-statement-of-reasons.md)), handled by the trust and safety team.

The backlog of confirmed flags is the Fraud review tab filtered by **Confirmed**.

## Releasing a confirmed flag (admins)

Only an admin who is not the payee can release a confirmed flag, once. Release when the matter is
settled (for example the payee proved the payments were genuine, or the disputed money was
recovered) and the payee should be paid again. W1 has no web control for this; call the API while
signed in as the admin.

1. Find the flag's id: in the Fraud review tab, filter by **Confirmed**; each flag's element
   carries `data-flag-id`. A treasurer can also list them:
   `GET /api/treasurer/fraud-flags?status=confirmed`.
2. Sign in to the web app as the admin, open the browser's developer console on any page of the
   instance and run:

   ```js
   await fetch("/api/treasurer/fraud-flags/<flag id>/release", {
     method: "POST",
     headers: { "content-type": "application/json" },
     body: "{}",
   }).then((r) => r.json());
   ```

   The answer is the flag with `releasedBy` and `releasedAt` set. A `409` means the flag is not
   confirmed or was already released; a `403` means the caller is not an admin, or is the payee.

The release writes a `money.fraud.release` audit row and a `money.fraud.flag` event with
`released: true`. When no other flag holds the payee, their held payouts become `pending` (or wait
for the payout account) in the same transaction; the flag then reads "Released by …" in the tab.

## If something looks wrong

- **A payout stays held after a clear.** Another flag still holds the payee (the tab shows every
  flag on them), or the payout account is not ready (the hold reason then reads that).
- **"Mark paid" says the payout is no longer pending.** The payee was flagged after the payout
  list loaded; reload the treasury.
- **A direct database update to a held payout fails** with `payouts to a payee under fraud review
  stay held`: that is the floor working. Decide or release the flag instead.
