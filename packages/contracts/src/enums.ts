// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Closed value sets shared by the database (pgEnum), Zod schemas, and clients.
 * Adding a value requires a migration (`ALTER TYPE … ADD VALUE`); removing one is a
 * breaking change to the public API.
 */

export const ACCOUNT_TYPES = ["human", "bot"] as const;
/**
 * `legal`: staff with a legal need to see T0 material (ADR 0006): T0 cases, evidence, NCMEC
 * drafts and holds. It is the only role that can view them; it does not imply `moderator`.
 */
export const PLATFORM_ROLES = ["user", "moderator", "admin", "treasurer", "legal"] as const;
export const CHANNEL_ROLES = ["moderator", "vip", "editor"] as const;
/** Chat permission levels, lowest to highest. */
export const USER_LEVELS = ["everyone", "follower", "subscriber", "vip", "moderator", "broadcaster"] as const;

export const INGEST_PROTOCOLS = ["rtmp", "whip", "srt", "rtsp"] as const;
export const DELIVERY_SOURCES = ["origin", "relay", "p2p", "cdn"] as const;
export const RENDITIONS = ["source", "1080p", "720p", "480p", "audio"] as const;

export const VOD_STATUSES = ["recording", "processing", "ready", "failed", "deleted"] as const;
/** Stable `vods.failed_reason` codes (services/media/README.md "VOD failure codes"). */
export const VOD_FAILED_REASONS = ["no_segments", "finalize_stalled"] as const;
/**
 * Stream-health warning codes services/media puts in `HealthSample.warnings`; the web catalog
 * has a title and fix hint for each.
 */
export const HEALTH_WARNING_CODES = [
  "bitrate_high",
  "bitrate_low",
  "keyframe_interval",
  "fps_drop",
  "b_frames_webrtc",
  "audio_missing",
  "video_missing",
  "video_codec_unsupported",
  "audio_codec_unsupported",
  "transcode_capacity",
  "recording_disk_budget",
] as const;
export type HealthWarningCode = (typeof HEALTH_WARNING_CODES)[number];
export const VISIBILITIES = ["public", "subscribers", "private"] as const;
export const CLIP_STATUSES = ["processing", "ready", "failed", "deleted"] as const;
export const SIMULCAST_PLATFORMS = ["twitch", "youtube", "custom"] as const;
export const SIMULCAST_STATUSES = ["idle", "connecting", "live", "error", "stopped"] as const;

export const SESSION_VERDICTS = ["pending", "verified", "excluded"] as const;
export const RELAY_STATUSES = ["pending", "active", "degraded", "suspended", "offline"] as const;
export const RECEIPT_STATUSES = ["pending", "verified", "rejected"] as const;

export const WORD_FILTER_ACTIONS = ["block", "hold", "replace"] as const;

export const SUB_TIERS = [1, 2, 3] as const;
export const SUBSCRIPTION_STATUSES = ["incomplete", "active", "past_due", "canceled", "expired"] as const;
export const PAYMENT_PROVIDERS = ["manual", "stripe"] as const;
export const PAYMENT_KINDS = ["subscription", "tip", "membership_share"] as const;
export const PAYMENT_STATUSES = [
  "pending",
  "succeeded",
  "failed",
  "refunded",
  "partially_refunded",
  "charged_back",
] as const;
export const DISPUTE_KINDS = ["refund", "chargeback"] as const;
export const DISPUTE_STATUSES = ["open", "won", "lost", "closed"] as const;
export const PAYOUT_STATUSES = ["pending", "scheduled", "paid", "failed", "held"] as const;
/** Rows on a creator's revenue ledger (`money.revenueLedger`): one per payment, reversal or payout. */
export const REVENUE_LINE_TYPES = ["subscription", "gift", "tip", "refund", "chargeback", "payout"] as const;

export const LEDGER_ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const;

export const MEMBER_CLASSES = ["streamer", "viewer", "worker"] as const;
export const MEMBERSHIP_STATUSES = ["active", "lapsed", "exited"] as const;
export const MEMBERSHIP_BASES = ["streaming_hours", "share", "subscription", "board_appointment"] as const;
/** `refund_pending`: the member exited and the treasurer owes the refund; `cancelled`: the payment expired unpaid (ADR 0020). */
export const SHARE_STATUSES = ["pending", "held", "refund_pending", "refunded", "cancelled"] as const;

