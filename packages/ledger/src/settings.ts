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
import { PayoutRulesSetting, PlatformCutSetting } from "@commonair/contracts/shapes";
import type { PlatformCut } from "./rules.ts";

export { PayoutRulesSetting, PlatformCutSetting };
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
