// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `integrity.thresholds` (governance setting, ordinary decision). Read from the
 * database on every job run so a membership decision takes effect without a deploy.
 *
 * CONTRACT-REQUEST: this shape belongs in `@commonair/contracts/shapes` next to the
 * other governance setting shapes.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema, type Executor } from "@commonair/db";

export const IntegrityThresholds = z.object({
  /** Sessions whose combined score is above this are excluded. */
  sessionExcludeScore: z.number().gt(0).max(1),
  /** Follows per minute on one channel above which low-quality follows are excluded. */
  followBurstPerMinute: z.number().int().positive(),
  /** Allowed relay over-report (reported / issued − 1). */
  relayOverReportTolerance: z.number().min(0).max(10),
  /** Concurrent sessions allowed per device and per account. */
  maxSessionsPerDevice: z.number().int().positive(),
});
export type IntegrityThresholds = z.infer<typeof IntegrityThresholds>;

export const INTEGRITY_THRESHOLDS_KEY = "integrity.thresholds";

export async function loadThresholds(db: Executor): Promise<IntegrityThresholds> {
  const [row] = await db
    .select({ value: schema.governanceSettings.value })
    .from(schema.governanceSettings)
    .where(eq(schema.governanceSettings.key, INTEGRITY_THRESHOLDS_KEY));
  if (!row) throw new Error(`governance setting ${INTEGRITY_THRESHOLDS_KEY} is missing`);
  return IntegrityThresholds.parse(row.value);
}

export const MEMBERSHIP_CLASSES_KEY = "membership.classes";
/** Default when the protected setting does not carry the field yet (as in `@commonair/governance`). */
export const DEFAULT_MIN_VERIFIED_VIEWERS = 2;

/** The part of `membership.classes` (protected) stream-hour eligibility reads. */
const StreamerEligibility = z.object({
  streamer: z.object({
    minVerifiedViewers: z.number().int().min(1).default(DEFAULT_MIN_VERIFIED_VIEWERS),
  }),
});

/** `membership.classes.streamer.minVerifiedViewers`: distinct verified viewers an hour needs to count. */
export async function loadMinVerifiedViewers(db: Executor): Promise<number> {
  const [row] = await db
    .select({ value: schema.governanceSettings.value })
    .from(schema.governanceSettings)
    .where(eq(schema.governanceSettings.key, MEMBERSHIP_CLASSES_KEY));
  if (!row) throw new Error(`governance setting ${MEMBERSHIP_CLASSES_KEY} is missing`);
  return StreamerEligibility.parse(row.value).streamer.minVerifiedViewers;
}
