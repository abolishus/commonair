// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The "Get paid" step's one line (overhaul wave 4, J2-h): the payout minimum and schedule, read
 * from the `payout.rules` governance setting, never a literal. Null when the setting is missing or
 * not the shape we know, so the step falls back to its plain hint instead of guessing a number.
 */
import { formatMoney } from "@commonair/ui";
import { z } from "zod";
import { type MessageKey, t } from "../../i18n/index.ts";
import type { SettingLike } from "../creators/facts.ts";

export interface PayoutRules {
  minimumCents: number;
  schedule: "monthly";
  currency: string;
}

const Rules = z.object({
  minimumCents: z.number().int().min(0),
  schedule: z.enum(["monthly"]),
  currency: z.string().length(3),
});

export function payoutRules(settings: readonly SettingLike[] | null): PayoutRules | null {
  const parsed = Rules.safeParse(settings?.find((s) => s.key === "payout.rules")?.value);
  return parsed.success ? parsed.data : null;
}

/** One key per schedule, so a new schedule is a type error here, not a missing sentence. */
const RULE_KEYS: Readonly<Record<PayoutRules["schedule"], { minimum: MessageKey; none: MessageKey }>> = {
  monthly: { minimum: "d6Studio.getPaid.rule.monthly", none: "d6Studio.getPaid.rule.monthlyNoMinimum" },
};

/** "Payouts go out monthly once you've earned $25.00 or more." */
export function payoutRuleLine(rules: PayoutRules, locale: string): string {
  const keys = RULE_KEYS[rules.schedule];
  if (rules.minimumCents === 0) return t(keys.none);
  return t(keys.minimum, { minimum: formatMoney(rules.minimumCents, rules.currency, locale) });
}
