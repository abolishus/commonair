// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Governance settings are read-only to the API (they change only through the
 * proposal flow, enforced by the database). Reads are cached briefly per process.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_GOVERNANCE_SETTINGS, schema, type Database } from "@commonair/db";

export const DiscoveryRanking = z.object({
  spotlightSlots: z.number().int().min(0).max(20),
  spotlightMaxViewers: z.number().int().min(0),
  spotlightRotationMinutes: z.number().positive(),
  newChannelMaxAgeDays: z.number().positive(),
  weights: z.object({
    viewers: z.number().min(0),
    freshness: z.number().min(0),
    followMomentum: z.number().min(0),
    smallChannelBoost: z.number().min(0),
  }),
});
export type DiscoveryRanking = z.infer<typeof DiscoveryRanking>;

const defaultOf = (key: string): unknown => DEFAULT_GOVERNANCE_SETTINGS.find((s) => s.key === key)?.value;

const cache = new Map<string, { at: number; value: unknown; updatedAt: Date | null }>();
const TTL_MS = 30_000;

export async function readSetting(db: Database, key: string, nowMs = Date.now()) {
  const hit = cache.get(key);
  if (hit && nowMs - hit.at < TTL_MS) return hit;
  const [row] = await db
    .select({ value: schema.governanceSettings.value, updatedAt: schema.governanceSettings.updatedAt })
    .from(schema.governanceSettings)
    .where(eq(schema.governanceSettings.key, key))
    .limit(1);
  const entry = { at: nowMs, value: row?.value ?? defaultOf(key), updatedAt: row?.updatedAt ?? null };
  cache.set(key, entry);
  return entry;
}

/** The ranking config; falls back to the seeded default if the stored value is malformed. */
export async function discoveryRanking(db: Database): Promise<{ config: DiscoveryRanking; version: string }> {
  const s = await readSetting(db, "discovery.ranking");
  const parsed = DiscoveryRanking.safeParse(s.value);
  const config = parsed.success ? parsed.data : DiscoveryRanking.parse(defaultOf("discovery.ranking"));
  // The version changes whenever the setting does, so clients can tell rankings apart.
  const version = `discovery-v1@${(s.updatedAt ?? new Date(0)).toISOString()}`;
  return { config, version };
}

export function clearSettingsCache(): void {
  cache.clear();
}
