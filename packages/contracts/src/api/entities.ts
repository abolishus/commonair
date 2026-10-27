// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Public data transfer objects. These, not database rows, are what the API returns. */
import { z } from "zod";
import * as E from "../enums.ts";
import {
  AlertTemplate,
  BotConfig,
  ChannelChatSettings,
  ChannelTheme,
  EmoteRange,
  PatronageLine,
  PatronageWeights,
  TallyBreakdown,
} from "../shapes.ts";
import { SCOPE_NAMES } from "../scopes.ts";
import { Id, Money, Slug, Timestamp } from "./common.ts";

export const UserPublic = z.object({
  id: Id,
  username: Slug,
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  accountType: z.enum(E.ACCOUNT_TYPES),
  /** Bots are always attributed to the human member who owns them. */
  botOwner: z.object({ id: Id, username: Slug }).nullable(),
  createdAt: Timestamp,
});
export type UserPublic = z.infer<typeof UserPublic>;

export const Me = UserPublic.extend({
  email: z.email(),
  emailVerified: z.boolean(),
  twoFactorEnabled: z.boolean(),
  role: z.enum(E.PLATFORM_ROLES),
  isAdult: z.boolean(),
  /** Has the viewer confirmed 18+ for mature streams (signed-in adults only). */
  matureConfirmed: z.boolean(),
  shareEmailWithFollowedChannels: z.boolean(),
  memberships: z.array(z.object({ class: z.enum(E.MEMBER_CLASSES), since: Timestamp })),
  pendingLegal: z.array(z.object({ kind: z.enum(E.LEGAL_DOCUMENT_KINDS), version: z.string() })),
  channelSlug: Slug.nullable(),
});
export type Me = z.infer<typeof Me>;

export const Category = z.object({
  id: Id,
  slug: z.string(),
  name: z.string(),
  boxArtUrl: z.string().nullable(),
  mature: z.boolean(),
  liveChannels: z.number().int(),
});
export type Category = z.infer<typeof Category>;

export const BroadcastSummary = z.object({
  id: Id,
  title: z.string(),
  category: Category.pick({ id: true, slug: true, name: true }).nullable(),
  startedAt: Timestamp,
  mature: z.boolean(),
  /** Verified viewers only; excluded traffic never appears in public counts. */
  viewerCount: z.number().int().nonnegative(),
  thumbnailUrl: z.string().nullable(),
  /**
   * `under_review` while a T1 moderation case restricts the broadcast (the thumbnail is then
   * null and the stream is left out of every list). Absent or null otherwise.
   */
  restricted: z.enum(["under_review"]).nullable().optional(),
});
export type BroadcastSummary = z.infer<typeof BroadcastSummary>;

export const Panel = z.object({
  id: Id,
  position: z.number().int(),
  title: z.string(),
  body: z.string(),
  imageUrl: z.string().nullable(),
  linkUrl: z.string().nullable(),
});
export type Panel = z.infer<typeof Panel>;

export const Channel = z.object({
  id: Id,
  slug: Slug,
  displayName: z.string(),
  title: z.string(),
  description: z.string(),
  category: Category.pick({ id: true, slug: true, name: true }).nullable(),
  tags: z.array(z.string()),
  language: z.string(),
  mature: z.boolean(),
  theme: ChannelTheme,
  avatarUrl: z.string().nullable(),
  bannerUrl: z.string().nullable(),
  owner: UserPublic,
  followerCount: z.number().int(),
  live: BroadcastSummary.nullable(),
  panels: z.array(Panel),
  vodEnabled: z.boolean(),
  subTiers: z.array(z.object({ tier: z.number().int(), name: z.string(), price: Money, benefits: z.string() })),
  suspended: z.boolean(),
  /** The signed-in caller's relation to the channel; null or absent for anonymous callers. */
  viewer: z.object({ following: z.boolean() }).nullable().optional(),
});
export type Channel = z.infer<typeof Channel>;

export const DISCOVERY_REASONS = ["popular", "spotlight", "new", "following", "random", "category", "search"] as const;
export const StreamCard = z.object({
  channel: z.object({
    id: Id,
    slug: Slug,
    displayName: z.string(),
    avatarUrl: z.string().nullable(),
    accent: ChannelTheme.shape.accent,
  }),
  broadcast: BroadcastSummary,
  tags: z.array(z.string()),
  language: z.string(),
  /** Why this stream is shown here (transparency for the ranking). */
  reason: z.enum(DISCOVERY_REASONS),
});
export type StreamCard = z.infer<typeof StreamCard>;

/** An offline channel on the front page ("recently live", followed channels that are offline). */
export const ChannelCard = z.object({
  channel: StreamCard.shape.channel,
  /** The last broadcast's title, or the channel title if it never broadcast. */
  title: z.string(),
  category: Category.pick({ id: true, slug: true, name: true }).nullable(),
  /** When the last broadcast ended; null if the channel never broadcast. */
  lastLiveAt: Timestamp.nullable(),
  followerCount: z.number().int().nonnegative(),
  mature: z.boolean(),
});
export type ChannelCard = z.infer<typeof ChannelCard>;

export const StreamKey = z.object({
  id: Id,
  prefix: z.string(),
  createdAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
  revokedAt: Timestamp.nullable(),
  revokedReason: z.string().nullable(),
});
export const StreamKeyCreated = StreamKey.extend({
  key: z.string().describe("Shown once. Store it in your encoder."),
});

export const IngestInfo = z.object({
  rtmpUrl: z.string(),
  whipUrl: z.string(),
  activeKeyPrefix: z.string().nullable(),
  recommended: z.object({
    videoCodec: z.string(),
    audioCodec: z.string(),
    resolution: z.string(),
    fps: z.number(),
    bitrateKbps: z.number().int(),
    keyframeIntervalSeconds: z.number(),
    rateControl: z.string(),
    audioBitrateKbps: z.number().int(),
    notes: z.array(z.string()),
  }),
});

