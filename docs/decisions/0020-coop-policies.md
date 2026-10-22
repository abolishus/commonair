<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0020: Co-op operating policies for E5

- Status: accepted (2026-10-21; the four questions below were answered by the maintainer)
- Date: 2026-10-21

## Context

Slice E5 wires memberships, proposals, the creator council and patronage to the API, the worker
and the web ([docs/testing/e5-selectors.md](../testing/e5-selectors.md)). The member-facing rules
(thresholds, quorum, periods, protected keys) are already decided and live in governance settings
([decision-process.md](../governance/decision-process.md), ADR 0004). What was still open were
operating policies the settings do not answer: how a share comes back, who approves a patronage
run, who speaks for the council, and how a test instance gets short governance periods when the
database clock cannot be moved.

## Decisions

1. **Share refunds are paid at once.** Exiting the viewer class ends the membership immediately.
   When `membership.classes.viewer.shareRefundableOnExit` is true (the default), the share moves to
   `refund_pending` in the same transaction and appears on the treasury's refund list; a treasurer
   records the refund when the money is sent, which posts `shareRefund` (member-share liability →
   cash) and marks it `refunded`. No notice period and no board approval. The share price is the
   protected `membership.classes.viewer.shareCents` (default 500), in the instance currency
   (`payout.rules.currency`).
2. **Patronage needs two people.** A treasurer runs the computation (`computed_by_id`); a
   different treasurer or an admin approves it, which posts the allocation. The same person can
   never do both: the API refuses it, and a trigger (`0021_coop_protections.sql`) refuses an
   approval whose approver equals the computer or holds neither role.
3. **Any seated council member publishes the council's response**, once per proposal, on the
   council's behalf. Only members of the current term can publish (trigger-enforced). The council
   is seated by the existing contribution formula (`seatCouncil`); it is not elected.
4. **Test instances get short periods at first migration only.** Periods are enforced with the
   database clock (ADR 0004) and protected settings change only by a passed vote, so the local
   stack's Postgres volume is recreated once with `GOVERNANCE_BOOTSTRAP_JSON` (seconds-long
   periods, quorum 0.01, a 36-second streamer threshold) for the `e5-coop` scenario. There is no
   clock override and no test path around the triggers.

Decided by the head agent within these answers (recorded so reviewers can check them):

- **Shares use the manual adapter only in E5.** With `PAYMENTS_PROVIDER=stripe`, `coop.buyShare`
  answers `PRECONDITION_FAILED` (`manual_shares`). A Stripe share needs a product, webhook handling
  and an automatic refund; that is follow-up work.
- **Patronage periods are chosen by the treasurer.** A run closes the ledger for exactly its
  period (`closePeriod`, which refuses overlaps), so there is no separate monthly ledger close in
  E5. Allocations stay in `patronage-payable` until a later slice pays them out.
- **The council is re-seated** when there is no current term, at the start of each UTC month, and
  when a seat falls vacant (the member is no longer an active streamer member), and when the term
  has fewer seats than `council.config.size` while an active streamer member is unseated. Terms are
  append-only; the current term is the latest one whose window contains now.
- **A voluntary exit is respected by the membership sync.** The job does not re-activate a
  streamer who exited within `streamer.windowDays`, and never re-activates a viewer who exited: a
  viewer rejoins by buying a new share. Known limitation: a viewer who qualified only by
  subscription has no rejoin path after exiting until an explicit join exists (follow-up).
- **Drafts are private.** Creating, editing or withdrawing a draft writes audit rows but no public
  `coop.proposal.update` event; the public record starts at submit.
- **Proposals advance automatically.** A worker job moves proposals through discussion, council
  review, voting, the decision and the application of passed changes. Every step is one
  transaction with its audit row and event; the triggers re-check each one.
- **Secret ballot.** Choices never leave `votes`/`vote_history` except as the voter's own
  `myVote`; open votes publish participation only, never a running tally.

## Consequences

- The local stack loses its data once; `e4b-money` and `trust-safety` are re-run on the new
  database.
- New triggers protect tallies (they must equal the SQL tally), council terms, seats and responses
  (append-only), share transitions, and patronage periods, inputs and allocations (frozen once
  approved; two-person approval). The app role loses UPDATE/DELETE on the append-only ones.
- Follow-ups: Stripe shares; an explicit viewer join; paying out patronage payables; council election as an alternative
  seating method (would be a governance setting); board-election UI beyond read-only.
