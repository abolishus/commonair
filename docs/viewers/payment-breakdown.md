<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Where your payment goes

Every subscription, gift and tip on CommonAir has a **breakdown**: where each cent of it went,
read straight from the co-op's ledger. Viewers open it from **Your payments** on
`/settings/subscriptions`; creators open it from any payment row of their revenue ledger on
`/revenue`. Only the person who paid and the owner of the channel that was paid can see a
breakdown. Channel moderators, editors and other members cannot, and a payment you are not part of
looks the same as one that does not exist.

## The lines

The first group of lines adds up to exactly what was paid (the **gross**):

| Line              | What it means                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tax**           | Sales tax or VAT collected for the tax authority. Shown only when tax was charged.                                                                                    |
| **Creator share** | What goes to the creator: the payment after tax, times the creator's part of the platform cut. One line per person who shares in it.                                  |
| **Co-op share**   | The rest after tax: the co-op's part of the platform cut. The creator share is rounded down to the cent and the co-op gets what is left, so the lines add up exactly. |

The co-op pays its costs out of its share. These lines are **outside** the gross. You never pay them on
top, and the creator never pays them:

| Line                                | What it means                                                                                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Card processing fee**             | What the payment processor (for example Stripe) charged the co-op to move your money. Zero for offline payments the treasurer confirms by hand.    |
| **Dispute fee**                     | What a card network charged the co-op when a payment was charged back.                                                                             |
| **Dispute fee returned**            | A negative dispute fee: the processor gave the fee back because the co-op won the dispute.                                                         |
| **Reversed** / **restored** lines   | A refund or a chargeback takes back part of the tax, the creator share and the co-op share (negative lines). A won chargeback restores them again. |
| **What the co-op kept** (co-op net) | The co-op share, minus what refunds and chargebacks took back, minus the processing and dispute fees, plus any fees returned.                      |

Each reversal's lines add up to exactly the amount refunded or charged back.

## Why the co-op can lose money on a payment

The co-op's share is a percentage, but card fees have a fixed part. On a small tip the fixed part
can be bigger than the co-op's share: on a 2.00 tip at a 10 % cut, the co-op's share is 0.20, and a
typical card fee of 2.9 % + 30 ¢ is 0.36, so the co-op loses 0.16 on that tip. The breakdown says so
in words ("The co-op lost …"), not only with a colour. The creator's share is the same either way:
fees never come out of it.

## The hold

A creator's share is held for a few days after a payment (the `payout.rules` hold period decided by
the members), so a refund or chargeback can come out of the payment it belongs to instead of a
later payout. The breakdown shows the date the hold ends, or the date the share was released.

## Which cut applied

The split uses the platform cut in force when the payment was made, not today's. The breakdown names
it, says whether it is the cut the co-op was founded with or a later member decision (with its
date), and links to the **fee schedule** on `/transparency`. The fee schedule lists every change to
the platform cut and to the payout rules, newest first, with the founding values at the end.

## What "estimate" means in the Support dialog

Before you pay, the Support dialog shows an **estimated split** for the amount you chose: the
creator's and the co-op's share, and a range for the card fee. The fee is a range because it depends
on your card and your country, which the co-op only learns when the payment goes through (for
Stripe the range runs from about 1.5 % + 30 ¢ for a domestic card to about 3.9 % + 30 ¢ for an
international one). When the co-op takes payments offline there is no card fee, and the estimate is
not shown. The real numbers are in the payment's breakdown once it has gone through.

## How we check it

Every night the co-op recomputes each recently changed payment's breakdown and compares it with the
money that actually moved through the processor's account in the ledger. Any difference is counted
and investigated by the treasurer; it is never silently corrected.
