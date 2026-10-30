// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Typed readers for the money governance settings (seeded in @commonair/db; changed only by
 * passed protected decisions). Callers read them per operation, never cache them across
 * decisions, and pass the values into the pure rules.
 */
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { type Executor, schema } from "@commonair/db";
import { PayoutRulesSetting, PlatformCutSetting } from "@commonair/contracts/shapes";
import type { PlatformCut } from "./rules.ts";

export { PayoutRulesSetting, PlatformCutSetting };
export type PayoutRules = z.infer<typeof PayoutRulesSetting>;

export interface MoneySettings {
  cut: PlatformCut;
  /** `governance_settings_history.id` of the `platform.cut` in effect; null = the founding seed (its history row has old value null). */
  cutHistoryId: string | null;
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
  // The seed's own insert also writes a history row (old value null, no proposal): that row is the
  // founding seed, recorded as null so `cutHistoryId` names a decided change or nothing.
  const [history] = await db
    .select({ id: schema.governanceSettingsHistory.id })
    .from(schema.governanceSettingsHistory)
    .where(
      and(
        eq(schema.governanceSettingsHistory.key, "platform.cut"),
        isNotNull(schema.governanceSettingsHistory.oldValue),
      ),
    )
    .orderBy(desc(schema.governanceSettingsHistory.changedAt), desc(schema.governanceSettingsHistory.id))
    .limit(1);
  return {
    cut: PlatformCutSetting.parse(by.get("platform.cut")),
    cutHistoryId: history?.id ?? null,
    payoutRules: PayoutRulesSetting.parse(by.get("payout.rules")),
  };
}