export const PROPOSAL_KINDS = ["ordinary", "protected"] as const;
export const PROPOSAL_STATUSES = [
  "draft",
  "discussion",
  "council_review",
  "voting",
  "passed",
  "rejected",
  "withdrawn",
  "applied",
] as const;
export const VOTE_CHOICES = ["yes", "no", "abstain"] as const;
export const COUNCIL_STANCES = ["support", "oppose", "mixed", "neutral"] as const;
export const ELECTION_STATUSES = ["nominating", "voting", "closed"] as const;

export const PATRONAGE_STATUSES = ["draft", "computed", "approved", "distributed"] as const;

export const INTEGRITY_SUBJECTS = ["session", "user", "channel", "relay", "follow", "chat_message", "raid"] as const;
export const INTEGRITY_DECISIONS = ["pending_review", "excluded", "allowed"] as const;
export const APPEAL_KINDS = ["integrity", "moderation", "dmca", "account"] as const;
/**
 * What an appeal is about. Integrity appeals use `session`, `user` or `integrity_flag` (the
 * integrity allowance rules read exactly these); the others name the decision's own table.
 */
export const APPEAL_SUBJECTS = [
  "session",
  "user",
  "integrity_flag",
  "moderation_action",
  "dmca_notice",
  "account_action",
  /** A moderation label (T2 mature label, ADR 0006); overturning removes it. */
  "content_label",
  /** A T1 moderation case decided by a moderator. */
  "moderation_case",
  /**
   * An NCII request item (`ncii_request_items`) covering content the appellant owns, appealing its
   * removal or auto-hide (ADR 0019 answer 4). The requester is never told who appealed.
   */
  "ncii_request_item",
] as const;
export const APPEAL_STATUSES = ["open", "upheld", "overturned"] as const;
export const ACTOR_TYPES = ["user", "moderator", "admin", "system", "bot", "app"] as const;

export const REPORT_SUBJECTS = ["user", "channel", "chat_message", "vod", "clip", "broadcast"] as const;
export const REPORT_REASONS = [
  "spam",
  "harassment",
  "hate",
  "sexual_content",
  "minor_safety",
  "violence",
  "self_harm",
  "illegal",
  "impersonation",
  "copyright",
  "unlabeled_mature",
  /** Non-consensual intimate imagery (the public takedown form is `ncii.submit`). */
  "ncii",
  "other",
] as const;
export const REPORT_STATUSES = ["open", "actioned", "dismissed"] as const;
export const MOD_ACTIONS = [
  "ban",
  "unban",
  "timeout",
  "untimeout",
  "delete_message",
  "clear_chat",
  "slow_mode",
  "followers_only",
  "subscribers_only",
  "emote_only",
  "add_moderator",
  "remove_moderator",
  "add_vip",
  "remove_vip",
  "suspend_channel",
  "unsuspend_channel",
  "suspend_user",
  "unsuspend_user",
  "remove_content",
  "restore_content",
  "end_stream",
  "warn",
] as const;
export const MOD_SCOPES = ["channel", "platform"] as const;
export const DMCA_STATUSES = ["received", "actioned", "rejected", "countered", "restored"] as const;
/** Platform decisions about an account that are not channel or platform mod actions (`account_actions`). */
export const ACCOUNT_ACTIONS = ["dmca_strike", "dmca_termination"] as const;
/** Why an account action was reversed. */
export const ACCOUNT_ACTION_REVERSALS = [
  "appeal_overturned",
  "counter_notice_restored",
  "strikes_below_threshold",
] as const;
/** What a DMCA notice URL can resolve to (anything else stays unresolved; staff handle it by hand). */
export const DMCA_ITEM_SUBJECTS = ["vod", "clip", "broadcast"] as const;
/**
 * DMCA policy constants (17 U.S.C. § 512; not reviewed by a lawyer). `restoreWeekdays`: content
 * comes back 12 weekdays after a counter-notice, which is never fewer than 10 nor more than 14
 * business days even with two federal holidays in the window (§ 512(g)(2)(C)). Repeat infringers:
 * `repeatInfringerStrikes` unreversed strikes within `strikeWindowDays` suspend the account
 * (an `account_actions` `dmca_termination`, appealable); 0 turns the automatic suspension off
 * (moderators are notified only).
 */
