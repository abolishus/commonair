// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data for the co-op Settings board (`/coop/settings`). */

export interface SettingFixture {
  key: string;
  description: string;
  value: unknown;
  protected: boolean;
  updatedBy: { proposalId: string; number: number } | null;
  updatedAt: string;
}

export const settings: SettingFixture[] = [
  {
    key: "platform.cut",
    description: "The streamer's share of subscriptions, gifts and tips.",
    value: { streamerShare: 0.9, tipStreamerShare: 0.95 },
    protected: true,
    updatedBy: null,
    updatedAt: "seeded Jan 1, 2026",
  },
  {
    key: "governance.protections",
    description: "What a protected decision needs.",
    value: {
      memberWideThreshold: 0.6667,
      streamerClassThreshold: 0.5,
      quorum: 0.25,
      streamerClassQuorum: 0.33,
      councilReviewSeconds: 604800,
      minVotingSeconds: 1209600,
    },
    protected: true,
    updatedBy: null,
    updatedAt: "seeded Jan 1, 2026",
  },
  {
    key: "discovery.ranking",
    description: "How the home page orders live channels.",
    value: { spotlightSlots: 5, smallChannelBoost: 1.5, reasons: ["followed", "category", "small"] },
    protected: false,
    updatedBy: { proposalId: "0192d6f1-0000-7000-8000-000000000045", number: 45 },
    updatedAt: "Oct 2, 2026",
  },
  {
    key: "patronage.weights",
    description: "How the surplus is shared between members.",
    value: {
      revenue: 0.5,
      streamingHours: 0.2,
      relayBandwidth: 0.1,
      viewerHours: 0.2,
      dailyStreamingHourCap: 12,
      viewerHoursChannelCap: 0.05,
    },
    protected: true,
    updatedBy: { proposalId: "0192d6f1-0000-7000-8000-000000000041", number: 41 },
    updatedAt: "Aug 14, 2026",
  },
];