export const HealthSample = z.object({
  at: Timestamp,
  bitrateKbps: z.number().int(),
  fps: z.number().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  videoCodec: z.string().nullable(),
  audioCodec: z.string().nullable(),
  keyframeIntervalMs: z.number().int().nullable(),
  droppedFrames: z.number().int(),
  warnings: z.array(z.string()),
});
export const StreamHealth = z.object({
  live: z.boolean(),
  broadcastId: Id.nullable(),
  ingestProtocol: z.enum(E.INGEST_PROTOCOLS).nullable(),
  transcodeActive: z.boolean(),
  renditions: z.array(z.enum(E.RENDITIONS)),
  samples: z.array(HealthSample),
  simulcast: z.array(
    z.object({
      targetId: Id,
      name: z.string(),
      status: z.enum(E.SIMULCAST_STATUSES),
      lastError: z.string().nullable(),
    }),
  ),
  viewers: z.object({
    verified: z.number().int(),
    pending: z.number().int(),
    excluded: z.number().int(),
  }),
});

export const Vod = z.object({
  id: Id,
  channelSlug: Slug,
  title: z.string(),
  status: z.enum(E.VOD_STATUSES),
  visibility: z.enum(E.VISIBILITIES),
  durationSeconds: z.number(),
  thumbnailUrl: z.string().nullable(),
  playlistUrl: z.string().nullable(),
  createdAt: Timestamp,
  expiresAt: Timestamp.nullable(),
  /** Why processing failed (status `failed`), else null. */
  failedReason: z.enum(E.VOD_FAILED_REASONS).nullable(),
});
export const Clip = z.object({
  id: Id,
  channelSlug: Slug,
  title: z.string(),
  creator: UserPublic.pick({ id: true, username: true, displayName: true }).nullable(),
  status: z.enum(E.CLIP_STATUSES),
  durationSeconds: z.number(),
  url: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  views: z.number().int(),
  createdAt: Timestamp,
});
export const SimulcastTarget = z.object({
  id: Id,
  platform: z.enum(E.SIMULCAST_PLATFORMS),
  name: z.string(),
  rtmpUrl: z.string(),
  enabled: z.boolean(),
  status: z.enum(E.SIMULCAST_STATUSES),
  lastError: z.string().nullable(),
});

export const PlaybackStart = z.object({
  sessionId: Id,
  /** Signed playback token; sent as `?t=` on playlist requests. */
  token: z.string(),
  playlistUrl: z.string(),
  source: z.enum(E.DELIVERY_SOURCES),
  /**
   * `trackerUrls` carry the playback token as `?t=`. The tracker accepts a token up to
   * TRACKER_TOKEN_MAX_AGE_SECONDS old, so on a tracker reconnect clients replace `t` with the latest
   * token from `playback.heartbeat`.
   */
  p2p: z.object({ enabled: z.boolean(), trackerUrls: z.array(z.string()), swarmId: z.string() }),
  heartbeatIntervalMs: z.number().int(),
  expiresAt: Timestamp,
  renditions: z.array(z.enum(E.RENDITIONS)),
  captions: z.array(z.object({ language: z.string(), label: z.string(), url: z.string() })),
});
export const Heartbeat = z.object({
  sessionId: Id,
  token: z.string(),
  /** Seconds of media actually played since the previous heartbeat. */
  playedSeconds: z.number().min(0).max(120),
  bufferSeconds: z.number().min(0),
  stalls: z.number().int().min(0),
  bytesHttp: z.number().int().min(0),
  bytesP2p: z.number().int().min(0),
  rendition: z.enum(E.RENDITIONS),
  latencySeconds: z.number().min(0).nullable(),
  ttffMs: z.number().int().min(0).nullable(),
  visible: z.boolean(),
  muted: z.boolean(),
  /**
   * Coarse client capability signals for headless detection; no persistent identifiers. Known keys:
   * `webdriver` (navigator.webdriver), `automation` (automation globals present), `plugins`
   * (navigator.plugins.length), `webgl` (context available), `innerWidth`, `innerHeight`,
   * `audio` (AudioContext available). See packages/integrity/README.md.
   */
  fingerprint: z
    .record(z.string().max(32), z.union([z.string().max(200), z.number(), z.boolean(), z.null()]))
    .refine((f) => Object.keys(f).length <= 32, "too many fingerprint keys")
    .optional(),
});