export const DMCA_RULES = { restoreWeekdays: 12, repeatInfringerStrikes: 3, strikeWindowDays: 365 } as const;

/**
 * `enforcement_notice` (ADR 0019 decision 2): the operator-editable wording of statements of
 * reasons, one section per clause; never needs acceptance. A published version is immutable.
 */
export const LEGAL_DOCUMENT_KINDS = [
  "terms",
  "privacy",
  "guidelines",
  "cookies",
  "dmca_policy",
  "enforcement_notice",
] as const;
export const EXPORT_KINDS = ["account", "channel"] as const;
export const JOB_STATUSES = ["queued", "running", "ready", "failed", "expired"] as const;
export const DELETION_STATUSES = ["scheduled", "canceled", "completed"] as const;

export const EVENT_TRANSPORTS = ["webhook", "websocket"] as const;
export const SUBSCRIPTION_STATES = ["enabled", "verification_pending", "failed", "revoked"] as const;
export const DELIVERY_STATUSES = ["pending", "succeeded", "failed"] as const;

export const POLL_STATUSES = ["active", "completed", "terminated", "archived"] as const;
export const PREDICTION_STATUSES = ["active", "locked", "resolved", "canceled"] as const;
export const RAID_STATUSES = ["pending", "completed", "canceled"] as const;
export const ALERT_TYPES = ["follow", "subscription", "tip", "raid"] as const;
export const GOAL_TYPES = ["followers", "subscriptions", "tips"] as const;
export const SONG_REQUEST_STATUSES = ["queued", "played", "skipped"] as const;
/** Why points moved (`loyalty_transactions.reason`, ADR 0026 decision 2). The sign is checked by the database. */
export const LOYALTY_REASONS = [
  "watch",
  "command",
  "prediction_bet",
  "prediction_payout",
  "prediction_refund",
  "poll_vote",
  "moderator_adjust",
] as const;
/** `bot.points.adjust`: a reason code for the audit row, never free text (ADR 0026 decision 2). */
export const POINTS_ADJUST_REASONS = ["correction", "reward", "penalty", "other"] as const;
/** Who may raid a channel (`channels.raid_policy`, ADR 0026 decision 4). */
export const RAID_POLICIES = ["anyone", "followed", "off"] as const;
/** Why a raid ended without executing. */
export const RAID_CANCEL_REASONS = [
  "owner",
  "target_offline",
  "target_refused",
  "suspended",
  "source_offline",
] as const;
/**
 * Raid timing (ADR 0026 decision 4: "an instance constant in the API config"). The countdown
 * runs from `start` to `executeAt`; a channel can start another raid `cooldownSeconds` after its
 * last raid completed or was canceled.
 */
export const RAID_RULES = { countdownSeconds: 30, cooldownSeconds: 600 } as const;
/** Poll limits beyond the router's per-call input bounds. */
export const POLL_RULES = { maxExtraVotesPerUser: 100 } as const;
/** Command names the bot engine answers itself; `bot.commands.upsert` refuses them and their use as aliases. */
export const BOT_BUILTIN_COMMANDS = ["points", "sr", "commands"] as const;
/** What a `BotControlMessage` tells the chat service to reload. */
export const BOT_CONTROL_SCOPES = ["config", "commands", "timers", "variables"] as const;

export const NOTIFICATION_TYPES = [
  "go_live",
  "raid",
  "proposal",
  "vote_open",
  "export_ready",
  "payout",
  "moderation",
  "system",
] as const;
export const INCIDENT_STATUSES = ["investigating", "identified", "monitoring", "resolved"] as const;
export const COMPONENT_STATUSES = ["operational", "degraded", "outage"] as const;

// Trust & safety (ADR 0006, docs/testing/e4c-selectors.md) ---------------------------------

