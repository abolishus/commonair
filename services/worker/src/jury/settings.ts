// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The jury's governance settings (ADR 0038 §2); a missing or malformed row reads as the default. */
import { JURY_RULES } from "@commonair/contracts/enums";
import { JuryCasesPerPanelSetting, JuryEnabledSetting, JuryPanelSizeSetting } from "@commonair/contracts/shapes";
import { schema, type Executor } from "@commonair/db";
import { inArray } from "drizzle-orm";

export const JURY_SETTING_KEYS = ["jury.enabled", "jury.panelSize", "jury.casesPerPanel"] as const;

export interface JurySettings {
  enabled: boolean;
  panelSize: number;
  casesPerPanel: number;
}

export function parseJurySettings(rows: readonly { key: string; value: unknown }[]): JurySettings {
  const value = (key: string) => rows.find((r) => r.key === key)?.value;
  const enabled = JuryEnabledSetting.safeParse(value("jury.enabled"));
  const size = JuryPanelSizeSetting.safeParse(value("jury.panelSize"));
  const cases = JuryCasesPerPanelSetting.safeParse(value("jury.casesPerPanel"));
  return {
    // Off unless the co-op voted it on: an unreadable value is off.
    enabled: enabled.success ? enabled.data.enabled : false,
    panelSize: size.success ? size.data.panelSize : JURY_RULES.panelSize,
    casesPerPanel: cases.success ? cases.data.casesPerPanel : JURY_RULES.casesPerPanel,
  };
}

export async function readJurySettings(db: Executor): Promise<JurySettings> {
  const rows = await db
    .select({ key: schema.governanceSettings.key, value: schema.governanceSettings.value })
    .from(schema.governanceSettings)
    .where(inArray(schema.governanceSettings.key, [...JURY_SETTING_KEYS]));
  return parseJurySettings(rows);
}
