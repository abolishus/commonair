// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shapes of structured (jsonb) values shared by the database, the API and clients.
 * The database stores them as-is; every write path parses with these schemas first.
 */
import { z } from "zod";
import { MEMBER_CLASSES } from "./enums.ts";

/** Channel accents are named design tokens, never arbitrary colors, so contrast stays AA. */
export const ACCENTS = [
  "zinc",
  "red",
  "orange",
  "amber",
  "lime",
  "green",
  "teal",
  "sky",
  "blue",
  "indigo",
  "violet",
  "pink",
] as const;
export const ChannelTheme = z.object({
  accent: z.enum(ACCENTS).optional(),
  bannerKey: z.string().max(512).optional(),
  avatarKey: z.string().max(512).optional(),
});
export type ChannelTheme = z.infer<typeof ChannelTheme>;

export const ChannelChatSettings = z.object({
  /** Seconds between messages per user; 0 = off. */
  slowModeSeconds: z.number().int().min(0).max(600).default(0),
  /** Minimum minutes followed before chatting; null = off. */
  followersOnlyMinutes: z.number().int().min(0).max(129_600).nullable().default(null),
  subscribersOnly: z.boolean().default(false),
  emoteOnly: z.boolean().default(false),
  /** Account-age gate (days since signup); 0 = off. */
  minAccountAgeDays: z.number().int().min(0).max(365).default(0),
  requireVerifiedEmail: z.boolean().default(true),
  linksAllowed: z.boolean().default(true),
});
export type ChannelChatSettings = z.infer<typeof ChannelChatSettings>;

export const EmoteRange = z.object({
  emoteId: z.string(),
  code: z.string(),
  /** UTF-16 code-unit offsets into the message body, end exclusive. */
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
});
export type EmoteRange = z.infer<typeof EmoteRange>;

export const ReceiptEntry = z.object({
  /** The playback session (= viewer token) id the bytes were served to. */
  sessionId: z.uuid(),
  segments: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export const ReceiptPayload = z.object({
  v: z.literal(1),
  relayId: z.uuid(),
  nonce: z.string().min(16).max(64),
  periodStart: z.iso.datetime(),
  periodEnd: z.iso.datetime(),
  entries: z.array(ReceiptEntry).max(50_000),
});
export type ReceiptPayload = z.infer<typeof ReceiptPayload>;

export const GovernanceChange = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_.]{0,99}$/),
  value: z.unknown().refine((v) => JSON.stringify(v ?? null).length <= 10_000, "change value too large"),
});
export type GovernanceChange = z.infer<typeof GovernanceChange>;

export const GovernanceRuleSnapshot = z.object({
  ruleVersion: z.string(),
  protected: z.boolean(),
  /** Fraction of votes cast (yes / (yes + no)) needed member-wide. */
  memberWideThreshold: z.number().min(0.5).max(1),
  /** Fraction that must be exceeded within the streamer class (0.5 = strict majority). Used only when protected. */
  streamerClassThreshold: z.number().min(0.5).lt(1),
  /** Minimum turnout as a fraction of the electorate. */
  quorum: z.number().min(0).max(1),
  /** Minimum turnout within the streamer class. Used only when protected. */
  streamerClassQuorum: z.number().min(0).max(1),
  councilReviewRequired: z.boolean(),
});
export type GovernanceRuleSnapshot = z.infer<typeof GovernanceRuleSnapshot>;

export const TallyCount = z.object({
  eligible: z.number().int().nonnegative(),
  yes: z.number().int().nonnegative(),
  no: z.number().int().nonnegative(),
  abstain: z.number().int().nonnegative(),
});
export type TallyCount = z.infer<typeof TallyCount>;
export const TallyBreakdown = z.object({
  memberWide: TallyCount,
  byClass: z.record(z.enum(MEMBER_CLASSES), TallyCount),
  checks: z.array(z.object({ rule: z.string(), passed: z.boolean(), detail: z.string() })),
});
export type TallyBreakdown = z.infer<typeof TallyBreakdown>;

