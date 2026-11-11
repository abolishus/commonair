// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * d5-money (creator-studio CS-9): the payout card's one state. It used to show "Payouts enabled"
 * beside "has not set up payouts"; now the account resolves to exactly one state, and each state
 * has one status, one explanation and at most one action.
 */
import type { StatusTone } from "@commonair/ui";
import type { MessageKey } from "../../i18n/keys/index.gen.ts";
import type { PayoutAccountDto } from "../../lib/money.ts";
import { safeHttpUrl } from "../../lib/url.ts";

export type PayoutState = "ready" | "connect" | "manual" | "waiting";

export interface PayoutView {
  state: PayoutState;
  status: MessageKey;
  tone: StatusTone;
  /** The onboarding link, only in `connect` (the card's one action). */
  onboardingUrl: string | null;
  /** The treasurer's arrangement, shown as written, only in `manual`. */
  instructions: string | null;
}

export function payoutView(account: PayoutAccountDto): PayoutView {
  const base = { onboardingUrl: null, instructions: null };
  if (account.payoutsEnabled)
    return { ...base, state: "ready", status: "d5Money.payout.status.ready", tone: "success" };
  const onboarding = safeHttpUrl(account.onboardingUrl);
  if (onboarding)
    return {
      ...base,
      state: "connect",
      status: "d5Money.payout.status.action",
      tone: "warning",
      onboardingUrl: onboarding,
    };
  const instructions = account.instructions?.trim() ?? "";
  if (instructions)
    return { ...base, state: "manual", status: "d5Money.payout.status.waiting", tone: "neutral", instructions };
  return { ...base, state: "waiting", status: "d5Money.payout.status.waiting", tone: "neutral" };
}

/** Both earning steps done: tiers saved and payouts on. Unknown (still loading) counts as done. */
export function setupComplete(tiers: readonly unknown[] | null, account: PayoutAccountDto | null): boolean {
  const tiersDone = tiers === null || tiers.length > 0;
  const payoutsDone = account === null || account.payoutsEnabled;
  return tiersDone && payoutsDone;
}
