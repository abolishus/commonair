// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `coop.feeSchedule` (feature-wins §4.1): every decided change to the platform cut and the payout
 * rules, newest first, then the founding value of each key. Public and the same for everyone (no
 * personal data), so it is cached in-process for a minute.
 */
import { and, desc, inArray, isNotNull } from "drizzle-orm";
import type { FeeScheduleEntry } from "@commonair/contracts/dto";
import { FEE_SCHEDULE_KEYS } from "@commonair/contracts/enums";
import { type Database, schema } from "@commonair/db";
import type { z } from "zod";
import { os } from "../lib/orpc.ts";

type Entry = z.infer<typeof FeeScheduleEntry>;
type Key = (typeof FEE_SCHEDULE_KEYS)[number];

export const FEE_SCHEDULE_TTL_MS = 60_000;

const { governanceSettings: settings, governanceSettingsHistory: history } = schema;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isKey = (k: string): k is Key => (FEE_SCHEDULE_KEYS as readonly string[]).includes(k);

/**
 * The schedule from the database. The seed's own insert writes a history row with no old value;
 * that row is the founding seed and is reported as the synthetic entry (`id`/`changedAt` null),
 * matching `PaymentMetaV2.cutHistoryId` null and `PaymentBreakdown.cutSource`.
 */
export async function loadFeeSchedule(db: Database): Promise<Entry[]> {
  const keys = [...FEE_SCHEDULE_KEYS];
  const [changes, current] = await Promise.all([
    db
      .select()
      .from(history)
      .where(and(inArray(history.key, keys), isNotNull(history.oldValue)))
      .orderBy(desc(history.changedAt), desc(history.id)),
    db.select({ key: settings.key, value: settings.value }).from(settings).where(inArray(settings.key, keys)),
  ]);
  const entries: Entry[] = [];
  for (const h of changes) {
    if (!isKey(h.key) || !isRecord(h.newValue)) continue;
    entries.push({
      id: h.id,
      key: h.key,
      value: h.newValue,
      previous: isRecord(h.oldValue) ? h.oldValue : null,
      changedAt: h.changedAt.toISOString(),
      proposalId: h.proposalId,
    });
  }
  const now = new Map(current.map((c) => [c.key, c.value]));
  for (const key of keys) {
    // The oldest decided change's old value is what the co-op was founded with.
    const oldest = changes.findLast((h) => h.key === key);
    const value = oldest ? oldest.oldValue : now.get(key);
    if (!isRecord(value)) continue;
    entries.push({ id: null, key, value, previous: null, changedAt: null, proposalId: null });
  }
  return entries;
}

const cache = new WeakMap<Database, { at: number; entries: Entry[] }>();

/** Drop the cached schedule (tests; a settings change shows within the TTL otherwise). */
export function clearFeeScheduleCache(db: Database): void {
  cache.delete(db);
}

export const feeScheduleHandler = os.coop.feeSchedule.handler(async ({ context }) => {
  const { db } = context.deps;
  const hit = cache.get(db);
  const now = Date.now();
  if (hit && now - hit.at < FEE_SCHEDULE_TTL_MS) return hit.entries;
  const entries = await loadFeeSchedule(db);
  cache.set(db, { at: now, entries });
  return entries;
});
