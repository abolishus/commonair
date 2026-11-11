<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0042: Paid time and share refunds when an account is deleted

- Status: proposed 2026-11-11 (conservative defaults chosen by the orchestrator for the maintainer;
  recorded for post-launch review)
- Date: 2026-11-11
- Context: design overhaul wave 5, F0 follow-up and ux-journeys J6-a/J6-b
  (`docs/design/2026-11-overhaul/README.md`, `round2/ux-journeys.md`)

## Context

Fix F0 made a completed deletion end every subscription the user pays, and every one others pay on
the user's channel, with no prorated refund for the unused part of the period ("treasurer by hand").
A deletion completes `DELETION_GRACE_DAYS` (30) after it is requested. Subscriptions are monthly.

When the member holds a co-op share that the bylaws make refundable on exit (ADR 0020), the
deletion moves it to `refund_pending` at completion. A bank-transfer share is refunded by a
treasurer by hand, and by then the account has been pseudonymized: nobody can reach the person to
ask where to send the money.

## Decision

1. **No automatic proration.** No money moves by itself when an account is deleted.
2. **Renewal stops when the deletion is requested.** Every subscription the deletion will end (paid
   by the user, or paid by others on the user's channel; gifts never renew) is set to end at its
   period end, at the provider and locally, and marked with the deletion
   (`subscriptions.renewal_stopped_by_deletion_id`). The paid time is used up during the 30-day
   grace, so in nearly every case nothing is left unused at completion.
3. **Cancelling the deletion turns renewal back on** for exactly the subscriptions it turned off
   (the marker), and no others. A subscription whose renewal was turned back on by anyone (the
   member, the provider) loses the marker (trigger, 0060).
4. **What is still paid past the deletion date ends at completion,** as F0 does, with no automatic
   refund. The deletion preview says how many (`DeletionPreview.endingBeforePaidThrough`), and a
   treasurer can still refund by hand.
5. **Share refunds are arranged before completion.** The deletion preview and the scheduled-deletion
   email say how the share comes back. The treasury share list shows a held share whose member has a
   deletion scheduled (`ShareView.deletionScheduledFor`), and `coop.shares.askRefundDetails` has the
   platform email the member to reply to the treasury contact with refund details. The treasurer
   never sees the address; the request is audited by share id.
6. **Deletion never waits on a refund.** Erasure is not held back for money owed. After completion
   the refund stays owed by share id (`refund_pending`); the person can still claim it by quoting
   the share's reference to the treasury contact.

## Consequences

- A member who deletes on day 1 of a period loses nothing: the period runs out during the grace.
- Channel subscribers keep what they paid for and see the subscription end at period end, as if the
  creator had stopped offering it; if the creator cancels the deletion, renewals resume.
- No personal data is kept after completion for refunds; the share id and the amount are enough.

## Revisit when

- A plan longer than the grace period exists (annual subscriptions).
- A jurisdiction the instance serves requires refunds of unused prepaid time on termination by the
  consumer.
