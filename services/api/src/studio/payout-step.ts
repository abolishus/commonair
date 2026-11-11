// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The checklist's "Get paid" step (overhaul wave 4, D6.4; ux-journeys J2-h). It applies once the
 * channel has gone live, and only on an instance that pays creators out. It is done when the
 * owner's payout account can receive payouts (`payout_accounts.payouts_enabled`: the treasurer
 * switches it on for the manual adapter, and Stripe's `payouts_enabled` is synced into it by
 * `money.payoutAccount` and the `account.updated` webhook), or when the owner marked it ("I've
 * contacted the treasurer", a `channel_setup_steps` row). It never blocks `complete`.
 */

/**
 * Whether this instance pays creators out. Both payment adapters do (manual through the treasurer,
 * Stripe through Connect), which is why `instance.info` reports `features.payouts: true`; the two
 * read the same answer so the checklist never offers a step the instance cannot finish.
 */
export function payoutsAvailable(): boolean {
  return true;
}

export interface PayoutStepFacts {
  /** A live broadcast exists (the step waits for the first stream). */
  live: boolean;
  /** The owner's payout account has payouts enabled. */
  payoutReady: boolean;
  /** The owner marked the step. */
  payoutMarked: boolean;
}

/** The step's `done`: null when it does not apply, else ready or marked. */
export function getPaidDone(facts: PayoutStepFacts, available: boolean): boolean | null {
  if (!available || !facts.live) return null;
  return facts.payoutReady || facts.payoutMarked;
}