export const PatronageWeights = z
  .object({
    revenue: z.number().min(0).max(1),
    streamingHours: z.number().min(0).max(1),
    relayBandwidth: z.number().min(0).max(1),
    viewerHours: z.number().min(0).max(1),
    /** Streaming hours counted per member per day. */
    dailyStreamingHourCap: z.number().positive(),
    /** Max fraction of the viewer-hours pool any one channel may receive. */
    viewerHoursChannelCap: z.number().gt(0).max(1),
  })
  .refine((w) => Math.abs(w.revenue + w.streamingHours + w.relayBandwidth + w.viewerHours - 1) < 1e-9, {
    message: "patronage weights must sum to 1",
  });
export type PatronageWeights = z.infer<typeof PatronageWeights>;

export const PATRONAGE_COMPONENTS = [
  "revenue",
  "streamingHours",
  "relayBandwidth",
  "viewerHours",
  "adjustment",
] as const;
export const PatronageLine = z.object({
  component: z.enum(PATRONAGE_COMPONENTS),
  /** Human-readable explanation, e.g. "Revenue: $120.00 of $4,000.00 (3.00%) × 50% pool". */
  explanation: z.string(),
  memberValue: z.number(),
  poolTotal: z.number(),
  share: z.number().min(0).max(1),
  poolCents: z.number().int(),
  amountCents: z.number().int(),
  capApplied: z.boolean().default(false),
});
export type PatronageLine = z.infer<typeof PatronageLine>;

export const EventCondition = z.record(z.string(), z.string());
export type EventCondition = z.infer<typeof EventCondition>;

export const BotConfig = z.object({
  displayName: z.string().min(1).max(25).default("ChannelBot"),
  filters: z
    .object({
      spam: z.object({
        enabled: z.boolean(),
        maxRepeatedChars: z.number().int().min(3).default(12),
      }),
      links: z.object({
        enabled: z.boolean(),
        allowSubscribers: z.boolean(),
        allowlist: z.array(z.string().max(253)).max(50).default([]),
      }),
      caps: z.object({
        enabled: z.boolean(),
        minLength: z.number().int().min(1).default(15),
        maxRatio: z.number().min(0).max(1).default(0.7),
      }),
      timeoutSeconds: z.number().int().min(0).default(10),
    })
    .default({
      spam: { enabled: true, maxRepeatedChars: 12 },
      links: { enabled: false, allowSubscribers: true, allowlist: [] },
      caps: { enabled: false, minLength: 15, maxRatio: 0.7 },
      timeoutSeconds: 10,
    }),
  loyalty: z
    .object({
      enabled: z.boolean(),
      pointsName: z.string().min(1).max(20),
      perFiveMinutes: z.number().int().min(0),
      subscriberMultiplier: z.number().min(1).max(5),
      followBonus: z.number().int().min(0),
    })
    .default({
      enabled: true,
      pointsName: "points",
      perFiveMinutes: 10,
      subscriberMultiplier: 2,
      followBonus: 50,
    }),
  songRequests: z
    .object({ enabled: z.boolean(), maxQueue: z.number().int().min(1).max(200) })
    .default({ enabled: false, maxQueue: 25 }),
});
export type BotConfig = z.infer<typeof BotConfig>;

export const PollChoice = z.object({
  id: z.string(),
  title: z.string().min(1).max(60),
  votes: z.number().int().nonnegative(),
});
export type PollChoice = z.infer<typeof PollChoice>;

export const PredictionOutcome = z.object({
  id: z.string(),
  title: z.string().min(1).max(45),
  points: z.number().int().nonnegative(),
  users: z.number().int().nonnegative(),
});
export type PredictionOutcome = z.infer<typeof PredictionOutcome>;

export const AlertTemplate = z.object({
  /** Text with variables: ${user}, ${amount}, ${tier}, ${viewers}, ${message}. */
  message: z.string().min(1).max(200),
  imageKey: z.string().max(512).optional(),
  soundKey: z.string().max(512).optional(),
  animation: z.enum(["fade", "slide", "none"]).default("fade"),
  showMessage: z.boolean().default(true),
});
export type AlertTemplate = z.infer<typeof AlertTemplate>;
