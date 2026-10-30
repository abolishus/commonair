// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Go-live notifications, web push and the Discord adapter (N1, ADR 0028): shared rules and payloads. */
import { z } from "zod";
import { Slug } from "./api/common.ts";
import type { NotifyMedium, PREFERENCE_TYPES } from "./enums.ts";

export const NOTIFY_RULES = {
  /** Followers per fan-out job (one transaction each); the job enqueues the next page. */
  fanoutPageSize: 500,
  /** Browsers per member: subscribing another drops the oldest. */
  maxPushSubscriptionsPerUser: 10,
  /** RFC 8030 `TTL`: a go-live older than this is not worth showing. */
  pushTtlSeconds: 3600,
  /** Plaintext bound; RFC 8291 records are at most 4096 bytes with overhead. */
  maxPushPayloadBytes: 3072,
  /** Consecutive 401/404 answers after which a Discord webhook is removed and the owner told. */
  discordFailureLimit: 3,
  /** The email digest sweep's period (`NOTIFY_JOBS.emailDigest`). */
  emailDigestSweepMs: 30_000,
  /** `notifications.unreadCount` stops counting here (the badge shows "99+"). */
  unreadCountCap: 99,
  /** `notify-prune` (decided 2026-10-30): every `notifications` row older than this is deleted. */
  retentionDays: 90,
  /** Read `go_live` rows go sooner: they are only "who went live", already seen. */
  readGoLiveRetentionDays: 30,
  /** Rows per DELETE statement; the job loops until a batch comes back short. */
  pruneBatchSize: 5_000,
  /** The prune job's period. */
  pruneEveryMs: 3_600_000,
} as const;

/** Built-in preferences when a member has no row (ADR 0028 decision 4). */
export const NOTIFY_DEFAULTS: Readonly<
  Record<(typeof PREFERENCE_TYPES)[number], Readonly<Record<NotifyMedium, boolean>>>
> = {
  go_live: { in_app: true, email: false, push: false },
};

/**
 * `notifications.payload` of a `go_live` row (ADR 0028 decision 8). `title` is "" when the broadcast
 * or its channel is mature (`broadcasts.mature OR channels.mature`) and the follower has not
 * confirmed 18+ (`users.mature_confirmed_at` null).
 */
export const GoLiveNotificationPayload = z.object({
  channelId: z.uuid(),
  slug: Slug,
  broadcastId: z.uuid(),
  title: z.string().max(140),
});
export type GoLiveNotificationPayload = z.infer<typeof GoLiveNotificationPayload>;

/**
 * The plaintext of a push message, encrypted to the browser (RFC 8291) before it leaves the
 * worker. Nothing else goes in it: the vendor's push service relays it (ADR 0028 decision 1).
 * The service worker validates it by hand (it does not bundle zod).
 */
export const PushPayload = z.object({
  v: z.literal(1),
  type: z.literal("go_live"),
  slug: z.string(),
  title: z.string().max(140),
});
export type PushPayload = z.infer<typeof PushPayload>;

/** `PushSubscription.toJSON().keys`: base64url, unpadded or padded. */
export const PushSubscriptionKeys = z.object({
  /** Uncompressed P-256 point, 65 bytes (the server also checks the 0x04 prefix). */
  p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}=?$/),
  /** 16-byte auth secret. */
  auth: z.string().regex(/^[A-Za-z0-9_-]{22}(?:==)?$/),
});
export type PushSubscriptionKeys = z.infer<typeof PushSubscriptionKeys>;

/** `encryptSecret` / `hmacHex` purposes (packages/tokens). Never reuse one for another value. */
export const NOTIFY_SECRET_PURPOSES = {
  /** `push_subscriptions.subscription`: JSON `{ endpoint, p256dh, auth }`. */
  pushSubscription: "push-subscription",
  /** `push_subscriptions.endpoint_hash`: `hmacHex(AUTH_SECRET, "push-endpoint:" + endpoint)`. */
  pushEndpoint: "push-endpoint",
  /** `discord_webhooks.url`. */
  discordWebhook: "discord-webhook",
} as const;

/** Discord channel webhooks only (ADR 0028 decision 5); anything else is refused by the API and the worker. */
export const DISCORD_WEBHOOK_URL =
  /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d{1,25}\/[A-Za-z0-9_-]{1,100}$/;

/** RFC 8058 one-click unsubscribe, a raw API route: `POST` applies, `GET` answers 303 to `UNSUBSCRIBE_PAGE_PATH`. */
export const EMAIL_UNSUBSCRIBE_PATH = "/api/email/unsubscribe";
/** The web confirm page (same `list` and `token` query). */
export const UNSUBSCRIBE_PAGE_PATH = "/settings/notifications/unsubscribe";
/** The web settings page linked from every go-live email. */
export const NOTIFICATION_SETTINGS_PATH = "/settings/notifications";
