// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `moderation.thresholds` governance setting, read per job so a passed proposal applies at
 * the next frame. The database range-checks it; if it is somehow missing or invalid the defaults
 * apply and an alert fires (fail closed: never "off").
 */
import { schema, type Executor } from "@commonair/db";
import { effectiveSampleSeconds, parseThresholds, type Thresholds } from "@commonair/moderation";
import { eq } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { alert } from "./records.ts";

export const THRESHOLDS_KEY = "moderation.thresholds";

export async function loadThresholds(ctx: Pick<WorkerContext, "logger">, db: Executor): Promise<Thresholds> {
  const [row] = await db
    .select({ value: schema.governanceSettings.value })
    .from(schema.governanceSettings)
    .where(eq(schema.governanceSettings.key, THRESHOLDS_KEY));
  const { thresholds, valid } = parseThresholds(row?.value);
  if (!valid)
    alert(ctx, "moderation_thresholds_invalid", "moderation.thresholds is missing or invalid; using the defaults", {
      present: row !== undefined,
    });
  return thresholds;
}

/** The effective sample interval (seconds) for hashing removed content. */
export async function sampleSeconds(ctx: Pick<WorkerContext, "logger">, db: Executor, envSeconds: number) {
  return effectiveSampleSeconds(envSeconds, await loadThresholds(ctx, db));
}
