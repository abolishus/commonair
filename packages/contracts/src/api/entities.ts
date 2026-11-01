// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0

/** Public data transfer objects. These, not database rows, are what the API returns. */
import { z } from "zod";
import * as E from "../enums.ts";
import {
  AlertTemplate,
  BotConfig,
  ChannelCaptionsSettings,
  ChannelChatSettings,
  ChannelDvrSettings,
  ChannelTheme,
  EmoteRange,
  GiveawayEligibility,
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

/** A BCP 47 language tag as the platform stores it (`en`, `es`, `pt-BR`; `en-XA` is the pseudo-locale). */
export const LocaleTag = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$/);

export const Me = UserPublic.extend({
  email: z.email(),
  emailVerified: z.boolean(),
  twoFactorEnabled: z.boolean(),
  role: z.enum(E.PLATFORM_ROLES),
  isAdult: z.boolean(),
  /** Has the viewer confirmed 18+ for mature streams (signed-in adults only). */
  matureConfirmed: z.boolean(),
  shareEmailWithFollowedChannels: z.boolean(),
  /** The language the member chose; null = not chosen, so the web negotiates (ADR 0029). */
  locale: LocaleTag.nullable(),
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
  /** Verified viewers watching live only; excluded traffic never appears in public counts. */
  viewerCount: z.number().int().nonnegative(),
  /**
   * ADR 0016 decision 6 ("the public count shows both numbers"): verified viewers rewound in DVR
   * mode, counted apart from `viewerCount`. Absent = 0 (W2-dvr fills it).
   */
  catchingUpCount: z.number().int().nonnegative().optional(),
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
  viewer: z
    .object({
      following: z.boolean(),
      /** Batch 7 decision (l): the caller asked to be told if the channel moves. Absent = false (W3-portability fills it). */
      portabilityGrant: z.boolean().optional(),
    })
    .nullable()
    .optional(),
  /**
   * Batch 7 decision (l): where the channel says it moved (`channels.moved_to`, an https URL), shown
   * as a "moved to" notice. Null when it has not moved (W3-portability fills it).
   */
  movedTo: z.object({ url: z.string(), at: Timestamp }).nullable().optional(),
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

/** One subtitle track (WebVTT). On `PlaybackStart` only active live tracks; on `Vod` only ready ones. */
export const CaptionTrack = z.object({ language: z.string(), label: z.string(), url: z.string() });
export type CaptionTrack = z.infer<typeof CaptionTrack>;

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
  /** W2-captions: the VOD's ready caption tracks (empty when none or not yet stitched). */
  captions: z.array(CaptionTrack),
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
  /**
   * W2-vod-watch: the wall-clock start of the window the clip was cut from (broadcast
   * `started_at + start_offset`, the value `clips.chat` uses), so replay can place chat against
   * the MP4's `currentTime`. Null when the clip has no broadcast.
   */
  windowStartedAt: Timestamp.nullable(),
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
   * Peer-to-peer delivery (ADR 0005 amendment 1). `available`: P2P is possible for this session at
   * all (P2P_ENABLED, not native HLS, not 18+, mature or restricted), whatever the client asked,
   * so the player can offer its opt-in switch. `enabled`: the server wrote the session's P2P grant
   * (`available` and the player sent `p2pCapable`); only then are `trackerUrls` non-empty.
   *
   * `swarmId` is server chosen (the broadcast id) and is the loader's `swarmId`; stream swarm ids
   * and info hashes derive from it (`p2pStreamSwarmId`, `@commonair/contracts/p2p`), and the tracker
   * refuses any other. `trackerUrls` carry the playback token as `?t=`; the tracker accepts a token
   * up to TRACKER_TOKEN_MAX_AGE_SECONDS old. The loader's tracker list is fixed at construction, so
   * a reconnect after that age fails and the player falls back to HTTP.
   *
   * `digestUrl` is the origin's digest base (`${PLAYBACK_PUBLIC_URL}/p2p-digest`), also when
   * `enabled` is false: `GET <digestUrl>/live/<slug>[/<rendition>]/<file>?t=<token>` answers 64
   * lowercase hex characters, the SHA-256 of the segment exactly as `/hls/` serves it. Only the
   * origin serves it; the player checks every peer-delivered segment against it.
   */
  p2p: z.object({
    enabled: z.boolean(),
    available: z.boolean(),
    trackerUrls: z.array(z.string()),
    swarmId: z.string(),
    digestUrl: z.string(),
  }),
  heartbeatIntervalMs: z.number().int(),
  expiresAt: Timestamp,
  renditions: z.array(z.enum(E.RENDITIONS)),
  /** Active live caption tracks (W2-captions `captionTracksFor`); empty for rehearsals. */
  captions: z.array(CaptionTrack),
  /**
   * Why there are or are not captions: `off` (the channel or instance has them off, or a
   * rehearsal), `queued` (waiting for a captions slot on the media host), `active`.
   */
  captionsState: z.enum(E.CAPTIONS_STATES),
  /** The data-mode ceiling in the session's token (ADR 0018), null when off. */
  dataMode: z.number().int().nullable(),
  /**
   * Live DVR (ADR 0016): seconds the viewer may rewind, `min(channel window, DVR_MAX_WINDOW_SECONDS)`;
   * 0 = no DVR (no recording, DVR off, data mode on, a rehearsal, or the VOD gate refuses).
   */
  dvrWindowSeconds: z.number().int().nonnegative(),
  /**
   * The DVR playlist on `PLAYBACK_PUBLIC_URL` (`/dvr/<vodId>/index.m3u8?t=<dvr token>`), even for
   * relay- or CDN-assigned sessions (DVR is origin-only); null exactly when `dvrWindowSeconds` is 0.
   */
  dvrPlaylistUrl: z.string().nullable(),
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
  /**
   * P2P diagnostics, informational only: nothing that counts, pays or verifies reads them (ADR 0005
   * amendment 1). `bytesP2pUp`: bytes sent to peers since the previous heartbeat. `p2pPeers`: open
   * peer connections now. `p2pRejected`: peer-delivered segments that failed digest validation
   * since the previous heartbeat.
   */
  bytesP2pUp: z.number().int().min(0).optional(),
  p2pPeers: z.number().int().min(0).max(64).optional(),
  p2pRejected: z.number().int().min(0).optional(),
  rendition: z.enum(E.RENDITIONS),
  latencySeconds: z.number().min(0).nullable(),
  ttffMs: z.number().int().min(0).nullable(),
  visible: z.boolean(),
  muted: z.boolean(),
  /** ADR 0012 amendment 1 / ADR 0016 decision 6. Absent = `live`. Accepted from W1, recorded from W2-dvr on. */
  playbackMode: z.enum(E.PLAYBACK_MODES).optional(),
  /** Seconds behind the live edge in `dvr` mode (W2-dvr); accepted and ignored in W1. */
  behindLiveSeconds: z.number().min(0).max(86_400).nullable().optional(),
  /** ADR 0018 decision 3: the data-mode ceiling in bit/s, null = turn off, absent = unchanged. */
  dataMode: z.number().int().min(E.DATA_MODE.minCeilingBps).max(E.DATA_MODE.maxCeilingBps).nullable().optional(),
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

/** ICE servers for a P2P playback session; `expiresAt` is null when nothing expires (STUN only). */
export const IceServers = z.object({
  iceServers: z.array(
    z.object({
      urls: z.array(z.string()).min(1),
      username: z.string().optional(),
      credential: z.string().optional(),
    }),
  ),
  expiresAt: Timestamp.nullable(),
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
  /** PDT under the sender's playhead, clamped by chat (ADR 0012 amendment 1 decisions 1-4); null when the channel was not live, in DVR mode, or for history rows written before W1. Optional so Twitch-shaped fixtures need no churn; every live frame and history row sets it. */
  mediaTs: Timestamp.nullable().optional(),
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
  /** The payment the line belongs to (payments and their reversals); null for payouts. The breakdown entry point. */
  paymentId: Id.nullable(),
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
export const BreakdownLine = z.object({
  kind: z.enum(E.BREAKDOWN_LINE_KINDS),
  /** Signed: gross-side lines positive, reversal lines negative; fees positive (a co-op expense); coop_net signed. */
  amount: Money,
  /** Set on `creator` lines (one per recipient; Ledger Splits adds crew lines) and on creator `reversal` lines. */
  recipientUserId: Id.nullable(),
  /** `reversal` lines only: which part of gross they take back. */
  component: z.enum(E.BREAKDOWN_COMPONENTS).nullable(),
  /** The ledger transaction the line comes from; null for the derived `coop_net`. */
  transactionId: Id.nullable(),
});
export const PaymentBreakdown = z.object({
  paymentId: Id,
  kind: z.enum(E.PAYMENT_KINDS),
  channel: z.object({ slug: Slug, displayName: z.string() }),
  /** Who is looking: the payer, or the channel owner (payee). */
  viewerRole: z.enum(["payer", "payee"]),
  /** Null when the payment is anonymous and the viewer is the payee (`payments.anonymous`). */
  payer: UserPublic.pick({ id: true, username: true, displayName: true }).nullable(),
  gross: Money,
  succeededAt: Timestamp,
  lines: z.array(BreakdownLine),
  /** `succeededAt + payout.rules.holdDays`; null once released. */
  holdReleasesAt: Timestamp.nullable(),
  holdReleasedAt: Timestamp.nullable(),
  /**
   * The `platform.cut` that fixed the split (`cutHistoryId` in the posting). The founding seed has
   * `historyId` and `changedAt` null even though its insert wrote a history row (old value null, no
   * proposal); `coop.feeSchedule` reports that row the same way.
   */
  cutSource: z.object({
    historyId: Id.nullable(),
    changedAt: Timestamp.nullable(),
    proposalId: Id.nullable(),
    streamerShare: z.number(),
    coopShare: z.number(),
  }),
  timeline: z.array(
    z.object({ kind: z.enum(E.BREAKDOWN_EVENT_KINDS), at: Timestamp, amount: Money.nullable(), transactionId: Id }),
  ),
});
export const FeeScheduleEntry = z.object({
  /**
   * `governance_settings_history.id`; null for the founding seed value. The seed's insert does write
   * a history row (old value null, no proposal), but it is reported with `id` and `changedAt` null,
   * matching `PaymentMetaV2.cutHistoryId` and `PaymentBreakdown.cutSource`.
   */
  id: Id.nullable(),
  key: z.enum(E.FEE_SCHEDULE_KEYS),
  value: z.record(z.string(), z.unknown()),
  previous: z.record(z.string(), z.unknown()).nullable(),
  /** Null for the founding seed (see `id`). */
  changedAt: Timestamp.nullable(),
  proposalId: Id.nullable(),
});
export const BlockedUser = z.object({
  user: UserPublic.pick({ id: true, username: true, displayName: true }),
  createdAt: Timestamp,
});
export const SurgeState = z.object({
  /** `off`: no override. `on`: surge mode (gate at max(minVerifiedWatchSeconds, 60)). `suppressed`: a moderator ended it; no re-trigger until `until`. */
  state: z.enum(["off", "on", "suppressed"]),
  since: Timestamp.nullable(),
  until: Timestamp.nullable(),
  /** Who started or ended it by hand; null for the job. */
  by: UserPublic.pick({ id: true, username: true }).nullable(),
  /** Valkey could not be read: the gate fails open (ADR 0015 decision 1). */
  unavailable: z.boolean(),
  /**
   * Batch 7 decision (w): the raid that opened this surge (the mod banner names the source and its
   * verified count). Null otherwise (W3-surge-raids fills it).
   */
  raid: z.object({ fromChannel: Slug, verifiedCount: z.number().int().nonnegative() }).nullable().optional(),
});
export const PaymentFraudFlag = z.object({
  id: Id,
  payee: UserPublic.pick({ id: true, username: true, displayName: true }),
  kind: z.enum(E.PAYMENT_FRAUD_KINDS),
  status: z.enum(E.PAYMENT_FRAUD_STATUSES),
  /** Ids, counts and cents only. */
  evidence: z.record(z.string(), z.union([z.string(), z.number()])),
  raisedAt: Timestamp,
  /** Null when the scan raised it. */
  raisedBy: UserPublic.pick({ id: true, username: true }).nullable(),
  reviewedBy: UserPublic.pick({ id: true, username: true }).nullable(),
  recommendation: z.enum(E.PAYMENT_FRAUD_DECISIONS).nullable(),
  reviewedAt: Timestamp.nullable(),
  decidedBy: UserPublic.pick({ id: true, username: true }).nullable(),
  decidedAt: Timestamp.nullable(),
  /** A confirmed flag holds until an admin releases it (ADR 0036 decision 3); null otherwise. */
  releasedBy: UserPublic.pick({ id: true, username: true }).nullable(),
  releasedAt: Timestamp.nullable(),
  note: z.string(),
  /** Payouts of this payee held for review now. */
  heldPayouts: z.number().int(),
});
export const ChatReplayPage = z.object({
  items: z.array(
    ChatMessage.extend({
      /** Where replay places the line: `mediaTs`, or `createdAt` for a message sent while catching up. */
      at: Timestamp,
      /** Sent in DVR mode (`mediaTs` null): shown as "said while catching up". */
      catchingUp: z.boolean(),
    }),
  ),
  nextCursor: z.string().nullable(),
  /** False once the window's messages have aged out (ADR 0012 amendment 1 decision 6): the UI says chat is no longer kept. */
  retained: z.boolean(),
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
  /** "Typical fee" range for the estimate (PROCESSOR_FEE_ESTIMATE[provider]); null when the provider charges none. */
  feeEstimate: z
    .object({ lowBps: z.number().int(), highBps: z.number().int(), fixedCents: z.number().int() })
    .nullable(),
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
  redirectUris: z.array(z.string()),
  confidential: z.boolean(),
  createdAt: Timestamp,
  secretRotatedAt: Timestamp.nullable(),
  /** Set while an admin has suspended the app (ADR 0027 §4); its tokens do not resolve. */
  suspended: z.object({ at: Timestamp, reason: z.enum(E.APP_SUSPENSION_REASONS) }).nullable(),
});
export const OAuthAppSecret = z.object({
  clientId: z.string(),
  clientSecret: z.string().describe("Shown once."),
});
export const OAuthAppSummary = z.object({
  id: Id,
  name: z.string(),
  description: z.string(),
  clientId: z.string(),
  owner: UserPublic.pick({ id: true, username: true }),
});
export const AccessToken = z.object({
  id: Id,
  appId: Id.nullable(),
  appName: z.string().nullable(),
  kind: z.enum(E.OAUTH_TOKEN_KINDS),
  scopes: z.array(z.enum(SCOPE_NAMES)),
  createdAt: Timestamp,
  expiresAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
});
export const EventSubscription = z.object({
  id: Id,
  appId: Id.nullable(),
  /** The user whose authorization backs it (the app owner for scope-less app subscriptions). */
  userId: Id,
  type: z.string(),
  version: z.string(),
  condition: z.record(z.string(), z.string()),
  transport: z.discriminatedUnion("method", [
    z.object({ method: z.literal("webhook"), callback: z.url() }),
    z.object({ method: z.literal("websocket"), sessionId: z.string() }),
  ]),
  status: z.enum(E.SUBSCRIPTION_STATES),
  failureCount: z.number().int(),
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
/** What `developer.oauth.request` answers: show consent, or send the browser back with an error. */
export const OAuthConsent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("consent"),
    app: OAuthAppSummary,
    scopes: z.array(z.enum(SCOPE_NAMES)),
    /** The user already holds a live grant covering every requested scope. */
    alreadyGranted: z.boolean(),
  }),
  /** RFC 6749 §4.1.2.1: the redirect URI is valid, so errors go back to the client. */
  z.object({ kind: z.literal("redirect"), redirectTo: z.string() }),
]);
export const OAuthDeviceConsent = z.object({
  app: OAuthAppSummary,
  scopes: z.array(z.enum(SCOPE_NAMES)),
  expiresAt: Timestamp,
});
/** One app the user has authorized (settings, "Connections"). */
export const OAuthGrant = z.object({
  app: OAuthAppSummary,
  /** Union of the scopes of the grant's live tokens. */
  scopes: z.array(z.enum(SCOPE_NAMES)),
  authorizedAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
});
export const AdminOAuthApp = OAuthApp.extend({
  owner: UserPublic.pick({ id: true, username: true }),
  /** Users with a live grant. */
  grants: z.number().int(),
  /** Enabled webhook subscriptions. */
  subscriptions: z.number().int(),
});

const BotCommandName = z.string().regex(/^[a-z0-9_]{1,25}$/);
export const BotCommand = z.object({
  id: Id,
  name: BotCommandName,
  aliases: z.array(BotCommandName).max(5),
  /** Variable substitution only (ADR 0026 decision 6): `${user}`, `${count}`, `${var:name}` and the bot engine's documented built-ins. */
  response: z.string().min(1).max(500),
  userLevel: z.enum(E.USER_LEVELS),
  cooldownSeconds: z.number().int().min(0).max(3600),
  costPoints: z.number().int().min(0).max(1_000_000),
  enabled: z.boolean(),
  useCount: z.number().int(),
});
export const BotTimer = z.object({
  id: Id,
  name: z.string().min(1).max(50),
  message: z.string().min(1).max(500),
  intervalMinutes: z.number().int().min(1).max(1440),
  /** At least 1: a timer never talks to an empty room (ADR 0026 decision 6). */
  minChatLines: z.number().int().min(1).max(1000),
  enabled: z.boolean(),
});
export const BotSettings = z.object({
  enabled: z.boolean(),
  config: BotConfig,
  /** The channel's bot account (`users.account_type = 'bot'`), created the first time the bot is enabled. */
  botUser: UserPublic.pick({ id: true, username: true }).nullable(),
});
export const SongRequest = z.object({
  id: Id,
  /** The link the viewer pasted; never fetched (ADR 0026 decision 6). */
  url: z.string(),
  requester: Slug,
  status: z.enum(E.SONG_REQUEST_STATUSES),
  createdAt: Timestamp,
});
export const PollView = z.object({
  id: Id,
  title: z.string(),
  choices: z.array(z.object({ id: z.string(), title: z.string(), votes: z.number().int() })),
  status: z.enum(E.POLL_STATUSES),
  startedAt: Timestamp,
  endsAt: Timestamp,
  endedAt: Timestamp.nullable(),
  pointsPerExtraVote: z.number().int(),
  myVote: z.string().nullable(),
  /** The caller's votes including bought extra votes; 0 when not voted or anonymous. */
  myVotes: z.number().int(),
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
  lockedAt: Timestamp.nullable(),
  endedAt: Timestamp.nullable(),
  winningOutcomeId: z.string().nullable(),
  myBet: z.object({ outcomeId: z.string(), points: z.number().int(), payout: z.number().int().nullable() }).nullable(),
  /**
   * Batch 7 decision (v): the media time (PDT) betting locked at; a bet whose `mediaTs` is at or
   * after it is refused. Null until locked (W3-fair-predictions fills it).
   */
  lockMediaTs: Timestamp.nullable().optional(),
  /** Who resolved or canceled it; null while open (and for the timer). */
  resolvedBy: UserPublic.pick({ id: true, username: true }).nullable().optional(),
  /** The public result card once resolved: the pool, the winners and that the payouts sum to the pool. */
  result: z
    .object({
      pool: z.number().int().nonnegative(),
      winners: z.number().int().nonnegative(),
      payoutSum: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
});
export const RaidView = z.object({
  id: Id,
  from: Slug,
  to: Slug,
  toDisplayName: z.string(),
  /** Gate-eligible viewers of the source at execute time (0 while pending). */
  viewerCount: z.number().int(),
  status: z.enum(E.RAID_STATUSES),
  cancelReason: z.enum(E.RAID_CANCEL_REASONS).nullable(),
  createdAt: Timestamp,
  executeAt: Timestamp,
});
/** `interact.raids.current`: the pending or last raid, when the next may start, and who may raid this channel. */
export const RaidState = z.object({
  raid: RaidView.nullable(),
  cooldownEndsAt: Timestamp.nullable(),
  policy: z.enum(E.RAID_POLICIES),
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
  /** The channel's points are on (`BotConfig.loyalty.enabled`); viewers hide the chip and the spend controls when false. */
  enabled: z.boolean(),
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
  /**
   * ADR 0013 decisions 6 and 7: withheld split shares and split shortfalls this month. Counts and
   * totals only, never who. `heldAtMonthEnd`: the `liability:split-suspense:*` balance at month end;
   * the write-off amount itself is the `split-shortfall-writeoff` line in `costs`.
   */
  splitSuspense: z.object({
    released: z.number().int().nonnegative(),
    forfeited: z.number().int().nonnegative(),
    writeOffs: z.number().int().nonnegative(),
    heldAtMonthEnd: Money,
  }),
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
/**
 * What was excluded from a channel's counts and why (decision (k)): from the per-broadcast rollup,
 * integer seconds, by exclusion category (never a signal code or a threshold). Groups under
 * `ANALYTICS_RULES.minGroupSessions` sessions are left out and counted in `hiddenGroups`.
 */
export const IntegritySummary = z.object({
  channelSlug: Slug,
  periodStart: Timestamp,
  periodEnd: Timestamp,
  verifiedViewerSeconds: z.number().int().nonnegative(),
  /** Pending and fetch-unjudged sessions: neither verified nor excluded (ADR 0014 decision 7). */
  unverifiedViewerSeconds: z.number().int().nonnegative(),
  excludedViewerSeconds: z.number().int().nonnegative(),
  excludedFollows: z.number().int().nonnegative(),
  exclusionsByCategory: z.array(
    z.object({
      category: z.enum(E.EXCLUSION_CATEGORIES),
      sessions: z.number().int().nonnegative(),
      viewerSeconds: z.number().int().nonnegative(),
    }),
  ),
  hiddenGroups: z.number().int().nonnegative(),
});
export const Appeal = z.object({
  id: Id,
  kind: z.enum(E.APPEAL_KINDS),
  subjectType: z.string(),
  subjectId: Id,
  /** `exclusion_group` appeals only (`subjectId` is then the broadcast id); else null. */
  exclusionCategory: z.enum(E.EXCLUSION_CATEGORIES).nullable(),
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
    /** The operator's P2P_DEFAULT: P2P for viewers who have not chosen (`off` means opt in). */
    p2pDefault: z.enum(["off", "on"]),
    cdn: z.boolean(),
    vod: z.boolean(),
    /** CHAT_WATCH_GATE (ADR 0015 decision 7): the studio shows the gate setting only when true. */
    watchGate: z.boolean(),
    /** CHAT_SURGE_GUARD (ADR 0015 decision 6). */
    surgeGuard: z.boolean(),
    /** DVR_MAX_WINDOW_SECONDS (ADR 0016): the studio offers DVR windows up to this; 0 = DVR off. */
    dvrMaxWindowSeconds: z.number().int().nonnegative(),
    /** GIVEAWAYS_ENABLED (batch 7 decision (a)): off, the web hides every giveaway surface. */
    giveaways: z.boolean(),
    /** FEDERATION_ENABLED (decision (c)): the studio offers per-channel federation only when true. */
    federation: z.boolean(),
    /** Twitch import available (decision (b)): `OAUTH_TWITCH_*` set and TWITCH_IMPORT_ENABLED. */
    twitchImport: z.boolean(),
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

/** A member's go-live preferences: defaults per medium, then per-channel overrides. */
export const NotificationPreferences = z.object({
  type: z.enum(E.PREFERENCE_TYPES),
  /** The member's default per medium (their row, else the built-in `NOTIFY_DEFAULTS`). */
  defaults: z.object({ in_app: z.boolean(), email: z.boolean(), push: z.boolean() }),
  /** Built-in or chosen, per medium (the UI marks the built-in ones). */
  builtIn: z.object({ in_app: z.boolean(), email: z.boolean(), push: z.boolean() }),
  /** Channel overrides that exist; a medium absent from `media` follows the default. */
  channels: z.array(
    z.object({
      channel: z.object({ id: Id, slug: Slug, displayName: z.string() }),
      media: z.partialRecord(z.enum(E.NOTIFY_MEDIA), z.boolean()),
    }),
  ),
  /** Email needs a verified address (ADR 0028 decision 4): the UI explains why email is inert. */
  emailVerified: z.boolean(),
});
export type NotificationPreferences = z.infer<typeof NotificationPreferences>;
export const PushStatus = z.object({
  /** `WEB_PUSH_ENABLED` on this instance. */
  enabled: z.boolean(),
  /** The VAPID public key (base64url, 65 bytes) for `applicationServerKey`; null when disabled. */
  vapidPublicKey: z.string().nullable(),
  /** The caller's push subscriptions (browsers). */
  subscriptions: z.number().int(),
});
export type PushStatus = z.infer<typeof PushStatus>;
export const DiscordWebhookStatus = z.object({
  configured: z.boolean(),
  setAt: Timestamp.nullable(),
  lastPostedAt: Timestamp.nullable(),
  lastError: z.enum(E.DISCORD_WEBHOOK_ERRORS).nullable(),
});
export type DiscordWebhookStatus = z.infer<typeof DiscordWebhookStatus>;

// Feature wins, wave 2 (W2; .claude/briefs/w2/contract-step.md §1.3, docs/testing/w2-selectors.md)

/** Captions and DVR settings for the studio (owner only: the mask list is private). */
export const ChannelMediaSettings = z.object({
  captions: ChannelCaptionsSettings,
  /** The instance default (`captions.defaultEnabled`) a null `captions.enabled` follows. */
  captionsInstanceDefault: z.boolean(),
  /** The live broadcast's caption track (`PlaybackStart.captionsState`); `off` while offline. */
  captionsState: z.enum(E.CAPTIONS_STATES),
  dvr: ChannelDvrSettings,
  /** `DVR_MAX_WINDOW_SECONDS`; the effective window is `min(dvr.windowSeconds, this)`. */
  dvrMaxWindowSeconds: z.number().int().nonnegative(),
});
export type ChannelMediaSettings = z.infer<typeof ChannelMediaSettings>;

/** One editable cue of a VOD caption track (timing is fixed in v1, ADR 0011). */
export const CaptionCue = z.object({
  /** Index in the track, stable across text edits. */
  index: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string().max(500),
});
export const VodCaptions = z.object({
  vodId: Id,
  language: z.string(),
  status: z.enum(E.CAPTION_TRACK_STATUSES),
  cues: z.array(CaptionCue),
  /** Last edit, if any (`caption_edits`). */
  editedAt: Timestamp.nullable(),
});
export type VodCaptions = z.infer<typeof VodCaptions>;

/** Revenue splits (ADR 0013). User refs only; never a payout account or an email. */
export const SplitShare = z.object({
  recipient: UserPublic.pick({ id: true, username: true, displayName: true }),
  bps: z.number().int().min(E.SPLIT_RULES.minBps).max(E.SPLIT_RULES.maxBpsTotal),
  /** The recipient's answer; null while undecided. */
  decision: z.enum(E.SPLIT_ACCEPTANCE_DECISIONS).nullable(),
  decidedAt: Timestamp.nullable(),
});
export const RevenueSplit = z.object({
  id: Id,
  channelSlug: Slug,
  version: z.number().int().positive(),
  status: z.enum(E.SPLIT_STATUSES),
  basis: z.enum(E.SPLIT_BASES),
  /** Applies to payments succeeding in [startsAt, endsAt); endsAt null = until ended. */
  startsAt: Timestamp,
  endsAt: Timestamp.nullable(),
  shares: z.array(SplitShare),
  createdAt: Timestamp,
  acceptedAt: Timestamp.nullable(),
  endedAt: Timestamp.nullable(),
  /** The caller's own pending decision, when the caller is a recipient. */
  awaitingYou: z.boolean(),
});
export type RevenueSplit = z.infer<typeof RevenueSplit>;
/** A proposal to write off an owner's split-shortfall suspense balance (ADR 0013 decision 6; two approvers). */
export const SplitWriteOff = z.object({
  id: Id,
  owner: UserPublic.pick({ id: true, username: true }),
  amount: Money,
  status: z.enum(E.SPLIT_WRITEOFF_STATUSES),
  proposedBy: UserPublic.pick({ id: true, username: true }),
  proposedAt: Timestamp,
  approvedBy: UserPublic.pick({ id: true, username: true }).nullable(),
  approvedAt: Timestamp.nullable(),
});
export type SplitWriteOff = z.infer<typeof SplitWriteOff>;

/**
 * A recipient with withheld split shares (ADR 0013 decision 7). The username is the pseudonym for
 * a deleted account, so it still works with the `{username}/release` and `/forfeit` paths.
 */
export const SplitSuspenseRecipient = z.object({
  recipient: UserPublic.pick({ id: true, username: true }),
  withheld: Money,
  /** Still suspended, terminated, deleted or under a legal hold: a release is refused. */
  restricted: z.boolean(),
  /** Deleted or permanently terminated: the shares may be forfeited to the owners. */
  forfeitable: z.boolean(),
});
export type SplitSuspenseRecipient = z.infer<typeof SplitSuspenseRecipient>;

/** Rehearsal mode (decisions (f), (g)). */
export const RehearsalStatus = z.object({
  state: z.enum(["idle", "armed", "rehearsing"]),
  armId: Id.nullable(),
  /** Armed: when the arm lapses (TTL 10 min). */
  armExpiresAt: Timestamp.nullable(),
  /** Rehearsing: the open rehearsal broadcast and when the 30-minute cap ends it. */
  broadcastId: Id.nullable(),
  endsAt: Timestamp.nullable(),
  invitees: z.array(UserPublic.pick({ id: true, username: true, displayName: true })),
});
export type RehearsalStatus = z.infer<typeof RehearsalStatus>;
const RehearsalRuleCounts = z.object({
  wordFilter: z.number().int().nonnegative(),
  link: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  rateLimit: z.number().int().nonnegative(),
  other: z.number().int().nonnegative(),
});
export const RehearsalReport = z.object({
  broadcastId: Id,
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
  /** `safety`: a T0 hit ended it; the report says no more than that. */
  endReason: z.enum(["disarmed", "publisher_ended", "cap", "safety", "expired"]).nullable(),
  chat: z.object({
    accepted: z.number().int().nonnegative(),
    held: RehearsalRuleCounts,
    rejected: RehearsalRuleCounts,
  }),
  ingest: z.array(
    z.object({
      check: z.enum(["bitrate", "fps", "keyframe_interval", "dropped_frames", "audio", "video"]),
      ok: z.boolean(),
      /** When a dip started, if any. */
      dips: z.array(z.object({ at: Timestamp, seconds: z.number().int().nonnegative() })),
    }),
  ),
  moderation: z.object({ samples: z.number().int().nonnegative(), flagged: z.boolean() }),
  inviteesWatched: z.array(UserPublic.pick({ id: true, username: true })),
  updatedAt: Timestamp,
});
export type RehearsalReport = z.infer<typeof RehearsalReport>;
/** An invitee's (or the owner's) origin-only playback for a rehearsal, never through `liveBroadcastId`. */
export const RehearsalWatch = z.object({
  sessionId: Id,
  playlistUrl: z.string(),
  token: z.string(),
  expiresAt: Timestamp,
  heartbeatIntervalMs: z.number().int(),
});
export type RehearsalWatch = z.infer<typeof RehearsalWatch>;

/**
 * Creator Analytics (decision (k), feature-wins §4.9). Integer seconds and bytes; categories, never
 * signal codes, thresholds or user ids. Groups under `ANALYTICS_RULES.minGroupSessions` are omitted
 * and counted in `hiddenGroups`. Costs are marginal and owner-private.
 */
const AudienceTotals = z.object({
  verifiedViewerSeconds: z.number().int().nonnegative(),
  unverifiedViewerSeconds: z.number().int().nonnegative(),
  excludedViewerSeconds: z.number().int().nonnegative(),
  peakVerifiedConcurrent: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
});
const ExclusionGroup = z.object({
  category: z.enum(E.EXCLUSION_CATEGORIES),
  sessions: z.number().int().nonnegative(),
  viewerSeconds: z.number().int().nonnegative(),
});
const DeliveryMix = z.array(
  z.object({
    source: z.enum(E.DELIVERY_SOURCES),
    bytes: z.number().int().nonnegative(),
    verifiedViewerSeconds: z.number().int().nonnegative(),
  }),
);
export const BroadcastAnalytics = z.object({
  broadcastId: Id,
  title: z.string(),
  startedAt: Timestamp,
  endedAt: Timestamp,
  durationSeconds: z.number().int().nonnegative(),
  totals: AudienceTotals,
  /** One point per minute (verified, unverified, excluded concurrent sessions). */
  minutes: z.array(
    z.object({
      at: Timestamp,
      verified: z.number().int().nonnegative(),
      unverified: z.number().int().nonnegative(),
      excluded: z.number().int().nonnegative(),
    }),
  ),
  /** False once the per-minute rows aged out (90 days): only totals remain. */
  minutesRetained: z.boolean(),
  exclusions: z.array(ExclusionGroup),
  hiddenGroups: z.number().int().nonnegative(),
  delivery: DeliveryMix,
  /** Marginal cost of serving it (owner only; null on share links). */
  cost: Money.nullable(),
});
export type BroadcastAnalytics = z.infer<typeof BroadcastAnalytics>;
export const AnalyticsRange = z.object({
  from: Timestamp,
  to: Timestamp,
  totals: AudienceTotals,
  broadcasts: z.array(
    z.object({
      broadcastId: Id,
      title: z.string(),
      startedAt: Timestamp,
      durationSeconds: z.number().int().nonnegative(),
      totals: AudienceTotals,
    }),
  ),
  delivery: DeliveryMix,
  cost: Money.nullable(),
});
export type AnalyticsRange = z.infer<typeof AnalyticsRange>;
export const AnalyticsExclusions = z.object({
  from: Timestamp,
  to: Timestamp,
  groups: z.array(ExclusionGroup.extend({ broadcastId: Id })),
  hiddenGroups: z.number().int().nonnegative(),
});
export type AnalyticsExclusions = z.infer<typeof AnalyticsExclusions>;
export const AnalyticsPnl = z.object({
  from: Timestamp,
  to: Timestamp,
  /** Ledger revenue lines (read-only), net of reversals. */
  revenue: Money,
  /** Marginal serving cost from the rollup and `INFRA_COST_MODEL`. */
  cost: Money,
  net: Money,
  byBroadcast: z.array(z.object({ broadcastId: Id, revenue: Money, cost: Money })),
});
export type AnalyticsPnl = z.infer<typeof AnalyticsPnl>;
export const AnalyticsShareLink = z.object({
  id: Id,
  broadcastId: Id,
  /** The full link, returned once on create (the token is stored hashed); null on reads. */
  url: z.string().nullable(),
  expiresAt: Timestamp,
  revokedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type AnalyticsShareLink = z.infer<typeof AnalyticsShareLink>;

/**
 * Signed audience attestations (ADR 0014). `envelope` is exactly what was signed: base64url payload
 * bytes and signature (`@commonair/tokens/attestation`); verifiers verify the bytes first and
 * parse after. `breakdown` and `salt` reveal the reasons commitment: owner or share link only.
 */
/**
 * Lengths only: a verifier must answer `malformed` (not a 400) for a padded or non-base64url
 * payload, so the charset is the verifier's to judge.
 */
export const AttestationEnvelope = z.object({
  payload: z.string().min(1).max(8192),
  signature: z.string().min(1).max(256),
});
/** Lowercase hex SHA-256: `entryHash`, `prevHash` and `supersedes` (`@commonair/tokens/attestation`). */
const AttestationHash = z.string().regex(/^[0-9a-f]{64}$/);
/** base64url of the first 16 bytes of SHA-256 over the raw public key (`deriveKid`). */
export const AttestationKid = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export const AttestationEntry = z.object({
  id: Id,
  channelSlug: Slug,
  broadcastId: Id,
  seq: z.number().int().positive(),
  kind: z.enum(E.ATTESTATION_KINDS),
  kid: AttestationKid,
  entryHash: AttestationHash,
  prevHash: AttestationHash.nullable(),
  supersedes: AttestationHash.nullable(),
  signedAt: Timestamp,
  envelope: AttestationEnvelope,
  /** A later entry for the same broadcast replaces this one (it still verifies). */
  superseded: z.boolean(),
  /** Owner only: categories with a value above 0 (the committed map, `reasonsCommitment`); null otherwise. */
  breakdown: z.partialRecord(z.enum(E.EXCLUSION_CATEGORIES), z.number().int().nonnegative()).nullable(),
  salt: z.string().nullable(),
});
export type AttestationEntry = z.infer<typeof AttestationEntry>;
export const AttestationKey = z.object({
  kid: AttestationKid,
  algorithm: z.literal("Ed25519"),
  /** Raw 32-byte public key, base64url without padding. */
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  firstUsedAt: Timestamp,
  retiredAt: Timestamp.nullable(),
  compromisedAt: Timestamp.nullable(),
});
export type AttestationKey = z.infer<typeof AttestationKey>;
/** `/.well-known/commonair-attestation`: the instance origin and its full key history. */
export const AttestationKeyHistory = z.object({ origin: z.string(), keys: z.array(AttestationKey) });
export type AttestationKeyHistory = z.infer<typeof AttestationKeyHistory>;
/**
 * A public window proof (ADR 0014 decision 6): contiguous entries of one channel, oldest first,
 * with `breakdown` and `salt` null, plus the key history to verify them offline.
 */
export const AttestationBundle = z.object({ entries: z.array(AttestationEntry), keys: AttestationKeyHistory });
export type AttestationBundle = z.infer<typeof AttestationBundle>;
/** An attestation share link (the breakdown reveal); the token is stored hashed. */
export const AttestationShareLink = z.object({
  id: Id,
  attestationId: Id,
  /** The full link, returned once on create; null on reads. */
  url: z.string().nullable(),
  expiresAt: Timestamp,
  revokedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type AttestationShareLink = z.infer<typeof AttestationShareLink>;
export const AttestationVerifyResult = z.object({
  valid: z.boolean(),
  /** Why not, when `valid` is false. */
  problem: z
    .enum([
      // `@commonair/tokens/attestation` `verify` errors, passed through as they are.
      "malformed",
      "non_canonical",
      "bad_signature",
      "kid_mismatch",
      "unknown_kid",
      "compromised_kid",
      // Checks the API adds: the signing origin, bundle chain links, a replaced entry.
      "wrong_origin",
      "chain_break",
      "superseded",
    ])
    .nullable(),
  origin: z.string().nullable(),
  /** The parsed statement, only once the signature verified. */
  statement: z.record(z.string(), z.unknown()).nullable(),
});
export type AttestationVerifyResult = z.infer<typeof AttestationVerifyResult>;

/**
 * The public enforcement report (decision (d), ADR 0019). A cell under `ENFORCEMENT_REPORT_RULES.k`
 * is `{suppressed: true}`, never a number; zero is not suppressed. Ratios are integer numerator
 * and denominator; the client divides.
 */
export const ReportCount = z.discriminatedUnion("suppressed", [
  z.object({ suppressed: z.literal(false), value: z.number().int().nonnegative() }),
  z.object({ suppressed: z.literal(true) }),
]);
export type ReportCount = z.infer<typeof ReportCount>;
export const EnforcementReportRow = z.object({
  /** `<clause id>@<version>`. */
  ruleRef: z.string(),
  clauseId: z.string(),
  clauseVersion: z.number().int().positive(),
  /** The clause's plain-language title in the request locale (the web has no clause catalog). */
  clauseTitle: z.string(),
  group: z.enum(["safety", "decency", "honesty", "creative", "mature", "illegal", "general"]),
  tier: z.enum(E.MODERATION_TIERS).nullable(),
  count: ReportCount,
  automatedDecision: z.object({ fully: ReportCount, partially: ReportCount, not: ReportCount }),
  automatedDetection: ReportCount,
  appealed: ReportCount,
  overturned: ReportCount,
});
export const EnforcementReport = z.object({
  window: z.union([z.literal("30d"), z.string().regex(/^\d{4}-\d{2}$/)]),
  from: Timestamp,
  to: Timestamp,
  rows: z.array(EnforcementReportRow),
  total: ReportCount,
  ncii: z.object({ due: ReportCount, onTime: ReportCount, late: ReportCount }),
  generatedAt: Timestamp,
});
export type EnforcementReport = z.infer<typeof EnforcementReport>;

// Batch 7: W3, N3, N4 (.claude/briefs/w3/contract-step.md §2.4) -----------------------------

/** A person as the batch 7 surfaces show them (`ChannelAvatar` data). */
const AvatarUser = UserPublic.pick({ id: true, username: true, displayName: true, avatarUrl: true });
const ChannelBrief = z.object({ id: Id, slug: Slug, displayName: z.string(), avatarUrl: z.string().nullable() });

/** Watch rooms (ADR 0017, decision (q)). Every room is invite-only in v1. */
export const WatchRoomMember = z.object({ user: AvatarUser, joinedAt: Timestamp, host: z.boolean() });
export const WatchRoom = z.object({
  id: Id,
  channel: ChannelBrief,
  broadcastId: Id,
  host: AvatarUser,
  ageBand: z.enum(E.ROOM_AGE_BANDS),
  /** The room is on mature content: adults only, each with mature viewing confirmed. */
  mature: z.boolean(),
  /** Active members (the database caps them at `ROOM_LIMITS.maxMembers`). */
  members: z.array(WatchRoomMember).max(E.ROOM_LIMITS.maxMembers),
  createdAt: Timestamp,
  endedAt: Timestamp.nullable(),
  endReason: z.enum(E.ROOM_END_REASONS).nullable(),
  /** The audience the room's chat token is bound to (`room:<id>`); the chat service checks it. */
  chatAudience: z.string(),
});
export type WatchRoom = z.infer<typeof WatchRoom>;
/** An invite: the nonce is shown once (stored as its hash); the link carries it. */
export const WatchRoomInvite = z.object({ nonce: z.string(), url: z.string(), expiresAt: Timestamp.nullable() });
export const WatchRoomJoined = z.object({
  room: WatchRoom,
  /** For `room.join` on the chat WebSocket. */
  chatToken: z.string(),
  chatUrl: z.string(),
  expiresAt: Timestamp,
});
/** Why a room create or join was refused (the API's error data and the web's i18n codes). */
export const WATCH_ROOM_REFUSALS = [
  "room_age_band",
  "room_birth_date_unknown",
  "room_mature_minor",
  "room_mature_unconfirmed",
  "room_banned",
  "room_suspended",
  "room_blocked",
  "room_full",
  "room_closed",
  "room_invite_invalid",
  "room_not_live",
] as const;

/** Move links (decision (k)). */
export const MoveLink = z.object({
  id: Id,
  createdAt: Timestamp,
  revokedAt: Timestamp.nullable(),
  expiresAt: Timestamp.nullable(),
  /** Non-excluded follows made through this link. */
  conversions: z.number().int().nonnegative(),
});
export type MoveLink = z.infer<typeof MoveLink>;
/** The nonce and URL are returned once, at create. */
export const MoveLinkCreated = MoveLink.extend({ nonce: z.string(), url: z.string() });
export const MoveLinkResolution = z.object({
  state: z.enum(["active", "revoked", "expired", "unknown"]),
  /** Null when the link is unknown. */
  channel: ChannelBrief.extend({ title: z.string(), followerCount: z.number().int().nonnegative() }).nullable(),
});
export const PortabilityGrant = z.object({ channel: ChannelBrief, createdAt: Timestamp });
export const ChannelMove = z.object({ movedTo: z.string().nullable(), movedAt: Timestamp.nullable() });
/** One item of an import's preview or result. Reasons are opaque codes, never upload-matching detail. */
export const ImportItem = z.object({
  kind: z.enum(E.IMPORT_ITEM_KINDS),
  /** The emote code, the panel's position, or `channel` / `schedule`. */
  ref: z.string(),
  label: z.string(),
  outcome: z.enum(E.IMPORT_ITEM_OUTCOMES).nullable(),
  reason: z.string().max(64).nullable(),
});
export const PortabilityImport = z.object({
  id: Id,
  source: z.enum(E.PORTABILITY_SOURCES),
  status: z.enum(E.IMPORT_STATUSES),
  /** Null for Twitch bundles (no statement); false = "standing not verified" (decision (o)). */
  standingVerified: z.boolean().nullable(),
  /** The issuing instance of a verified statement. */
  standingIssuer: z.string().nullable(),
  /** Public data only. */
  preview: z.object({ channel: z.record(z.string(), z.unknown()), items: z.array(ImportItem) }),
  result: z.array(ImportItem).nullable(),
  /** Emote art re-hosted on the streamer's assertion (ADR 0031): when and which wording version. */
  assertedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  finishedAt: Timestamp.nullable(),
});
export type PortabilityImport = z.infer<typeof PortabilityImport>;
/** What `imports.start` applies: the channel fields, panels, and the emote codes chosen. */
export const ImportChoices = z.object({
  channel: z.boolean(),
  panels: z.boolean(),
  emotes: z.array(z.string().regex(/^[A-Za-z0-9]{2,20}$/)).max(100),
});
export const PresignedUpload = z.object({
  key: z.string(),
  uploadUrl: z.string(),
  headers: z.record(z.string(), z.string()),
  expiresAt: Timestamp,
});

/** Giveaways (decision (t)). Entrants are shown only as pseudonyms. */
export const Giveaway = z.object({
  id: Id,
  channelSlug: Slug,
  title: z.string(),
  prize: z.string(),
  winnerCount: z.number().int().min(1).max(E.GIVEAWAY_RULES.maxWinners),
  keyword: z.string().nullable(),
  status: z.enum(E.GIVEAWAY_STATUSES),
  eligibility: GiveawayEligibility,
  /** SHA-256 of the seed, published at open, before any entry. */
  seedCommitment: z.string(),
  opensAt: Timestamp,
  closesAt: Timestamp.nullable(),
  drawnAt: Timestamp.nullable(),
  entries: z.number().int().nonnegative(),
  /** The signed-in caller: entered, and if not, whether they may and why not. */
  me: z
    .object({
      entered: z.boolean(),
      /**
       * The caller's own pseudonym once entered, so they can find themselves in the public entry
       * list. Only ever shown to that member: the salt that would map pseudonyms to accounts is
       * never published.
       */
      pseudonym: z.string().nullable(),
      eligible: z.boolean(),
      reason: z.enum(["account_age", "follow_age", "not_following", "verified_watch", "banned"]).nullable(),
      won: z.boolean(),
    })
    .nullable(),
  winners: z.array(z.object({ rank: z.number().int().positive(), pseudonym: z.string() })),
});
export type Giveaway = z.infer<typeof Giveaway>;
/**
 * `interact.giveaways.verify` (public): everything needed to re-run the draw (the seed and the
 * sorted pseudonyms). The pseudonym salt is never included: user ids are public, so the salt would
 * let anyone compute every member's pseudonym and see who entered and who won.
 */
export const GiveawayVerification = z.object({
  id: Id,
  channelSlug: Slug,
  title: z.string(),
  status: z.enum(E.GIVEAWAY_STATUSES),
  seedCommitment: z.string(),
  /** Revealed at the draw; null before. */
  seed: z.string().nullable(),
  /** Entry pseudonyms, sorted (the draw's input order). */
  entries: z.array(z.string()),
  winnerCount: z.number().int(),
  winners: z.array(
    z.object({
      rank: z.number().int().positive(),
      /** Index into `entries`. */
      index: z.number().int().nonnegative(),
      pseudonym: z.string(),
      /** Only when the winner allowed it; the pseudonym otherwise. */
      username: Slug.nullable(),
    }),
  ),
  drawnAt: Timestamp.nullable(),
});
export type GiveawayVerification = z.infer<typeof GiveawayVerification>;

/** The advisory jury (decision (u)). */
export const JuryStatus = z.object({
  /** The `jury.enabled` governance setting. */
  enabled: z.boolean(),
  /** An active, adult member, not staff. */
  eligible: z.boolean(),
  optedIn: z.boolean(),
  optedInAt: Timestamp.nullable(),
  /** The panel the caller sits on now, if any. */
  seat: z.object({ panelId: Id, period: z.string() }).nullable(),
});
export const JuryPanel = z.object({
  id: Id,
  /** `YYYY-MM`. */
  period: z.string().regex(/^\d{4}-\d{2}$/),
  seedCommitment: z.string(),
  seed: z.string().nullable(),
  openedAt: Timestamp,
  closedAt: Timestamp.nullable(),
  seats: z.number().int().nonnegative(),
  cases: z.number().int().nonnegative(),
});
export const JuryEvidence = z.object({
  kind: z.enum(["text", "image"]),
  /** Text excerpt, or a short-lived URL of the blurred-by-default image. */
  value: z.string(),
  contentWarning: z.boolean(),
});
export const JuryCase = z.object({
  id: Id,
  subjectKind: z.enum(E.JURY_SUBJECT_KINDS),
  ruleRef: z.string().nullable(),
  clauseTitle: z.string().nullable(),
  tier: z.enum(E.MODERATION_TIERS).nullable(),
  /** What was decided: the case status or the report resolution. */
  outcome: z.string(),
  automated: z.boolean(),
  /** Stable within the panel; never a username. Reporters are never shown. */
  subjectPseudonym: z.string(),
  evidence: z.array(JuryEvidence).max(20),
  myVote: z.object({ vote: z.enum(E.JURY_VOTES), reasonCode: z.enum(E.JURY_REASON_CODES) }).nullable(),
});
export type JuryCase = z.infer<typeof JuryCase>;
export const JuryResults = z.object({
  period: z.string(),
  panelSize: z.number().int(),
  seedCommitment: z.string().nullable(),
  seed: z.string().nullable(),
  rows: z.array(
    z.object({
      clauseId: z.string(),
      clauseTitle: z.string(),
      tier: z.enum(E.MODERATION_TIERS).nullable(),
      agree: ReportCount,
      disagree: ReportCount,
      unsure: ReportCount,
    }),
  ),
});
export type JuryResults = z.infer<typeof JuryResults>;
export const JuryFlag = z.object({
  id: Id,
  caseId: Id,
  panelId: Id,
  subjectKind: z.enum(E.JURY_SUBJECT_KINDS),
  subjectId: Id,
  disagree: z.number().int(),
  votes: z.number().int(),
  createdAt: Timestamp,
  resolvedAt: Timestamp.nullable(),
});

/** Twitch import (N3, decision (b)). */
export const TwitchImportStatus = z.object({
  /** `OAUTH_TWITCH_*` set and `TWITCH_IMPORT_ENABLED`. */
  available: z.boolean(),
  /** A Twitch identity is linked for this session's import. */
  connected: z.boolean(),
  twitchLogin: z.string().nullable(),
  /** The latest import of the caller's channel, if any. */
  latest: PortabilityImport.nullable(),
});

/** Federation (ADR 0030, decision (c)). */
export const FederationSettings = z.object({
  /** The channel's own `federation.enabled`. */
  enabled: z.boolean(),
  /** FEDERATION_ENABLED on this instance. */
  instanceEnabled: z.boolean(),
  /** `@<slug>@<domain>` while federated. */
  handle: z.string().nullable(),
  actorId: z.string().nullable(),
  followers: z.number().int().nonnegative(),
});
export const FederationFollower = z.object({
  id: Id,
  /** The remote actor id (a URL). Shown only to the channel owner. */
  actor: z.string(),
  handle: z.string().nullable(),
  domain: z.string(),
  createdAt: Timestamp,
});
export const FederationDomainBlock = z.object({
  domain: z.string(),
  createdBy: UserPublic.pick({ id: true, username: true }).nullable(),
  createdAt: Timestamp,
});

/**
 * The relay purge feed (decision (x), ADR 0016 Amendment 1): `relays.purges`, long-polled by
 * relays. The answer is the `SignedPurgeBatch` envelope of `packages/tokens` (`purge.ts`):
 * `payload` is the base64url of the canonical JSON of a `RelayPurgeBatch`, `signature` the
 * base64url Ed25519 signature over those bytes with the origin playback key. Relays verify the
 * bytes with the heartbeat's `originPublicKey` before parsing them.
 *
 * Contracts may not import `packages/tokens` (it depends on contracts), so `RelayPurgeBatch`
 * mirrors its `PurgeBatch`; `packages/tokens/tests/contracts-shapes.test.ts` keeps them equal.
 */
/** A relay cache path prefix ending in "/" (`dvr/<vodId>/`, `live/<slug>/`, `live/<slug>/captions/`); no `..`. */
export const RELAY_PURGE_PREFIX = /^(?:live|dvr)\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)+$/;
/** The wire rule for a reason code; the origin writes only `RELAY_PURGE_REASONS`. */
export const RELAY_PURGE_REASON = /^[a-z][a-z0-9_]{0,31}$/;
const purgeSeq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const RelayPurgeItem = z.strictObject({
  seq: purgeSeq.min(1),
  prefix: z.string().max(E.RELAY_PURGE_RULES.prefixMaxLength).regex(RELAY_PURGE_PREFIX),
  reason: z.string().regex(RELAY_PURGE_REASON),
});
export type RelayPurgeItem = z.infer<typeof RelayPurgeItem>;
/** The signed payload. Key order is the canonical byte order. */
export const RelayPurgeBatch = z
  .strictObject({
    /** The cursor: the last item's seq, or the request's `after` when there are no items. */
    seq: purgeSeq,
    /** Strictly ascending by seq. */
    items: z.array(RelayPurgeItem).max(E.RELAY_PURGE_RULES.maxItems),
    /**
     * Present only when true: `after` is older than the retained rows (more than
     * `RELAY_PURGE_RULES.retentionDays` behind). No items; the relay evicts every cached `live/`
     * and `dvr/` object and continues from `seq`.
     */
    reset: z.literal(true).optional(),
  })
  .superRefine((b, ctx) => {
    if (b.reset && b.items.length > 0)
      ctx.addIssue({ code: "custom", path: ["items"], message: "a reset carries no items" });
    for (let i = 1; i < b.items.length; i++)
      if ((b.items[i] as RelayPurgeItem).seq <= (b.items[i - 1] as RelayPurgeItem).seq)
        ctx.addIssue({ code: "custom", path: ["items", i, "seq"], message: "items are not strictly ascending" });
    const last = b.items.at(-1);
    if (last && last.seq !== b.seq)
      ctx.addIssue({ code: "custom", path: ["seq"], message: "seq is not the last item's" });
  });
export type RelayPurgeBatch = z.infer<typeof RelayPurgeBatch>;
export const RelayPurgeFeed = z.object({
  /** base64url (no padding) of the canonical JSON of a `RelayPurgeBatch`. */
  payload: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9_-]+$/),
  /** Ed25519 over the payload bytes, base64url. */
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export type RelayPurgeFeed = z.infer<typeof RelayPurgeFeed>;
