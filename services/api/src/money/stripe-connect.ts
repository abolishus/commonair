// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stripe Connect Express payout accounts. A creator's first visit to the payout card creates the
 * Express account (idempotent per creator at Stripe) and records it in `payout_accounts`
 * (`provider: stripe`, disabled); every visit returns a fresh onboarding link. Stripe's
 * `account.updated` event (stripe-events.ts) enables payouts. Actual transfers to Connect accounts
 * are out of scope: payouts for Stripe creators are recorded with `provider: stripe` and marked
 * paid by the treasurer.
 */
import { eq } from "drizzle-orm";
import { schema } from "@commonair/db";
import { createAdapter } from "@commonair/payments";
import type { Deps } from "../deps.ts";
import { precondition } from "../lib/errors.ts";

const { payoutAccounts } = schema;

/** Where Stripe sends the creator back after (or to restart) onboarding. */
export const PAYOUT_RETURN_PATH = "/revenue";

export async function stripeOnboarding(deps: Deps, userId: string, accountId: string | null): Promise<string> {
  const adapter = createAdapter(deps.env);
  if (adapter.provider !== "stripe" || !adapter.payoutOnboarding)
    throw precondition("payment_provider", "Payout onboarding is not available on this instance");
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
  return r.url;
}
