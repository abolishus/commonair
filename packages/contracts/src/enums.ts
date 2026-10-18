// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Closed value sets shared by the database (pgEnum), Zod schemas, and clients.
 * Adding a value requires a migration (`ALTER TYPE … ADD VALUE`); removing one is a
 * breaking change to the public API.
 */

export const ACCOUNT_TYPES = ["human", "bot"] as const;
export const PLATFORM_ROLES = ["user", "moderator", "admin", "treasurer"] as const;
export const CHANNEL_ROLES = ["moderator", "vip", "editor"] as const;
/** Chat permission levels, lowest to highest. */
export const USER_LEVELS = ["everyone", "follower", "subscriber", "vip", "moderator", "broadcaster"] as const;

export const INGEST_PROTOCOLS = ["rtmp", "whip", "srt", "rtsp"] as const;
export const DELIVERY_SOURCES = ["origin", "relay", "p2p", "cdn"] as const;
export const RENDITIONS = ["source", "1080p", "720p", "480p", "audio"] as const;

export const VOD_STATUSES = ["recording", "processing", "ready", "failed", "deleted"] as const;
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

export const LEDGER_ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const;

export const MEMBER_CLASSES = ["streamer", "viewer", "worker"] as const;
export const MEMBERSHIP_STATUSES = ["active", "lapsed", "exited"] as const;
export const MEMBERSHIP_BASES = ["streaming_hours", "share", "subscription", "board_appointment"] as const;
export const SHARE_STATUSES = ["pending", "held", "refunded"] as const;

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
] as const;
export const MOD_SCOPES = ["channel", "platform"] as const;
export const DMCA_STATUSES = ["received", "actioned", "rejected", "countered", "restored"] as const;

export const LEGAL_DOCUMENT_KINDS = ["terms", "privacy", "guidelines", "cookies", "dmca_policy"] as const;
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
