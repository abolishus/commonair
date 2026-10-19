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
  eligibility: z.array(z.object({ class: z.enum(E.MEMBER_CLASSES), eligible: z.boolean(), detail: z.string() })),
  share: z.object({ status: z.enum(E.SHARE_STATUSES), amount: Money }).nullable(),
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
  tally: z.object({ breakdown: TallyBreakdown, passed: z.boolean(), reason: z.string() }).nullable(),
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
export const DmcaNotice = z.object({
  id: Id,
  status: z.enum(E.DMCA_STATUSES),
  copyrightedWork: z.string(),
  infringingUrls: z.array(z.string()),
  createdAt: Timestamp,
  actionedAt: Timestamp.nullable(),
});

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