export const ChatBadge = z.enum(["broadcaster", "moderator", "vip", "subscriber", "bot", "staff", "member"]);
export const ChatMessage = z.object({
  id: Id,
  channelId: Id,
  user: z.object({
    id: Id,
    username: Slug,
    displayName: z.string(),
    color: z.string().nullable(),
    badges: z.array(z.object({ type: ChatBadge, tier: z.number().int().optional() })),
    accountType: z.enum(E.ACCOUNT_TYPES),
  }),
  body: z.string(),
  emotes: z.array(EmoteRange),
  isAction: z.boolean(),
  replyTo: z.object({ id: Id, username: Slug, body: z.string() }).nullable(),
  createdAt: Timestamp,
});
export type ChatMessage = z.infer<typeof ChatMessage>;
export const ChatSettings = ChannelChatSettings;
export const Ban = z.object({
  id: Id,
  user: UserPublic.pick({ id: true, username: true, displayName: true }),
  moderator: UserPublic.pick({ id: true, username: true }).nullable(),
  reason: z.string(),
  expiresAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export const WordFilter = z.object({
  id: Id,
  pattern: z.string(),
  isRegex: z.boolean(),
  action: z.enum(E.WORD_FILTER_ACTIONS),
  replacement: z.string().nullable(),
  /**
   * The pattern no longer passes the safe-regex validator (stored before a stricter rule landed).
   * Chat skips it on load, so it filters nothing until the owner rewrites or removes it.
   */
  invalid: z.boolean(),
  invalidReason: z.string().nullable(),
});
export const Emote = z.object({
  id: Id,
  code: z.string(),
  url: z.string(),
  tier: z.number().int(),
  animated: z.boolean(),
  channelSlug: Slug.nullable(),
});

export const SubTierInfo = z.object({
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  name: z.string(),
  price: Money,
  benefits: z.string(),
});
export const Subscription = z.object({
  id: Id,
  channelSlug: Slug,
  subscriber: UserPublic.pick({ id: true, username: true, displayName: true }),
  tier: z.number().int(),
  status: z.enum(E.SUBSCRIPTION_STATUSES),
  provider: z.enum(E.PAYMENT_PROVIDERS),
  currentPeriodEnd: Timestamp.nullable(),
  cancelAtPeriodEnd: z.boolean(),
  gifted: z.boolean(),
  createdAt: Timestamp,
});
export const Tip = z.object({
  id: Id,
  channelSlug: Slug,
  from: UserPublic.pick({ id: true, username: true, displayName: true }).nullable(),
  amount: Money,
  message: z.string(),
  status: z.enum(E.PAYMENT_STATUSES),
  createdAt: Timestamp,
});
/** Either a hosted checkout URL (Stripe) or offline payment instructions (manual adapter). */
export const CheckoutResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("redirect"), url: z.string(), paymentId: Id }),
  z.object({
    kind: z.literal("instructions"),
    paymentId: Id,
    reference: z.string(),
    instructions: z.string(),
    amount: Money,
  }),
]);
export const RevenueSummary = z.object({
  periodStart: Timestamp,
  periodEnd: Timestamp,
  gross: Money,
  coopCut: Money,
  refundsAndChargebacks: Money,
  net: Money,
  pendingPayout: Money,
  activeSubscriptions: z.object({
    tier1: z.number().int(),
    tier2: z.number().int(),
    tier3: z.number().int(),
  }),
  tips: z.number().int(),
  split: z.object({ streamerShare: z.number(), coopShare: z.number() }),
  daily: z.array(z.object({ date: z.string(), gross: z.number().int(), net: z.number().int() })),
  /** The creator's balances now (not limited to the period). `available` = released − owed − scheduled. */
  balance: z.object({
    available: Money,
    held: Money,
    owed: Money,
    minimumPayout: Money,
    holdDays: z.number(),
  }),
  /** Creator share in the period by source, cents, net of reversals. */
  bySource: z.object({
    subscriptions: z.number().int(),
    gifts: z.number().int(),
    tips: z.number().int(),
  }),
  /** Active subscriptions per tier and the creator's monthly share at today's price and cut. */
  tiers: z.array(z.object({ tier: z.number().int(), active: z.number().int(), monthlyShare: Money })),
  /** `net` for the period of the same length just before this one. */
  previousNet: Money,
});
/** One row of a creator's revenue ledger, derived from the append-only ledger at read time. */
export const RevenueLine = z.object({
  /** Ledger transaction id. */
  id: Id,
  occurredAt: Timestamp,
  type: z.enum(E.REVENUE_LINE_TYPES),
  tier: z.number().int().nullable(),
  /** Gift subs in one payment; 1 otherwise. */
  quantity: z.number().int(),
  /** Payer for payments (null when anonymous); the subscriber or tipper a reversal refers to. */
  from: UserPublic.pick({ id: true, username: true, displayName: true }).nullable(),
  /** Payout reference or payment reference; never free text. */
  reference: z.string().nullable(),
  /** Gross paid (negative for reversals); null for payouts. */
  gross: Money.nullable(),
  /** Tax, co-op share and fees taken from gross (opposite sign to gross); null for payouts. */
  deductions: Money.nullable(),
  /** Change to what the co-op owes the creator. */
  net: Money,
});
/** Everything the Support dialog needs for one channel. */
export const SupportInfo = z.object({
  provider: z.enum(E.PAYMENT_PROVIDERS),
  currency: z.string().length(3),
  /** Empty until the owner sets tiers; subscriptions and gifts need all three. */
  tiers: z.array(SubTierInfo),
  split: z.object({ streamerShare: z.number(), coopShare: z.number() }),
  tip: z.object({ minCents: z.number().int(), maxCents: z.number().int(), messageMaxLength: z.number().int() }),
  gift: z.object({ maxCount: z.number().int() }),
  /** Null for anonymous callers. */
  viewer: z
    .object({
      /** The caller's own active, past-due or pending subscription to this channel. */
      subscription: Subscription.nullable(),
      /** The channel owner cannot pay their own channel. */
      isOwner: z.boolean(),
    })
    .nullable(),
});
/** A payment as the treasurer sees it (manual adapter). */
export const TreasurerPayment = z.object({
  paymentId: Id,
  reference: z.string(),
  kind: z.enum(E.PAYMENT_KINDS),
  status: z.enum(E.PAYMENT_STATUSES),
  amount: Money,
  refunded: Money,
  tier: z.number().int().nullable(),
  quantity: z.number().int(),
  user: UserPublic.nullable(),
  channelSlug: Slug.nullable(),
  createdAt: Timestamp,
  succeededAt: Timestamp.nullable(),
  expiresAt: Timestamp.nullable(),
});
export const Payout = z.object({
  id: Id,
  periodStart: Timestamp,
  periodEnd: Timestamp,
  amount: Money,
  status: z.enum(E.PAYOUT_STATUSES),
  provider: z.enum(E.PAYMENT_PROVIDERS),
  holdReason: z.string().nullable(),
  paidAt: Timestamp.nullable(),
});
/** A payout row as the treasurer sees it. */
export const TreasurerPayout = Payout.extend({
  user: UserPublic.pick({ id: true, username: true, displayName: true }),
  reference: z.string().nullable(),
  createdAt: Timestamp,
});
export const LedgerLine = z.object({
  transactionId: Id,
  occurredAt: Timestamp,
  kind: z.string(),
  description: z.string(),
  account: z.string(),
  amount: Money,
});

export const OAuthApp = z.object({
  id: Id,
  name: z.string(),
  description: z.string(),
  clientId: z.string(),
  redirectUris: z.array(z.url()),
  confidential: z.boolean(),
  createdAt: Timestamp,
  secretRotatedAt: Timestamp.nullable(),
});
export const OAuthAppSecret = z.object({
  clientId: z.string(),
  clientSecret: z.string().describe("Shown once."),
});
export const AccessToken = z.object({
  id: Id,
  appName: z.string().nullable(),
  scopes: z.array(z.enum(SCOPE_NAMES)),
  createdAt: Timestamp,
  expiresAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
});
export const EventSubscription = z.object({
  id: Id,
  type: z.string(),
  version: z.string(),
  condition: z.record(z.string(), z.string()),
  transport: z.discriminatedUnion("method", [
    z.object({ method: z.literal("webhook"), callback: z.url() }),
    z.object({ method: z.literal("websocket"), sessionId: z.string() }),
  ]),
  status: z.enum(E.SUBSCRIPTION_STATES),
  createdAt: Timestamp,
});
export const WebhookDelivery = z.object({
  id: Id,
  subscriptionId: Id,
  eventId: Id,
  messageId: z.string(),
  messageType: z.string(),
  attempt: z.number().int(),
  status: z.enum(E.DELIVERY_STATUSES),
  responseStatus: z.number().int().nullable(),
  error: z.string().nullable(),
  latencyMs: z.number().int().nullable(),
  createdAt: Timestamp,
});

