// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shapes of the governance settings this package reads (keys seeded by
 * `packages/db/src/seed.ts`). The database stores them as jsonb; every reader
 * parses them here first so a malformed value fails loudly instead of silently
 * weakening a rule.
 *
 * CONTRACT-REQUEST: these schemas describe seeded settings and would be better
 * placed in `@commonair/contracts/shapes` so the API and web app share them.
 */
import { z } from "zod";
import { schema, type Executor } from "@commonair/db";

/** Upper bound the database enforces on every governance period (90 days, migration 0002). */
export const MAX_PERIOD_SECONDS = 7_776_000;

/** Mirrors `commonair_validate_protections` (migration 0002). */
export const Protections = z.object({
  protectedKeys: z
    .array(z.string())
    .refine((keys) => keys.includes("governance.protections"), "protectedKeys must include governance.protections"),
  memberWideThreshold: z.number().min(0.5).max(1),
  streamerClassThreshold: z.number().min(0.5).lt(1),
  quorum: z.number().min(0).max(0.5),
  streamerClassQuorum: z.number().min(0).max(0.5),
  councilReviewSeconds: z.number().min(0).max(MAX_PERIOD_SECONDS),
  minVotingSeconds: z.number().min(0).max(MAX_PERIOD_SECONDS),
});
export type Protections = z.infer<typeof Protections>;

/** Mirrors `commonair_validate_ordinary` (migration 0002). */
export const OrdinaryRules = z
  .object({
    threshold: z.number().min(0.5).lt(1),
    quorum: z.number().min(0).max(0.5),
    discussionSeconds: z.number().min(0).max(MAX_PERIOD_SECONDS),
    minVotingSeconds: z.number().min(0).max(MAX_PERIOD_SECONDS),
    votingSeconds: z.number().min(0).max(MAX_PERIOD_SECONDS),
  })
  .refine((o) => o.votingSeconds >= o.minVotingSeconds, "votingSeconds must be at least minVotingSeconds");
export type OrdinaryRules = z.infer<typeof OrdinaryRules>;

export const CouncilConfig = z.object({
  size: z.number().int().min(1).max(100),
  eligibilityWindowDays: z.number().int().min(1).max(3660),
  minStreamingHours: z.number().min(0),
  recomputeCron: z.string().optional(),
});
export type CouncilConfig = z.infer<typeof CouncilConfig>;

/**
 * `membership.classes` (protected). Fields marked "defaulted" are not in the seed yet and
 * are read with their default here. CONTRACT-REQUEST: add `streamer.minVerifiedViewers: 2`,
 * `streamer.lapseGraceDays: 14` and `viewer.minSubscriptionCents: 300` to the seed
 * (`packages/db/src/seed.ts`) so they become part of the protected value.
 */
export const MembershipClasses = z.object({
  streamer: z.object({
    minStreamingHours: z.number().min(0),
    windowDays: z.number().int().min(1),
    /** Distinct verified viewers other than the streamer an hour needs to count (defaulted). */
    minVerifiedViewers: z.number().int().min(1).default(2),
    /** Extra days past the window before an active streamer is lapsed (defaulted). */
    lapseGraceDays: z.number().int().min(0).max(365).default(14),
  }),
  viewer: z.object({
    shareCents: z.number().int().min(0),
    shareRefundableOnExit: z.boolean(),
    activeSubscriptionQualifies: z.boolean(),
    /** Cheapest subscription that qualifies for viewer membership (defaulted). */
    minSubscriptionCents: z.number().int().min(0).default(300),
  }),
  worker: z.object({ appointedBy: z.literal("board") }),
});
export type MembershipClasses = z.infer<typeof MembershipClasses>;

export const BoardSeats = z.object({
  streamer: z.number().int().min(0),
  viewer: z.number().int().min(0),
  worker: z.number().int().min(0),
  termMonths: z.number().int().min(1),
});
export type BoardSeats = z.infer<typeof BoardSeats>;

/** The parts of `patronage.formula` the council score blends (same weights as patronage). */
export const ContributionWeights = z.object({
  revenue: z.number().min(0).max(1),
  streamingHours: z.number().min(0).max(1),
  relayBandwidth: z.number().min(0).max(1),
  viewerHours: z.number().min(0).max(1),
  dailyStreamingHourCap: z.number().positive(),
});
export type ContributionWeights = z.infer<typeof ContributionWeights>;
export const PatronageFormula = z.object({ version: z.string(), weights: ContributionWeights.loose() });

/** Every governance setting by key, as stored. */
export type SettingsMap = Readonly<Record<string, unknown>>;

export class SettingError extends Error {
  constructor(
    public readonly key: string,
    message: string,
  ) {
    super(`governance setting ${key}: ${message}`);
    this.name = "SettingError";
  }
}

/** Parse one setting with its schema, naming the key in the error. */
export function readSetting<S extends z.ZodType>(settings: SettingsMap, key: string, shape: S): z.output<S> {
  if (!(key in settings)) throw new SettingError(key, "missing");
  const parsed = shape.safeParse(settings[key]);
  if (!parsed.success) throw new SettingError(key, z.prettifyError(parsed.error));
  return parsed.data;
}

export const protectionsOf = (s: SettingsMap) => readSetting(s, "governance.protections", Protections);
export const ordinaryOf = (s: SettingsMap) => readSetting(s, "governance.ordinary", OrdinaryRules);
export const councilConfigOf = (s: SettingsMap) => readSetting(s, "council.config", CouncilConfig);
export const membershipClassesOf = (s: SettingsMap) => readSetting(s, "membership.classes", MembershipClasses);
export const boardSeatsOf = (s: SettingsMap) => readSetting(s, "board.seats", BoardSeats);
export const contributionWeightsOf = (s: SettingsMap) => readSetting(s, "patronage.formula", PatronageFormula).weights;

/** Load every governance setting from the database. */
export async function loadSettings(db: Executor): Promise<SettingsMap> {
  const rows = await db
    .select({ key: schema.governanceSettings.key, value: schema.governanceSettings.value })
    .from(schema.governanceSettings);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
