// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stripe Connect Express payout accounts. A creator's first visit to the payout card creates the
 * Express account (idempotent per creator at Stripe) and records it in `payout_accounts`
 * (`provider: stripe`, disabled). Every visit reads the account's `payouts_enabled` from Stripe
 * and syncs it (so a missed `account.updated` heals), and returns a fresh onboarding link while
 * payouts are not enabled. Actual transfers to Connect accounts are out of scope: payouts for
 * Stripe creators are recorded with `provider: stripe` and marked paid by the treasurer.
 */
import { eq } from "drizzle-orm";
import { schema } from "@commonair/db";
import { createAdapter } from "@commonair/payments";
import type { Deps } from "../deps.ts";
import { precondition } from "../lib/errors.ts";
import { syncStripePayoutAccount } from "./stripe-events.ts";

const { payoutAccounts } = schema;

/** Where Stripe sends the creator back after (or to restart) onboarding. */
export const PAYOUT_RETURN_PATH = "/revenue";

export async function stripePayoutAccount(
  deps: Deps,
  userId: string,
  accountId: string | null,
): Promise<{ payoutsEnabled: boolean; onboardingUrl: string | null }> {
  const adapter = createAdapter(deps.env);
  if (adapter.provider !== "stripe" || !adapter.payoutOnboarding || !adapter.payoutAccountStatus)
    throw precondition("payment_provider", "Payout onboarding is not available on this instance");

  if (accountId !== null) {
    const { payoutsEnabled } = await adapter.payoutAccountStatus(accountId);
    // Same lock order as setPayoutAccount and account.updated: payout batch, then the account.
    await deps.db.transaction((tx) => syncStripePayoutAccount(tx, { accountId, payoutsEnabled }, deps.now()));
    if (payoutsEnabled) return { payoutsEnabled: true, onboardingUrl: null };
  }

  const back = `${deps.env.PUBLIC_URL.replace(/\/+$/, "")}${PAYOUT_RETURN_PATH}`;
  const r = await adapter.payoutOnboarding({ userId, accountId, returnUrl: back, refreshUrl: back });
  if (accountId === null) {
    // A concurrent first visit may have recorded it already (Stripe returned the same account).
    await deps.db
      .insert(payoutAccounts)
      .values({ userId, provider: "stripe", providerAccountId: r.accountId, payoutsEnabled: false })
      .onConflictDoNothing({ target: payoutAccounts.userId });
    const [row] = await deps.db
      .select({ provider: payoutAccounts.provider })
      .from(payoutAccounts)
      .where(eq(payoutAccounts.userId, userId));
    if (row?.provider !== "stripe")
      throw precondition("payout_account", "Your payouts are set up by the co-op treasurer");
  }
  return { payoutsEnabled: false, onboardingUrl: r.url };
}
