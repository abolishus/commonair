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

## How it runs (w5-deletion)

- **Request** (`me.deletion.request`, `services/api/src/moderation/deletion.ts`): the provider first.
  Each provider-managed subscription concerned that still renews is set to end at period end at the
  provider (idempotency key `deletion-<deletionId>-stop-<subscriptionId>`), before the request
  transaction. If one cannot be stopped (provider down, not configured, another provider, no
  reference), the ones already stopped are turned back on and the request is refused
  (`PRECONDITION_FAILED`, requirement `payment_provider`): nothing is scheduled, so no deletion
  is ever pending while a card can still renew. A subscription the provider no longer has (404)
  counts as stopped. Then, in the request transaction, the local rows: `cancel_at_period_end`,
  the marker and one `subscription.renewal_stop` audit row each (ids and cents). An outbox-driven
  worker job was not chosen: it would schedule the deletion before the provider agreed, leaving a
  window where renewal is on at the provider and off here. No outbox row is written, as for a
  member's own cancel at period end: nothing outside the API reads that flag.
- **`past_due` subscriptions end now**, as a member's own cancel ends them (`money/checkout.ts`):
  their period is already over, and a provider subscription left at period end keeps dunning its
  open invoice, so a retry could still charge the card and start a new paid period. The provider
  is told to end it now (key `deletion-<deletionId>-stop-<subscriptionId>-now`); in the request
  transaction its pending renewal payments fail first (manual ones too, so a late transfer cannot
  revive it), then it ends (`channel.subscription.end`) with a `subscription.renewal_stop` audit
  row (`endedNow: true`). It carries no marker: cancelling the deletion has nothing to restore.
  If the request transaction fails after the provider ended it, the provider's end event ends it
  here too.
- **Cancel** (`me.deletion.cancel`): in the cancel transaction, manual subscriptions with the
  marker renew again; after commit, each provider one is resumed at the provider
  (`resumeSubscription`) and then locally. A provider failure leaves that subscription ending at
  period end on both sides (consistent, nothing charged), drops its marker and is audited
  (`subscription.renewal_resume`, `resumed: false`): a provider outage never keeps an account
  from being kept.
- **Completion**: unchanged from F0 (the worker's `deletion/money.ts`). Anything still active ends
  now, a provider subscription already ending at period end is not called again, and the completed
  email names a share left `refund_pending` by its reference (the bank-transfer reference, else the
  share id).
- **Treasury**: `coop.shares.list` fills `deletionScheduledFor`; the shares tab lists held shares
  of members leaving, soonest first. It reads every page of held shares (100 a request, at most 50
  pages, then it says the list may be incomplete), since a leaving member's share can be on any
  page. A `leaving` filter on `coop.shares.list` would make that one bounded request; it is a
  contract request. `coop.shares.askRefundDetails` (treasurer) accepts a
  `refund_pending` share or a held share whose member has a deletion scheduled, at most once a
  day per share (409), and refuses a member who can no longer be emailed (412). The email
  (`shareRefundDetails`) is sent inside the transaction that records `refund_details_requested_at`
  and the `coop.share.refund_details_requested` audit row (ids and cents), so a failed send records
  nothing. The member is asked to write to the instance's general contact (`CONTACT_EMAIL`): the
  instance has no treasury address of its own. The email asks for no bank or card details.

## Consequences

- A member who deletes on day 1 of a period loses nothing: the period runs out during the grace.
- Channel subscribers keep what they paid for and see the subscription end at period end, as if the
  creator had stopped offering it; if the creator cancels the deletion, renewals resume.
- No personal data is kept after completion for refunds; the share id and the amount are enough.

## Revisit when

- A plan longer than the grace period exists (annual subscriptions).
- A jurisdiction the instance serves requires refunds of unused prepaid time on termination by the
  consumer.