export const BotCommand = z.object({
  id: Id,
  name: z.string().regex(/^[a-z0-9_]{1,25}$/),
  aliases: z.array(z.string()),
  response: z.string().min(1).max(500),
  userLevel: z.enum(E.USER_LEVELS),
  cooldownSeconds: z.number().int().min(0).max(3600),
  costPoints: z.number().int().min(0),
  enabled: z.boolean(),
  useCount: z.number().int(),
});
export const BotTimer = z.object({
  id: Id,
  name: z.string().min(1).max(50),
  message: z.string().min(1).max(500),
  intervalMinutes: z.number().int().min(1).max(1440),
  minChatLines: z.number().int().min(0),
  enabled: z.boolean(),
});
export const BotSettings = z.object({ enabled: z.boolean(), config: BotConfig });
export const PollView = z.object({
  id: Id,
  title: z.string(),
  choices: z.array(z.object({ id: z.string(), title: z.string(), votes: z.number().int() })),
  status: z.enum(E.POLL_STATUSES),
  startedAt: Timestamp,
  endsAt: Timestamp,
  pointsPerExtraVote: z.number().int(),
  myVote: z.string().nullable(),
});
export const PredictionView = z.object({
  id: Id,
  title: z.string(),
  outcomes: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      points: z.number().int(),
      users: z.number().int(),
    }),
  ),
  status: z.enum(E.PREDICTION_STATUSES),
  startedAt: Timestamp,
  locksAt: Timestamp,
  winningOutcomeId: z.string().nullable(),
  myBet: z.object({ outcomeId: z.string(), points: z.number().int() }).nullable(),
});
export const RaidView = z.object({
  id: Id,
  from: Slug,
  to: Slug,
  viewerCount: z.number().int(),
  status: z.enum(E.RAID_STATUSES),
  executeAt: Timestamp,
});
export const AlertConfig = z.object({
  type: z.enum(E.ALERT_TYPES),
  enabled: z.boolean(),
  template: AlertTemplate,
  minAmountCents: z.number().int().min(0),
  durationMs: z.number().int().min(1000).max(30000),
});
/** `interact.overlays.status`: the token itself is never shown again after creation. */
export const OverlayTokenStatus = z.object({
  active: z.boolean(),
  createdAt: Timestamp.nullable(),
  /** Null with `active` true: no expiry. */
  expiresAt: Timestamp.nullable(),
});
/**
 * One alert on the overlay stream (`OVERLAY_EVENTS_PATH`, SSE event `alert`). Rendered by the
 * API from the channel's `AlertConfig`: the overlay gets display text only, never the underlying
 * event, a payer's id or anything the streamer does not already show on stream.
 */
export const OverlayAlert = z.object({
  /** The source event's id (or a fresh UUIDv7 for a test alert): overlays de-duplicate on it. */
  id: Id,
  type: z.enum(E.ALERT_TYPES),
  /** `template.message` with its variables filled in (anonymous tips show the i18n "Anonymous"). */
  text: z.string(),
  /** The supporter's message when `template.showMessage` and the event carried one. */
  message: z.string().nullable(),
  amountCents: z.number().int().nullable(),
  currency: z.string().nullable(),
  durationMs: z.number().int().min(1000).max(30000),
  animation: z.enum(["fade", "slide", "none"]),
  test: z.boolean(),
  occurredAt: Timestamp,
});
export const Goal = z.object({
  id: Id,
  type: z.enum(E.GOAL_TYPES),
  title: z.string(),
  target: z.number().int().positive(),
  current: z.number().int(),
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
});
export const LoyaltyBalance = z.object({
  channelSlug: Slug,
  user: UserPublic.pick({ id: true, username: true }),
  points: z.number().int(),
  pointsName: z.string(),
});

