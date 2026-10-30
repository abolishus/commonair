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

/**
 * Each chat setting's validator without its default. `ChannelChatSettings` adds the defaults; the
 * PATCH input (`ChannelChatSettingsPatch`) must not, because Zod applies `.default()` even inside
 * `.partial()`, which would reset every field a partial update leaves out.
 */
const chatSettingFields = {
  /** Seconds between messages per user; 0 = off. */
  slowModeSeconds: z.number().int().min(0).max(600),
  /** Minimum minutes followed before chatting; null = off. */
  followersOnlyMinutes: z.number().int().min(0).max(129_600).nullable(),
  subscribersOnly: z.boolean(),
  emoteOnly: z.boolean(),
  /** Account-age gate (days since signup); 0 = off. */
  minAccountAgeDays: z.number().int().min(0).max(365),
  requireVerifiedEmail: z.boolean(),
  linksAllowed: z.boolean(),
  /**
   * Verified-watch gate (ADR 0015 decision 7): seconds of gate-eligible watching this broadcast a
   * signed-in viewer needs before chatting; 0 = off, else 60–3600. Applies only while the instance
   * flag `CHAT_WATCH_GATE` is on (`instance.info` `features.watchGate`).
   */
  minVerifiedWatchSeconds: z
    .number()
    .int()
    .refine((s) => s === 0 || (s >= 60 && s <= 3600), "0 (off) or 60–3600"),
  /** Subscribers skip the gate (broadcaster, moderators, VIPs and verified bots always do). */
  verifiedWatchExemptSubscribers: z.boolean(),
};
const surgeGuardFields = {
  enabled: z.boolean(),
  /** Share of new sessions older than 60 s that are not gate-eligible which trips the guard. */
  triggerUnverifiedRatio: z.number().min(0.1).max(1),
  cooldownMinutes: z.number().int().min(1).max(120),
};
const f = chatSettingFields;

export const ChannelChatSettings = z.object({
  slowModeSeconds: f.slowModeSeconds.default(0),
  followersOnlyMinutes: f.followersOnlyMinutes.default(null),
  subscribersOnly: f.subscribersOnly.default(false),
  emoteOnly: f.emoteOnly.default(false),
  minAccountAgeDays: f.minAccountAgeDays.default(0),
  requireVerifiedEmail: f.requireVerifiedEmail.default(true),
  linksAllowed: f.linksAllowed.default(true),
  minVerifiedWatchSeconds: f.minVerifiedWatchSeconds.default(0),
  verifiedWatchExemptSubscribers: f.verifiedWatchExemptSubscribers.default(true),
  /** Surge guard (ADR 0015 decision 6). Applies only while `CHAT_SURGE_GUARD` is on (`features.surgeGuard`). */
  surgeGuard: z
    .object({
      enabled: surgeGuardFields.enabled.default(false),
      triggerUnverifiedRatio: surgeGuardFields.triggerUnverifiedRatio.default(0.5),
      cooldownMinutes: surgeGuardFields.cooldownMinutes.default(10),
    })
    .default({ enabled: false, triggerUnverifiedRatio: 0.5, cooldownMinutes: 10 }),
});
export type ChannelChatSettings = z.infer<typeof ChannelChatSettings>;

/**
 * A partial chat-settings update: every field optional and default-free, so fields left out keep
 * their stored value. `surgeGuard` is itself partial and merges into the stored guard settings.
 */
export const ChannelChatSettingsPatch = z
  .object({ ...chatSettingFields, surgeGuard: z.object(surgeGuardFields).partial() })
  .partial();
export type ChannelChatSettingsPatch = z.infer<typeof ChannelChatSettingsPatch>;

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
      /** Off: no accrual, no spending, `!points` silent, predictions and point-bought votes refused. */
      enabled: z.boolean(),
      pointsName: z.string().min(1).max(20),
    })
    .default({ enabled: true, pointsName: "points" }),
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

/** `platform.cut` governance setting. */
export const PlatformCutSetting = z
  .object({ streamerShare: z.number().min(0).max(1), coopShare: z.number().min(0).max(1) })
  .refine((c) => Math.abs(c.streamerShare + c.coopShare - 1) < 1e-9, { message: "cut shares must sum to 1" });
export type PlatformCutSetting = z.infer<typeof PlatformCutSetting>;

/** `payout.rules` governance setting. */
export const PayoutRulesSetting = z.object({
  minimumCents: z.number().int().nonnegative(),
  schedule: z.enum(["monthly"]),
  holdDays: z.number().nonnegative(),
  currency: z.string().regex(/^[a-z]{3}$/),
});
export type PayoutRulesSetting = z.infer<typeof PayoutRulesSetting>;

/**
 * `interact.points.accrual` governance setting (ADR 0026 decision 1, ordinary decision). Range-checked
 * by the database (`commonair_validate_points_accrual`, migration 0034).
 */
export const PointsAccrualSetting = z.object({
  pointsPerBlock: z.number().int().min(1).max(1000),
  blockMinutes: z.number().int().min(1).max(60),
  /** Per viewer per channel per UTC day; 0 turns accrual off instance-wide. */
  dailyCapPerChannel: z.number().int().min(0).max(100_000),
});
export type PointsAccrualSetting = z.infer<typeof PointsAccrualSetting>;

/** What a channel can upload, and which file types each purpose takes (enforced by `channels.uploadUrl`). */
export const UPLOAD_PURPOSES = ["avatar", "banner", "panel", "emote", "alert_image", "alert_sound"] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];
export const UPLOAD_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "audio/mpeg",
  "audio/ogg",
] as const;
export type UploadContentType = (typeof UPLOAD_CONTENT_TYPES)[number];
export const UPLOAD_TYPES: Record<UploadPurpose, readonly UploadContentType[]> = {
  avatar: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  banner: ["image/png", "image/jpeg", "image/webp"],
  panel: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  emote: ["image/png", "image/webp", "image/gif"],
  alert_image: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  alert_sound: ["audio/mpeg", "audio/ogg"],
};
/** Largest presigned upload (`sizeBytes`), for every purpose. */
export const MAX_UPLOAD_BYTES = 10_000_000;