/** Classifier categories. A provider may leave any of them unscored (never reported as 0). */
export const MODERATION_CATEGORIES = ["sexual", "graphic_violence", "weapons", "self_harm"] as const;
export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];
/** Operator hash lists by what they contain; the T0 action and the NCMEC draft follow the list. */
export const HASH_LIST_CATEGORIES = ["csam", "ncii"] as const;
export type HashListCategory = (typeof HASH_LIST_CATEGORIES)[number];
export const MODERATION_TIERS = ["t0", "t1", "t2"] as const;
export type ModerationTier = (typeof MODERATION_TIERS)[number];
/** What a frame or file came from. `upload` covers avatars, banners, panels, emotes and alert images. */
export const MODERATION_SUBJECTS = ["broadcast", "vod", "clip", "upload"] as const;
export const MODERATION_CASE_STATUSES = [
  "open",
  /** T2: the label is applied; the case closes as cleared if an appeal overturns it. */
  "labelled",
  "cleared",
  "actioned",
  /** T0 only: the first of two `legal` reviewers dismissed it. */
  "dismissal_pending",
  "dismissed",
  "confirmed",
] as const;
/** Where a case came from: a hash list, the classifier, or a human escalation. */
export const MODERATION_CASE_ORIGINS = ["hash_list", "classifier", "human"] as const;
export const MODERATION_REVIEW_DECISIONS = ["clear", "warn", "end_stream", "suspend", "escalate_legal"] as const;
export const CONTENT_LABELS = ["mature"] as const;
export const LEGAL_HOLD_REASONS = [
  "csam_match",
  "ncii_match",
  "csam_confirmed",
  "law_enforcement",
  "litigation",
] as const;
export const EVIDENCE_KINDS = ["frame", "upload", "vod_object", "clip_object", "thumbnail"] as const;
export const EVIDENCE_STORAGE = ["inline", "bucket"] as const;
export const NCMEC_REPORT_STATUSES = ["draft", "filed", "withdrawn"] as const;
export const NCII_RELATIONSHIPS = ["self", "representative"] as const;
export const NCII_STATUSES = ["received", "removed", "rejected", "auto_hidden"] as const;
export const NCII_DECISIONS = ["removed", "rejected"] as const;

// Statements of reasons (ADR 0019, DSA Art. 17; docs/testing/w0-selectors.md) ----------------

/** What a statement is about. */
export const ENFORCEMENT_CONTENT_TYPES = ["broadcast", "vod", "clip", "upload", "channel", "account"] as const;
/** Art. 17(3)(a): the kind of restriction. `warning` restricts nothing (kept for a complete record). */
export const ENFORCEMENT_RESTRICTION_KINDS = ["visibility", "service", "account", "warning"] as const;
export const ENFORCEMENT_RESTRICTION_DETAILS = [
  "removed",
  "disabled",
  "restricted",
  "age_gated",
  "suspended",
  "none",
] as const;
/** Art. 17(3)(b): the provider's own initiative, or an Art. 16 notice (NCII requests). */
export const ENFORCEMENT_SOURCES = ["own_initiative", "notice_art16"] as const;
/** Art. 17(3)(c): how far automated means took the decision. */
export const ENFORCEMENT_AUTOMATED_DECISIONS = ["fully", "partially", "not"] as const;
/** Art. 17(3)(d)/(e): a terms (contractual) or an illegal-content ground. */
export const ENFORCEMENT_GROUNDS = ["terms", "illegal"] as const;
/** The `facts.code` discriminator of `EnforcementFacts`. */
export const ENFORCEMENT_FACT_CODES = ["classifier", "moderator_review", "ncii_notice", "hash_match"] as const;
export const ENFORCEMENT_DELIVERY_CHANNELS = ["email", "in_app"] as const;
/**
 * The audit actions that may produce a statement (ADR 0019 decision 3); the builder selects
 * `audit_log` rows by exactly these names. Channel-moderator actions never write any of them.
 * `moderation.case.suspend` yields one statement per target; `ncii.decide` yields statements
 * only when the decision is `removed`, one per affected item (to its owner). The builder and the coverage sweep keep
 * only NCII-list `moderation.t0.match` rows (`details.listCategory = 'ncii'`): a CSAM-list match
 * never produces a statement (accepted answer 1, counsel to confirm).
 */
export const ENFORCEMENT_SOURCE_ACTIONS = [
  "moderation.t1.restrict",
  "moderation.t2.label",
  "moderation.t1.upload_reject",
  "moderation.case.warn",
  "moderation.case.end_stream",
  "moderation.case.suspend",
  "ncii.decide",
  "ncii.auto_hide",
  "moderation.t0.match",
] as const;