export const MembershipView = z.object({
  memberships: z.array(
    z.object({
      id: Id,
      class: z.enum(E.MEMBER_CLASSES),
      status: z.enum(E.MEMBERSHIP_STATUSES),
      basis: z.enum(E.MEMBERSHIP_BASES),
      joinedAt: Timestamp,
    }),
  ),
  eligibility: z.array(
    z.object({
      class: z.enum(E.MEMBER_CLASSES),
      eligible: z.boolean(),
      /** The basis the class would use now (null when not eligible, or worker without appointment). */
      basis: z.enum(E.MEMBERSHIP_BASES).nullable(),
      /** Progress toward the threshold: streamer `hours` in the window, viewer `cents` of the share; null for worker. */
      progress: z.object({ have: z.number(), need: z.number(), unit: z.enum(["hours", "cents"]) }).nullable(),
      detail: z.string(),
    }),
  ),
  share: z
    .object({
      id: Id,
      status: z.enum(E.SHARE_STATUSES),
      amount: Money,
      /** While `pending` only: the payment, its reference and the manual instructions (null otherwise). */
      paymentId: Id.nullable(),
      reference: z.string().nullable(),
      instructions: z.string().nullable(),
    })
    .nullable(),
});
/** A member share as the treasury sees it (`coop.shares.list`). */
export const ShareView = z.object({
  id: Id,
  user: UserPublic.pick({ id: true, username: true, displayName: true }),
  status: z.enum(E.SHARE_STATUSES),
  amount: Money,
  paymentId: Id.nullable(),
  purchasedAt: Timestamp.nullable(),
  refundedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export const GovernanceSetting = z.object({
  key: z.string(),
  value: z.unknown(),
  protected: z.boolean(),
  description: z.string(),
  updatedAt: Timestamp,
  updatedByProposalId: Id.nullable(),
});
export const ProposalView = z.object({
  id: Id,
  author: UserPublic.pick({ id: true, username: true, displayName: true }),
  title: z.string(),
  body: z.string(),
  kind: z.enum(E.PROPOSAL_KINDS),
  affectsCreators: z.boolean(),
  status: z.enum(E.PROPOSAL_STATUSES),
  changes: z.array(z.object({ key: z.string(), from: z.unknown(), to: z.unknown(), protected: z.boolean() })),
  timeline: z.object({
    discussionEndsAt: Timestamp.nullable(),
    councilReviewEndsAt: Timestamp.nullable(),
    votingStartsAt: Timestamp.nullable(),
    votingEndsAt: Timestamp.nullable(),
    decidedAt: Timestamp.nullable(),
    appliedAt: Timestamp.nullable(),
  }),
  councilResponse: z.object({ stance: z.enum(E.COUNCIL_STANCES), body: z.string(), publishedAt: Timestamp }).nullable(),
  /** True once council review ended (or voting began) without a published response. */
  councilResponseMissed: z.boolean(),
  /** Decided proposals only: the `tallies` row. Never a running tally while voting is open. */
  tally: z.object({ breakdown: TallyBreakdown, passed: z.boolean(), reason: z.string() }).nullable(),
  /** From the moment voting opens: how many of the frozen electorate voted (counts only). */
  participation: z.object({ voted: z.number().int(), eligible: z.number().int() }).nullable(),
  /** The caller's own vote; never anyone else's. */
  myVote: z.enum(E.VOTE_CHOICES).nullable(),
  canVote: z.boolean(),
  createdAt: Timestamp,
});
export const ProposalComment = z.object({
  id: Id,
  author: UserPublic.pick({ id: true, username: true, displayName: true }),
  body: z.string(),
  createdAt: Timestamp,
});
export const CouncilView = z.object({
  termId: Id.nullable(),
  startsAt: Timestamp.nullable(),
  endsAt: Timestamp.nullable(),
  members: z.array(
    z.object({
      user: UserPublic.pick({ id: true, username: true, displayName: true }),
      rank: z.number().int(),
      contributionScore: z.number(),
    }),
  ),
  method: z.record(z.string(), z.unknown()),
});
export const ElectionView = z.object({
  id: Id,
  class: z.enum(E.MEMBER_CLASSES),
  seats: z.number().int(),
  status: z.enum(E.ELECTION_STATUSES),
  nominationsCloseAt: Timestamp,
  votingEndsAt: Timestamp,
  candidates: z.array(
    z.object({
      user: UserPublic.pick({ id: true, username: true, displayName: true }),
      statement: z.string(),
      votes: z.number().int().nullable(),
      elected: z.boolean(),
    }),
  ),
});
export const PatronageStatement = z.object({
  periodId: Id,
  periodStart: Timestamp,
  periodEnd: Timestamp,
  status: z.enum(E.PATRONAGE_STATUSES),
  formulaVersion: z.string(),
  weights: PatronageWeights,
  surplus: Money,
  total: Money,
  lines: z.array(PatronageLine),
  inputs: z.object({
    revenueCents: z.number().int(),
    eligibleStreamingHours: z.number(),
    relayBytesVerified: z.number().int(),
    viewerHoursVerified: z.number(),
    viewerHoursExcluded: z.number(),
  }),
});
/** A patronage period as treasurers and admins see it (`coop.patronage.periods`). */
export const PatronagePeriodView = z.object({
  id: Id,
  periodStart: Timestamp,
  periodEnd: Timestamp,
  status: z.enum(E.PATRONAGE_STATUSES),
  formulaVersion: z.string(),
  surplus: Money,
  total: Money,
  retained: Money,
  members: z.number().int(),
  computedAt: Timestamp.nullable(),
  computedBy: UserPublic.pick({ id: true, username: true }).nullable(),
  approvedAt: Timestamp.nullable(),
  approvedBy: UserPublic.pick({ id: true, username: true }).nullable(),
});
export const TransparencyMonth = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  revenue: Money,
  streamerPayouts: Money,
  coopRetained: Money,
  costs: z.array(z.object({ category: z.string(), amount: Money })),
  surplus: Money,
  patronageDistributed: Money,
  egressBySource: z.record(z.enum(E.DELIVERY_SOURCES), z.number().int()),
  governance: z.array(
    z.object({
      proposalId: Id,
      title: z.string(),
      status: z.enum(E.PROPOSAL_STATUSES),
      kind: z.enum(E.PROPOSAL_KINDS),
      /** From the `tallies` row; null when not decided by a tally (withdrawn). */
      passed: z.boolean().nullable(),
      reason: z.string().nullable(),
      decidedAt: Timestamp.nullable(),
    }),
  ),
  members: z.record(z.enum(E.MEMBER_CLASSES), z.number().int()),
});

export const IntegrityFlag = z.object({
  id: Id,
  subjectType: z.enum(E.INTEGRITY_SUBJECTS),
  subjectId: Id,
  signal: z.string(),
  score: z.number(),
  details: z.record(z.string(), z.unknown()),
  decision: z.enum(E.INTEGRITY_DECISIONS),
  createdAt: Timestamp,
});
export const IntegritySummary = z.object({
  channelSlug: Slug,
  periodStart: Timestamp,
  periodEnd: Timestamp,
  verifiedViewerHours: z.number(),
  excludedViewerHours: z.number(),
  excludedFollows: z.number().int(),
  exclusionsBySignal: z.array(z.object({ signal: z.string(), sessions: z.number().int(), viewerHours: z.number() })),
});
export const Appeal = z.object({
  id: Id,
  kind: z.enum(E.APPEAL_KINDS),
  subjectType: z.string(),
  subjectId: Id,
  body: z.string(),
  status: z.enum(E.APPEAL_STATUSES),
  resolution: z.string().nullable(),
  createdAt: Timestamp,
  resolvedAt: Timestamp.nullable(),
});

/**
 * Art. 17(3)(b) facts of a statement of reasons (ADR 0019 decision 4). Ids, enums and times only:
 * never an exact score (`threshold` is the governance threshold in force), never free text, never
 * the NCII requester's identity, never a hash, match distance or provider identifier.
 */
