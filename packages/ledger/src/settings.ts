// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Typed readers for the money governance settings (seeded in @commonair/db; changed only by
 * passed protected decisions). Callers read them per operation, never cache them across
 * decisions, and pass the values into the pure rules.
 */
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { type Executor, schema } from "@commonair/db";
import type { PlatformCut } from "./rules.ts";

// CONTRACT-REQUEST: these shapes belong in @commonair/contracts/shapes next to PatronageWeights.
export const PlatformCutSetting = z
  .object({ streamerShare: z.number().min(0).max(1), coopShare: z.number().min(0).max(1) })
  .refine((c) => Math.abs(c.streamerShare + c.coopShare - 1) < 1e-9, { message: "cut shares must sum to 1" });

export const PayoutRulesSetting = z.object({
  minimumCents: z.number().int().nonnegative(),
  schedule: z.string(),
  holdDays: z.number().nonnegative(),
  currency: z.string().regex(/^[a-z]{3}$/),
});
export type PayoutRules = z.infer<typeof PayoutRulesSetting>;

export interface MoneySettings {
  cut: PlatformCut;
  payoutRules: PayoutRules;
}

export async function loadMoneySettings(db: Executor): Promise<MoneySettings> {
  const rows = await db
    .select({ key: schema.governanceSettings.key, value: schema.governanceSettings.value })
    .from(schema.governanceSettings)
    .where(inArray(schema.governanceSettings.key, ["platform.cut", "payout.rules"]));
  const by = new Map(rows.map((r) => [r.key, r.value]));
  if (!by.has("platform.cut") || !by.has("payout.rules")) {
    throw new Error("governance settings platform.cut and payout.rules must be seeded");
  }
  return {
    cut: PlatformCutSetting.parse(by.get("platform.cut")),
    payoutRules: PayoutRulesSetting.parse(by.get("payout.rules")),
  };
}
