// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Executor } from "./client.ts";
import { legalSeedDocuments } from "./legal/index.ts";
import { governanceSettings } from "./schema/coop.ts";
import { legalDocuments } from "./schema/safety.ts";

/**
 * Default governance settings. Protected settings can only change through a
 * passed protected-decision proposal once inserted (enforced by trigger); this
 * seed only inserts keys that do not exist yet, so it never overwrites a
 * decision the membership made.
 */
export const DEFAULT_GOVERNANCE_SETTINGS = [
  {
    key: "governance.protections",
    protected: true,
    description:
      "Rules for protected decisions: member-wide supermajority AND a streamer-class majority, plus creator-council review.",
    value: {
      protectedKeys: [
        "platform.cut",
        "patronage.formula",
        "payout.rules",
        "membership.classes",
        "governance.protections",
      ],
      memberWideThreshold: 2 / 3,
      streamerClassThreshold: 0.5,
      quorum: 0.2,
      streamerClassQuorum: 0.2,
      councilReviewSeconds: 7 * 86_400,
      minVotingSeconds: 7 * 86_400,
    },
  },
  {
    key: "platform.cut",
    protected: true,
    description: "Share of subscription and tip revenue paid to the streamer vs retained by the co-op.",
    value: { streamerShare: 0.9, coopShare: 0.1 },
  },
  {
    key: "patronage.formula",
    protected: true,
    description: "Versioned patronage formula and component weights.",
    value: {
      version: "2026.1",
      weights: {
        revenue: 0.5,
        streamingHours: 0.2,
        relayBandwidth: 0.2,
        viewerHours: 0.1,
        dailyStreamingHourCap: 8,
        viewerHoursChannelCap: 0.1,
      },
    },
  },
  {
    key: "payout.rules",
    protected: true,
    description: "Minimum payout, schedule, and chargeback hold period.",
    value: { minimumCents: 2500, schedule: "monthly", holdDays: 7, currency: "usd" },
  },
  {
    key: "membership.classes",
    protected: true,
    description: "Membership classes and their eligibility rules.",
    value: {
      streamer: { minStreamingHours: 10, windowDays: 90, minVerifiedViewers: 2, lapseGraceDays: 14 },
      viewer: {
        shareCents: 500,
        shareRefundableOnExit: true,
        activeSubscriptionQualifies: true,
        minSubscriptionCents: 300,
      },
      worker: { appointedBy: "board" },
    },
  },
  {
    key: "governance.ordinary",
    protected: false,
    description: "Thresholds and periods for ordinary decisions.",
    value: {
      threshold: 0.5,
      quorum: 0.1,
      discussionSeconds: 14 * 86_400,
      minVotingSeconds: 3 * 86_400,
      votingSeconds: 7 * 86_400,
    },
  },
  {
    key: "board.seats",
    protected: false,
    description: "Board seats elected by each class, and term length.",
    value: { streamer: 3, viewer: 3, worker: 1, termMonths: 24 },
  },
  {
    key: "council.config",
    protected: false,
    description: "Creator council size, eligibility window, and recompute schedule.",
    value: {
      size: 7,
      eligibilityWindowDays: 90,
      minStreamingHours: 10,
      recomputeCron: "0 3 1 * *",
    },
  },
  {
    key: "discovery.ranking",
    protected: false,
    description: "Directory ranking: spotlight slots for small channels and the blend of signals.",
    value: {
      spotlightSlots: 4,
      spotlightMaxViewers: 10,
      spotlightRotationMinutes: 10,
      newChannelMaxAgeDays: 30,
      weights: { viewers: 0.4, freshness: 0.2, followMomentum: 0.2, smallChannelBoost: 0.2 },
    },
  },
  {
    key: "integrity.thresholds",
    protected: false,
    description: "Scores above which sessions, follows and relays are excluded or suspended.",
    value: {
      sessionExcludeScore: 0.7,
      followBurstPerMinute: 30,
      relayOverReportTolerance: 0.1,
      maxSessionsPerDevice: 3,
    },
  },
  {
    key: "moderation.thresholds",
    protected: false,
    description:
      "Automated moderation (ADR 0006): T1 (blur and queue) and T2 (mature label) classifier thresholds and the frame sample interval. Range-checked by the database so no decision can switch a tier off.",
    value: {
      t1: { sexual: 0.97, graphic_violence: 0.9, weapons: 0.95, self_harm: 0.9 },
      t2: { sexual: 0.8 },
      sampleSeconds: 10,
    },
  },
] as const;

export type GovernanceOverrides = Record<string, Record<string, unknown>>;

/**
 * Insert defaults for missing keys (governance.protections first: the trigger derives every
 * other key's protected flag from it). `overrides` are shallow-merged into the defaults and
 * apply only on first insert: they let an operator (or the harness) choose bootstrap values,
 * e.g. short review periods for a test instance, before any member exists.
 */
export async function seedGovernanceSettings(db: Executor, overrides: GovernanceOverrides = {}): Promise<void> {
  for (const s of DEFAULT_GOVERNANCE_SETTINGS) {
    const value = { ...(s.value as Record<string, unknown>), ...overrides[s.key] };
    await db
      .insert(governanceSettings)
      .values({ key: s.key, value, protected: s.protected, description: s.description })
      .onConflictDoNothing({ target: governanceSettings.key });
  }
}

/**
 * Insert the shipped legal drafts that do not exist yet, by `(kind, version)`. Never updates
 * an existing row: users accepted that exact text. Returns the number of rows inserted.
 */
export async function seedLegalDocuments(db: Executor): Promise<number> {
  let inserted = 0;
  for (const d of legalSeedDocuments()) {
    const rows = await db
      .insert(legalDocuments)
      .values(d)
      .onConflictDoNothing({ target: [legalDocuments.kind, legalDocuments.version] })
      .returning({ id: legalDocuments.id });
    inserted += rows.length;
  }
  return inserted;
}