export const EnforcementFacts = z.discriminatedUnion("code", [
  z.object({
    code: z.literal("classifier"),
    category: z.enum(E.MODERATION_CATEGORIES),
    tier: z.enum(["t1", "t2"]),
    threshold: z.number().min(0).max(1),
    capturedAt: Timestamp,
  }),
  z.object({
    code: z.literal("moderator_review"),
    caseId: Id,
    caseOrigin: z.enum(["classifier", "human"]),
    decision: z.enum(E.MODERATION_REVIEW_DECISIONS),
  }),
  z.object({ code: z.literal("ncii_notice"), requestId: Id, receivedAt: Timestamp, deadlineAt: Timestamp }),
  /** T0 NCII-list matches only: a CSAM-list match never produces a statement. */
  z.object({ code: z.literal("hash_match"), listCategory: z.literal("ncii"), capturedAt: Timestamp }),
]);
export type EnforcementFacts = z.infer<typeof EnforcementFacts>;

/**
 * A statement of reasons (ADR 0019 decision 4, DSA Art. 17(3)), as stored: append-only, built by
 * the worker from the `audit_log` row that applied the action. Wording comes from the pinned
 * `enforcement_notice` document; the clause catalog lives in `@commonair/moderation`.
 */
export const EnforcementStatement = z.object({
  id: Id,
  /** The `audit_log` row that applied the action. */
  sourceAuditId: Id,
  /** Its action, one of `ENFORCEMENT_SOURCE_ACTIONS` (for filtering and the UI's test ids). */
  sourceAction: z.enum(E.ENFORCEMENT_SOURCE_ACTIONS),
  /** The account notified: the case's user, or the channel owner. */
  recipientUserId: Id,
  channelId: Id.nullable(),
  content: z.object({ type: z.enum(E.ENFORCEMENT_CONTENT_TYPES), id: Id }),
  /** 17(3)(a). `endsAt` null: indefinite, or not applicable. No geo-scoped actions exist. */
  restriction: z.object({
    kind: z.enum(E.ENFORCEMENT_RESTRICTION_KINDS),
    detail: z.enum(E.ENFORCEMENT_RESTRICTION_DETAILS),
    endsAt: Timestamp.nullable(),
    territorialScope: z.literal("all"),
  }),
  facts: EnforcementFacts,
  source: z.enum(E.ENFORCEMENT_SOURCES),
  /** 17(3)(c). */
  automatedDetection: z.boolean(),
  automatedDecision: z.enum(E.ENFORCEMENT_AUTOMATED_DECISIONS),
  /** 17(3)(d)/(e). `legalBasis`: a catalog code, illegal grounds only. */
  ground: z.object({
    kind: z.enum(E.ENFORCEMENT_GROUNDS),
    clauseId: z.string().min(1).max(100),
    clauseVersion: z.number().int().min(1),
    legalBasis: z.string().min(1).max(100).nullable(),
  }),
  /** The `legal_documents` rows the statement was rendered against. */
  documents: z.object({ guidelinesId: Id, noticeId: Id }),
  /** 17(3)(f): what to pass to `appeals.create`; null when no internal appeal applies (T0 NCII list). */
  appeal: z.object({ kind: z.literal("moderation"), subjectType: z.enum(E.APPEAL_SUBJECTS), subjectId: Id }).nullable(),
  /** The audit row's time: when the restriction applied. */
  createdAt: Timestamp,
});
export type EnforcementStatement = z.infer<typeof EnforcementStatement>;

export const Report = z.object({
  id: Id,
  subjectType: z.enum(E.REPORT_SUBJECTS),
  subjectId: Id,
  channelSlug: Slug.nullable(),
  reason: z.enum(E.REPORT_REASONS),
  details: z.string(),
  evidence: z.record(z.string(), z.unknown()),
  status: z.enum(E.REPORT_STATUSES),
  priority: z.number().int(),
  reporter: UserPublic.pick({ id: true, username: true }).nullable(),
  createdAt: Timestamp,
  resolution: z.string().nullable(),
});
export const ModActionView = z.object({
  id: Id,
  scope: z.enum(E.MOD_SCOPES),
  channelSlug: Slug.nullable(),
  moderator: UserPublic.pick({ id: true, username: true }).nullable(),
  target: UserPublic.pick({ id: true, username: true }).nullable(),
  action: z.enum(E.MOD_ACTIONS),
  reason: z.string(),
  durationSeconds: z.number().int().nullable(),
  createdAt: Timestamp,
});
export const AuditEntry = z.object({
  id: Id,
  actorType: z.enum(E.ACTOR_TYPES),
  actorId: Id.nullable(),
  action: z.string(),
  subjectType: z.string(),
  subjectId: z.string(),
  reason: z.string(),
  details: z.record(z.string(), z.unknown()),
  createdAt: Timestamp,
});
export const DmcaNoticeItem = z.object({
  id: Id,
  url: z.string(),
  subjectType: z.enum(E.DMCA_ITEM_SUBJECTS).nullable(),
  subjectId: Id.nullable(),
  ownerId: Id.nullable(),
  removedAt: Timestamp.nullable(),
  restoredAt: Timestamp.nullable(),
});
/** Staff view (platform moderators): the claimant's contact details are on it, never in logs or events. */
export const DmcaCounterNotice = z.object({
  id: Id,
  noticeId: Id,
  user: UserPublic.pick({ id: true, username: true }),
  itemIds: z.array(Id),
  fullName: z.string(),
  address: z.string(),
  phone: z.string(),
  statement: z.string(),
  restoreAfter: Timestamp,
  restoredAt: Timestamp.nullable(),
  suitFiledAt: Timestamp.nullable(),
  suitNote: z.string().nullable(),
  createdAt: Timestamp,
});
export const DmcaNotice = z.object({
  id: Id,
  status: z.enum(E.DMCA_STATUSES),
  claimantName: z.string(),
  claimantEmail: z.string(),
  claimantAddress: z.string(),
  claimantPhone: z.string().nullable(),
  copyrightedWork: z.string(),
  infringingUrls: z.array(z.string()),
  signature: z.string(),
  items: z.array(DmcaNoticeItem),
  counters: z.array(DmcaCounterNotice),
  /** Unreversed strikes in the window per item owner id, for the repeat-infringer policy. */
  ownerStrikes: z.record(Id, z.number().int()),
  handledBy: UserPublic.pick({ id: true, username: true }).nullable(),
  decisionNote: z.string().nullable(),
  createdAt: Timestamp,
  actionedAt: Timestamp.nullable(),
});
/** What the owner of removed content sees: the claimant's name only, never their contact details. */
export const DmcaNoticeForOwner = z.object({
  id: Id,
  status: z.enum(E.DMCA_STATUSES),
  claimantName: z.string(),
  copyrightedWork: z.string(),
  items: z.array(DmcaNoticeItem),
  counter: z
    .object({ id: Id, restoreAfter: Timestamp, restoredAt: Timestamp.nullable(), suitFiledAt: Timestamp.nullable() })
    .nullable(),
  createdAt: Timestamp,
  actionedAt: Timestamp.nullable(),
});
export const AccountAction = z.object({
  id: Id,
  action: z.enum(E.ACCOUNT_ACTIONS),
  /** The decision that caused it, e.g. `dmca_notice` + the notice id. */
  sourceType: z.string().nullable(),
  sourceId: Id.nullable(),
  createdAt: Timestamp,
  reversedAt: Timestamp.nullable(),
  reversedReason: z.enum(E.ACCOUNT_ACTION_REVERSALS).nullable(),
});
export type DmcaNoticeItem = z.infer<typeof DmcaNoticeItem>;
export type DmcaCounterNotice = z.infer<typeof DmcaCounterNotice>;
export type DmcaNotice = z.infer<typeof DmcaNotice>;
export type DmcaNoticeForOwner = z.infer<typeof DmcaNoticeForOwner>;
export type AccountAction = z.infer<typeof AccountAction>;

