// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq } from "drizzle-orm";
import { AlertTemplate } from "@commonair/contracts/shapes";
import { schema, type Database } from "@commonair/db";
import { withDefaults, type AlertConfig } from "./alerts.ts";

const { alertConfigs } = schema;

/** A channel's alert configs, one per type, defaults for unset types. */
export async function loadAlertConfigs(db: Database, channelId: string): Promise<AlertConfig[]> {
  const rows = await db.select().from(alertConfigs).where(eq(alertConfigs.channelId, channelId));
  const stored: AlertConfig[] = [];
  for (const r of rows) {
    // A row written by an older version may not match today's template schema: fall back to the default.
    const template = AlertTemplate.safeParse(r.template);
    if (!template.success) continue;
    stored.push({
      type: r.type,
      enabled: r.enabled,
      template: template.data,
      minAmountCents: Number(r.minAmountCents),
      durationMs: Math.min(30_000, Math.max(1000, r.durationMs)),
    });
  }
  return withDefaults(stored);
}