export const ExportJob = z.object({
  id: Id,
  kind: z.enum(E.EXPORT_KINDS),
  status: z.enum(E.JOB_STATUSES),
  downloadUrl: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  expiresAt: Timestamp.nullable(),
  createdAt: Timestamp,
  completedAt: Timestamp.nullable(),
});
export const DeletionRequest = z.object({
  id: Id,
  status: z.enum(E.DELETION_STATUSES),
  scheduledFor: Timestamp,
  retained: z.array(z.object({ table: z.string(), reason: z.string(), rows: z.number().int() })),
});
export const LegalDocument = z.object({
  id: Id,
  kind: z.enum(E.LEGAL_DOCUMENT_KINDS),
  version: z.string(),
  title: z.string(),
  body: z.string(),
  isDraft: z.boolean(),
  requiresAcceptance: z.boolean(),
  publishedAt: Timestamp,
});

export const RelayNode = z.object({
  id: Id,
  name: z.string(),
  publicUrl: z.url(),
  region: z.string(),
  declaredCapacityMbps: z.number().int(),
  measuredCapacityMbps: z.number().int().nullable(),
  status: z.enum(E.RELAY_STATUSES),
  lastHealthAt: Timestamp.nullable(),
  suspendedReason: z.string().nullable(),
  /** Retired by its owner (never authenticates again); `relays.mine` omits retired relays. */
  retiredAt: Timestamp.nullable(),
  version: z.string().nullable(),
  bytesVerified30d: z.number().int(),
  /** When the relay last submitted a receipt (any status) within the last 30 days, else null. */
  lastReceiptAt: Timestamp.nullable(),
  /** Receipts by status over the last 30 days (by period start). */
  receipts30d: z.object({ pending: z.number().int(), verified: z.number().int(), rejected: z.number().int() }),
});
export const EgressReport = z.object({
  from: Timestamp,
  to: Timestamp,
  totals: z.record(z.enum(E.DELIVERY_SOURCES), z.number().int()),
  byBroadcast: z.array(
    z.object({
      broadcastId: Id,
      channelSlug: Slug,
      bytes: z.record(z.enum(E.DELIVERY_SOURCES), z.number().int()),
    }),
  ),
});

export const StatusComponent = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(E.COMPONENT_STATUSES),
  latencyMs: z.number().nullable(),
  checkedAt: Timestamp,
});
export const StatusSummary = z.object({
  status: z.enum(E.COMPONENT_STATUSES),
  components: z.array(StatusComponent),
  incidents: z.array(
    z.object({
      id: Id,
      title: z.string(),
      status: z.enum(E.INCIDENT_STATUSES),
      components: z.array(z.string()),
      body: z.string(),
      startedAt: Timestamp,
      resolvedAt: Timestamp.nullable(),
    }),
  ),
});
export const InstanceInfo = z.object({
  name: z.string(),
  publicUrl: z.string(),
  sourceUrl: z.string(),
  sourceCommit: z.string(),
  version: z.string(),
  isFlagship: z.boolean(),
  contacts: z.record(z.string(), z.string()),
  features: z.object({
    payments: z.enum(E.PAYMENT_PROVIDERS),
    oauthProviders: z.array(z.enum(["discord", "twitch", "github"])),
    p2p: z.boolean(),
    cdn: z.boolean(),
    vod: z.boolean(),
  }),
  minAge: z.number().int(),
});

// Trust & safety (ADR 0006, docs/testing/e4c-selectors.md) ---------------------------------
// Logs never carry these; T0 material (evidence bytes) is returned only by
// `moderation.evidence` to the `legal` role.

const UserRef = z.object({ id: Id, username: z.string() });
const ChannelRefView = z.object({ id: Id, slug: z.string(), displayName: z.string() });

export const ContentLabel = z.object({
  id: Id,
  channelId: Id,
  label: z.enum(E.CONTENT_LABELS),
  caseId: Id,
  appliedAt: Timestamp,
  removedAt: Timestamp.nullable(),
});
export type ContentLabel = z.infer<typeof ContentLabel>;

/** One signal that crossed a threshold. T1/T2 frames are fetched with `moderation.frame`; T0 flags never have one. */
export const ModerationFlag = z.object({
  id: Id,
  tier: z.enum(E.MODERATION_TIERS),
  origin: z.enum(E.MODERATION_CASE_ORIGINS),
  category: z.enum(E.MODERATION_CATEGORIES).nullable(),
  score: z.number().nullable(),
  listCategory: z.enum(E.HASH_LIST_CATEGORIES).nullable(),
  distance: z.number().int().nullable(),
  provider: z.string(),
  providerVersion: z.string(),
  hasFrame: z.boolean(),
  capturedAt: Timestamp,
});
export type ModerationFlag = z.infer<typeof ModerationFlag>;

/** One audit_log row about a case (automated and human steps). */
export const CaseHistoryRow = z.object({
  id: Id,
  action: z.string(),
  actorType: z.enum(E.ACTOR_TYPES),
  actor: UserRef.nullable(),
  reason: z.string(),
  createdAt: Timestamp,
});
export type CaseHistoryRow = z.infer<typeof CaseHistoryRow>;

export const ModerationCase = z.object({
  id: Id,
  tier: z.enum(E.MODERATION_TIERS),
  status: z.enum(E.MODERATION_CASE_STATUSES),
  origin: z.enum(E.MODERATION_CASE_ORIGINS),
  subjectType: z.enum(E.MODERATION_SUBJECTS),
  subjectId: Id,
  channel: ChannelRefView.nullable(),
  user: UserRef.nullable(),
  category: z.enum(E.MODERATION_CATEGORIES).nullable(),
  priority: z.number().int(),
  /** T1: the response SLA. */
  slaDueAt: Timestamp.nullable(),
  createdAt: Timestamp,
  resolvedAt: Timestamp.nullable(),
  resolution: z.string().nullable(),
  resolutionNote: z.string().nullable(),
});
export type ModerationCase = z.infer<typeof ModerationCase>;

export const ModerationCaseDetail = ModerationCase.extend({
  flags: z.array(ModerationFlag),
  history: z.array(CaseHistoryRow),
  /** Categories the configured classifier does not score (shown as `modq-not-scored`). */
  notScored: z.array(z.enum(E.MODERATION_CATEGORIES)),
  label: ContentLabel.nullable(),
});
export type ModerationCaseDetail = z.infer<typeof ModerationCaseDetail>;

/** Metadata of one sealed evidence object. Never a storage key or URL. */
export const EvidenceObject = z.object({
  id: Id,
  caseId: Id,
  kind: z.enum(E.EVIDENCE_KINDS),
  storage: z.enum(E.EVIDENCE_STORAGE),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  sourceSubjectType: z.enum(E.MODERATION_SUBJECTS),
  sourceSubjectId: Id,
  capturedAt: Timestamp,
});
export type EvidenceObject = z.infer<typeof EvidenceObject>;

/** `moderation.evidence`: one decrypted inline object (legal role only, audited, never cached). */
export const EvidenceView = z.object({ id: Id, contentType: z.string(), dataBase64: z.string() });

export const LegalHold = z.object({
  id: Id,
  userId: Id,
  reasonCode: z.enum(E.LEGAL_HOLD_REASONS),
  /** Staff's words for manual holds; empty for automatic ones. */
  reason: z.string(),
  caseId: Id.nullable(),
  createdAt: Timestamp,
  filedAt: Timestamp.nullable(),
  /** One year after filing; release still needs the operator CLI. */
  eligibleForReleaseAt: Timestamp.nullable(),
  releasedAt: Timestamp.nullable(),
});
export type LegalHold = z.infer<typeof LegalHold>;

export const NcmecReport = z.object({
  id: Id,
  caseId: Id,
  holdId: Id,
  userId: Id.nullable(),
  status: z.enum(E.NCMEC_REPORT_STATUSES),
  incidentAt: Timestamp,
  listCategory: z.enum(E.HASH_LIST_CATEGORIES).nullable(),
  target: z.string(),
  evidenceIds: z.array(Id),
  externalReportId: z.string().nullable(),
  filedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type NcmecReport = z.infer<typeof NcmecReport>;

/**
 * The plaintext of `ncmec_reports.snapshot_sealed` (JSON, sealed to the evidence key): what the
 * CyberTipline asks for, captured when the draft is made so account deletion cannot erase it.
 */
export const NcmecSnapshot = z.object({
  v: z.literal(1),
  incidentAt: Timestamp,
  incidentType: z.enum(["csam_hash_match", "csam_confirmed"]),
  account: z.object({
    id: Id,
    username: z.string(),
    displayName: z.string(),
    email: z.string(),
    createdAt: Timestamp,
    /** IP hashes and raw IPs the platform still holds for the account (sessions, auth log). */
    ipHashes: z.array(z.string()),
    ips: z.array(z.string()),
  }),
  subject: z.object({
    type: z.enum(E.MODERATION_SUBJECTS),
    id: Id,
    channelId: Id.nullable(),
    channelSlug: z.string().nullable(),
  }),
  match: z
    .object({
      listCategory: z.enum(E.HASH_LIST_CATEGORIES),
      provider: z.string(),
      listVersion: z.string(),
      distance: z.number().int(),
      pdq: z.string(),
    })
    .nullable(),
  evidenceIds: z.array(Id),
});
export type NcmecSnapshot = z.infer<typeof NcmecSnapshot>;
export const NcmecReportDetail = NcmecReport.extend({ snapshot: NcmecSnapshot });

/** A T0 case as the `legal` role sees it. `list` is the hash list that fired, or `human` for escalations. */
export const LegalCase = ModerationCase.extend({
  list: z.enum([...E.HASH_LIST_CATEGORIES, "human"]),
  firstReviewer: UserRef.nullable(),
  firstReviewedAt: Timestamp.nullable(),
  firstReviewNote: z.string().nullable(),
  evidence: z.array(EvidenceObject),
  holdId: Id.nullable(),
  ncmecReportId: Id.nullable(),
  flags: z.array(ModerationFlag),
  history: z.array(CaseHistoryRow),
});
export type LegalCase = z.infer<typeof LegalCase>;

export const NciiRequestItem = z.object({
  id: Id,
  url: z.string(),
  subjectType: z.enum(E.MODERATION_SUBJECTS).nullable(),
  subjectId: Id.nullable(),
  hiddenAt: Timestamp.nullable(),
  removedAt: Timestamp.nullable(),
});
/** Staff view of a takedown request (moderators and `legal` only). */
export const NciiRequest = z.object({
  id: Id,
  status: z.enum(E.NCII_STATUSES),
  requesterName: z.string(),
  requesterEmail: z.string(),
  relationship: z.enum(E.NCII_RELATIONSHIPS),
  description: z.string(),
  signature: z.string(),
  items: z.array(NciiRequestItem),
  receivedAt: Timestamp,
  deadlineAt: Timestamp,
  escalated24At: Timestamp.nullable(),
  escalated36At: Timestamp.nullable(),
  autoHiddenAt: Timestamp.nullable(),
  decidedAt: Timestamp.nullable(),
  decisionNote: z.string().nullable(),
});
export type NciiRequest = z.infer<typeof NciiRequest>;
