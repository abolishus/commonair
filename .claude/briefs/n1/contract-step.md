<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N1 contract step (orchestrator)

The orchestrator does this on `main` before any N1 unit starts, commits it (`feat(n1): contract
step`), pushes, lets CI go green (CI is the gate; no local `verify`). **W1's contract step lands
first** (`.claude/briefs/w1/contract-step.md`); this step is written on top of it and edits the
same shared files after W1's additions (re-find every anchor by its quoted text, never by the
line numbers below). **This step lands right after W1's step and before batch-4 wave 1 starts**
(W1 §12: wave-1 units branch from this step's sha). That ordering matters: this step edits
orchestrator-owned files that wave-1 units build on (`services/worker/src/exports/collectors.ts`
§6.7 on top of W1 §4.7's `blocks.json`, `jobs/index.ts`, `account-deletion.ts`, the route tree,
nav, `core.json`), so it must not land while wave 1 is running. Everything below was checked against `a43aa6b` (2026-10-29); line numbers
are from that commit. Plan: `.claude/briefs/next/N1-notifications-pwa.md`. ADR:
`docs/decisions/0028-notifications.md` (accepted 2026-10-27). Units: `.claude/briefs/n1/N1-*.md`.

**Migrations: N1 takes 0039 and 0040 if W1 took 0037 and 0038** (the next two free numbers after
W1's step, whatever they are: `0039_n1_notifications` generated, `0040_n1_protections` custom).
If W1 ends with one migration, N1 takes 0038 and 0039; the orchestrator states the final numbers
in the base-sha message.

## 0. Where the code differs from the plan (corrections)

| Plan / ADR says                                                                       | Code at `a43aa6b`, and what this step does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NOTIFICATION_TYPES` at `enums.ts:217-218`; notifications table `channels.ts:167-180` | `NOTIFICATION_TYPES` is `packages/contracts/src/enums.ts:264-273` (E8 grew the file); the table is still `packages/db/src/schema/channels.ts:167-180`; `follows` `:135-152`; `notificationType` pgEnum `schema/_shared.ts:91`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `me.notifications` and mark-read at `me.ts:201-243`                                   | `services/api/src/routes/me.ts:203-245`; router `packages/contracts/src/api/router.ts:158-187`. Kept as they are: N1-inbox builds on them. W1's step adds `me.blocks` to `me.ts`, so **N1 adds nothing to `me`**: every new procedure is in a new top-level `notifications` namespace (§1.5) with its own route files (§5.1)                                                                                                                                                                                                                                                                                                                     |
| The outbox relay enqueues only hooked types (`outbox.ts:110-133`)                     | Still true (`services/worker/src/outbox.ts:110-120` builds `hooked`, `:136-139` enqueues fan-outs). E8 added `applyGoalProgress` at `:125`. §6.2 adds the go-live enqueue after the webhook fan-out enqueue. N4 is not in batch 4; the hook is one function (`notify/outbox-jobs.ts`) N4 can extend                                                                                                                                                                                                                                                                                                                                              |
| `QUEUES` needs a notification queue                                                   | `QUEUES.notifications` and `QUEUES.email` already exist (`packages/contracts/src/internal.ts:308-309`) and nothing uses them; every queue in `QUEUES` already gets workers (`services/worker/src/env.ts:73-75`). N1 uses both; no new queue                                                                                                                                                                                                                                                                                                                                                                                                      |
| Go-live email goes through "the recipient mail limiter"                               | `recipientLimitedMailer` (`services/api/src/mail.ts:136-151`, bucket `mail` 10/h per template per mailbox) wraps **only the API's** mailer; the worker's mailer (`services/worker/src/main.ts:51`) has no limiter. Go-live mail is bounded without it: only verified addresses that opted in, at most one per channel per cooldown, and one digest per `emailDigestMinutes` window. Not moved                                                                                                                                                                                                                                                    |
| The one-click handler is `/settings/notifications/unsubscribe` (N1-email)             | That path is a web page; the production web server sends every non-`/api` request to SSR (`apps/web/src/server/http.ts:62-77`) and the dev server has no POST route, so an RFC 8058 POST there cannot be answered without new routing in two servers. **Changed:** the `List-Unsubscribe` URL is the API's raw route `/api/email/unsubscribe?list=…&token=…` (§5.2): `POST` applies it (one-click), `GET` answers 303 to the web confirm page `/settings/notifications/unsubscribe` (same query), which confirms with a button. Same origin, so the mailer's same-origin link rule holds. The samples' governance URLs move to it too (N1-email) |
| Governance mail "already links" the unsubscribe list                                  | The two governance templates take an `unsubscribeUrl` (`packages/email/src/samples.ts:85`, `:92`), but **nothing sends governance mail** (no caller of `governanceVoteOpened` outside `packages/email`). N1-email serves `list=governance` (stores email-off rows for `proposal` and `vote_open`) so the link works when a sender appears                                                                                                                                                                                                                                                                                                        |
| `stream.online` carries broadcaster and broadcast id, not the title                   | Correct (`events.ts:92-98`, written at `services/api/src/media/hooks.ts:120-126`); the fan-out reads `broadcasts.title` and `broadcasts.mature` (`schema/media.ts:45-47`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Push sends go through `resolveCallback` / `postWebhook`                               | `postWebhook` (`services/worker/src/webhooks/http.ts:29-…`) forces `content-type: application/json`, a string body and `user-agent: CommonAir-EventSub/1`; RFC 8030 needs a binary body, `Content-Encoding: aes128gcm`, `TTL`, `Urgency` and a VAPID `Authorization`. §6.5 generalizes it as `postPinned`; `postWebhook` becomes a wrapper (no behaviour change)                                                                                                                                                                                                                                                                                 |
| The FOSS route to Discord "works only once E9 opens webhook subscriptions"            | E9 shipped: `developer.events.subscribe` is implemented (batch 3). `stream.online` can already be delivered to Matrix or a self-hosted bot; `docs/streamers/discord.md` (N1-discord) says so                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| A static manifest in `apps/web/public/`                                               | The name must come from the instance (AGENTS.md rule 5; `instanceSite()`), and one image serves every instance (`apps/web/src/server/env.ts:1-8`). The manifest is served by the web server from `instanceSite(env)` (§7.4); `public/` holds only icons and nothing instance-specific                                                                                                                                                                                                                                                                                                                                                            |
| `apps/web/src/sw.ts`                                                                  | A service worker needs the `WebWorker` lib, which clashes with the app's `DOM` lib in one program. The worker lives in `apps/web/src/sw/**` with its own `tsconfig.json`, excluded from the app's (§7.5)                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Harness: "a Chromium push subscription … receives an encrypted payload"               | Headless Chromium cannot subscribe without a vendor push service (no network to FCM in CI). The harness makes its own subscription keys (as a browser would), registers them over the API (step 4) or through the web toggle with `PushManager.subscribe` stubbed in the page (step 7), receives the real encrypted POST on its own receiver and decrypts it; the service worker's push handler is driven with CDP `ServiceWorker.deliverPushMessage` (step 6). Discord has no harness step (decision 2)                                                                                                                                         |
| Push "per instance" (`WEB_PUSH_ENABLED`) is proprietary for `--no-proprietary`        | The `no-proprietary` preflight requires `stripe`, `oauth`, `cdn` false in `/healthz` (`harness/src/runner.ts:89-…`). The harness stack turns push on against a local endpoint (no vendor), so `webPush` joins `/healthz` and `NEEDS` as a proprietary **need** (skipped under the profile) but not the preflight list (§9.1)                                                                                                                                                                                                                                                                                                                     |
| Account deletion cascades the new rows                                                | Deletion pseudonymizes `users` and `channels` and deletes child rows explicitly (`services/worker/src/deletion/account-deletion.ts:228-310`); cascades never fire. §6.6 adds the explicit deletes, including other users' `go_live` rows that carry the deleted streamer's slug and title                                                                                                                                                                                                                                                                                                                                                        |

### Decided within ADR 0028 (orchestrator defaults and user answers, recorded as decided 2026-10-30)

| Decision                                                                                                                                                                                                                                                                                                                                                                                                                     | Where                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| One-click unsubscribe on the API (`/api/email/unsubscribe`), web confirm page for GET                                                                                                                                                                                                                                                                                                                                        | §5.2, N1-email                                 |
| Discord: unit and integration tests only (local TLS receiver, injected resolver); no harness step and no test-origin env var, so `.env.example` gains nothing for Discord (ADR decision 5)                                                                                                                                                                                                                                   | N1-discord                                     |
| Harness push without a vendor (stubbed `PushManager`, harness-made keys, CDP push delivery)                                                                                                                                                                                                                                                                                                                                  | §9, N1-push, N1-pwa                            |
| A mature broadcast notifies followers who have not confirmed 18+ without its title (`title: ""`; email and push say only "is live"). "Mature" is `broadcasts.mature OR channels.mature`, read when the unit builds the message (the broadcast copies the channel flag at start, `services/api/src/media/hooks.ts:113`, but the channel can be labelled mature later); fan-out, email, push and Discord all use this one rule | §1.3, N1-fanout, N1-email, N1-push, N1-discord |
| The email digest is a 30-second sweep over `notification_email_queue`, not a delayed job per user (replica-safe with `SKIP LOCKED`, nothing lost on a Valkey flush)                                                                                                                                                                                                                                                          | §2, N1-email                                   |
| Go-live email strings carry no counts (the email catalog has no plurals until N2-email)                                                                                                                                                                                                                                                                                                                                      | N1-email                                       |
| The service worker picks its "is live" text from bundled catalogs by `navigator.languages`; it stores nothing                                                                                                                                                                                                                                                                                                                | N1-pwa                                         |
| A push subscription belongs to the last member who subscribed it (the endpoint hash is unique); sign-out in that browser deletes it                                                                                                                                                                                                                                                                                          | §2, N1-push, N1-pwa                            |
| `selfhost.sh --web-push` / `--no-web-push`; the VAPID pair is always generated (install and upgrade, `init-env --merge`)                                                                                                                                                                                                                                                                                                     | §4.4                                           |
| The bell is a popover (newest 20, "load more" inside it); no `/notifications` page                                                                                                                                                                                                                                                                                                                                           | N1-inbox                                       |
| Privacy and cookie drafts bumped as drafts counsel has not reviewed (user, 2026-10-30); privacy needs re-acceptance and the re-acceptance prompt is accepted; N1's privacy version is one more string on top of W1's (§10.3)                                                                                                                                                                                                 | §10                                            |
| One-click unsubscribe: `POST /api/email/unsubscribe` applies (RFC 8058), `GET` answers 303 to the web confirm page with the same query                                                                                                                                                                                                                                                                                       | §5.2, N1-email                                 |
| Turning push on in a browser also turns the member's go-live push default on (`notifications.preferences.set`, `channel: null`)                                                                                                                                                                                                                                                                                              | N1-pwa                                         |
| User blocks (W1's `user_blocks`) do not affect go-live notifications in either direction: following is the opt-in, and unfollowing or the per-channel bell is the way out                                                                                                                                                                                                                                                    | N1-fanout                                      |
| `notifications` retention: N1-fanout's `notify-prune` job deletes rows older than 90 days, and read `go_live` rows older than 30 days, in batches (index `notifications_created_idx`, job registered here)                                                                                                                                                                                                                   | §1.3, §2.2, §6.1, N1-fanout                    |
| CI shard: `notifications` joins W1's `features` shard unless that pushes it past ~12 minutes, then its own `notify` shard (decided at the milestone end)                                                                                                                                                                                                                                                                     | §15                                            |

## 1. Contracts (`packages/contracts`)

### 1.1 `src/enums.ts` (append after `NOTIFICATION_TYPES`, `:264-273`)

```ts
/** Where a notification can reach someone (`notification_preferences.medium`, ADR 0028 decision 4). */
export const NOTIFY_MEDIA = ["in_app", "email", "push"] as const;
export type NotifyMedium = (typeof NOTIFY_MEDIA)[number];
/** Types a member sets preferences for through the API (N1: go-live only; other types keep their in-app behaviour). */
export const PREFERENCE_TYPES = ["go_live"] as const;
/** One-click unsubscribe lists (RFC 8058). `governance` stores email-off rows for `proposal` and `vote_open`. */
export const UNSUBSCRIBE_LISTS = ["go_live", "governance"] as const;
/** Why the last Discord post failed; shown in the studio (never the URL). */
export const DISCORD_WEBHOOK_ERRORS = ["unauthorized", "not_found", "rate_limited", "rejected", "network"] as const;
```

### 1.2 `src/shapes.ts` (after `PointsAccrualSetting`, `:225-…`)

```ts
/**
 * `notifications.goLive` governance setting (ADR 0028 decision 3, ordinary decision). Range-checked
 * by the database (`commonair_validate_notifications_go_live`, migration 0040).
 */
export const GoLiveSetting = z.object({
  /** At most one go-live per channel per follower in this window, across in-app, email and push. */
  cooldownHours: z.number().int().min(1).max(48),
  /** Go-live emails wait this long from the first one queued for a member, then go as one digest; 0 sends at the next sweep. */
  emailDigestMinutes: z.number().int().min(0).max(60),
});
export type GoLiveSetting = z.infer<typeof GoLiveSetting>;
```

### 1.3 `src/notify.ts` (new; add `"./notify": "./src/notify.ts"` to `package.json` `exports`)

```ts
// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Go-live notifications, web push and the Discord adapter (N1, ADR 0028): shared rules and payloads. */
import { z } from "zod";
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
  slug: z.string(),
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
```

Test `packages/contracts/tests/notify.test.ts`: the key regexes against a real browser-shaped
pair (generate a P-256 key and 16 random bytes, base64url, with and without padding), the Discord
regex (accepts both hosts; refuses `http:`, other hosts, `discord.com.evil.example`, a path
suffix, a query), `PushPayload` refuses extra fields only where zod does (document it: the worker
builds it, so `strict()` is not needed).

### 1.4 `src/api/entities.ts` (append at the end, `:1444`)

```ts
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
export const PushStatus = z.object({
  /** `WEB_PUSH_ENABLED` on this instance. */
  enabled: z.boolean(),
  /** The VAPID public key (base64url, 65 bytes) for `applicationServerKey`; null when disabled. */
  vapidPublicKey: z.string().nullable(),
  /** The caller's push subscriptions (browsers). */
  subscriptions: z.number().int(),
});
export const DiscordWebhookStatus = z.object({
  configured: z.boolean(),
  setAt: Timestamp.nullable(),
  lastPostedAt: Timestamp.nullable(),
  lastError: z.enum(E.DISCORD_WEBHOOK_ERRORS).nullable(),
});
```

### 1.5 `src/api/router.ts`

Import `PushSubscriptionKeys`, `DISCORD_WEBHOOK_URL` from `../notify.ts`. Append a top-level
namespace after the last one (`ncii`, `:3048-3083`, and after whatever W1 appended):

```ts
  /** Go-live notifications, preferences, web push and the Discord adapter (N1, ADR 0028). The list and mark-read stay in `me`. */
  notifications: {
    unreadCount: user
      .route({ method: "GET", path: "/notifications/unread-count", summary: "Unread in-app notifications (capped)", ...tag("Notifications") })
      .output(z.object({ count: z.number().int(), capped: z.boolean() })),
    preferences: {
      get: user
        .route({ method: "GET", path: "/notifications/preferences", summary: "Go-live notification preferences", ...tag("Notifications") })
        .input(z.object({ type: z.enum(E.PREFERENCE_TYPES).default("go_live") }))
        .output(D.NotificationPreferences),
      set: user
        .meta({ access: "user", rateLimit: "write" })
        .route({
          method: "PUT",
          path: "/notifications/preferences",
          summary: "Set a default (no channel) or a channel override; enabled null removes the override",
          ...tag("Notifications"),
        })
        .input(
          z.object({
            type: z.enum(E.PREFERENCE_TYPES),
            medium: z.enum(E.NOTIFY_MEDIA),
            channel: Slug.nullable(),
            /** null: remove the channel override (refused BAD_REQUEST for a default). */
            enabled: z.boolean().nullable(),
          }),
        )
        .output(D.NotificationPreferences),
    },
    push: {
      status: user
        .route({ method: "GET", path: "/notifications/push", summary: "Whether web push is offered, and the VAPID key", ...tag("Notifications") })
        .output(D.PushStatus),
      subscribe: user
        .meta({ access: "user", rateLimit: "write" })
        .route({
          method: "POST",
          path: "/notifications/push/subscriptions",
          summary: "Register this browser's push subscription",
          description: "PRECONDITION_FAILED (requirement `web_push_disabled`) when the instance has push off.",
          ...tag("Notifications"),
        })
        .input(z.object({ endpoint: z.url().max(2048), keys: PushSubscriptionKeys }))
        .output(Ok),
      unsubscribe: user
        .meta({ access: "user", rateLimit: "write" })
        .route({ method: "POST", path: "/notifications/push/unsubscribe", summary: "Forget this browser's push subscription", ...tag("Notifications") })
        .input(z.object({ endpoint: z.url().max(2048) }))
        .output(Ok),
    },
    unsubscribe: base
      .meta({ access: "public", rateLimit: "write" })
      .route({
        method: "POST",
        path: "/notifications/unsubscribe",
        summary: "Apply an email unsubscribe link (the confirm page; mail clients use the one-click route)",
        ...tag("Notifications"),
      })
      .input(z.object({ list: z.enum(E.UNSUBSCRIBE_LISTS), token: z.string().min(1).max(200) }))
      .output(z.object({ list: z.enum(E.UNSUBSCRIBE_LISTS) })),
    discord: {
      get: owner
        .route({ method: "GET", path: "/channels/{channel}/discord-webhook", summary: "Whether a Discord webhook is set (never the URL)", ...tag("Notifications") })
        .input(ChannelRef)
        .output(D.DiscordWebhookStatus),
      set: owner
        .meta({ access: "owner", rateLimit: "write" })
        .route({ method: "PUT", path: "/channels/{channel}/discord-webhook", summary: "Set the Discord webhook go-live posts go to", ...tag("Notifications") })
        .input(ChannelRef.extend({ url: z.string().max(300).regex(DISCORD_WEBHOOK_URL) }))
        .output(D.DiscordWebhookStatus),
      remove: owner
        .route({ method: "DELETE", path: "/channels/{channel}/discord-webhook", summary: "Remove the Discord webhook", ...tag("Notifications") })
        .input(ChannelRef)
        .output(Ok),
      test: owner
        .meta({ access: "owner", rateLimit: "expensive" })
        .route({ method: "POST", path: "/channels/{channel}/discord-webhook/test", summary: "Post a test message now", ...tag("Notifications") })
        .input(ChannelRef)
        .output(D.DiscordWebhookStatus),
    },
  },
```

Check `ChannelRef`, `Ok`, `Slug`, `base` are already imported (`:25-40`). Errors: the units use
`precondition("web_push_disabled", …)` and `badRequest` from `services/api/src/lib/errors.ts`; no
new error code. Run the router tests (scopes: every new procedure is session-only, no `scopes`
key; `appTokens` holders unchanged; the OpenAPI document builds with the new `Notifications` tag).

### 1.6 `src/internal.ts`

After `QUEUES` (`:300-320`), nothing changes in `QUEUES`. Append after `WEBHOOK_JOBS` and its
payloads (`:485-…`):

```ts
/**
 * Job names on `QUEUES.notifications`, `QUEUES.email` and `QUEUES.retention` (N1, ADR 0028 decision
 * 8). Producers: the outbox relay (`goLive`, one per `stream.online`), the go-live job (`push`,
 * `discord`, and its own next page), the API (`discord` for `notifications.discord.test`).
 * `emailDigest` and `prune` are scheduled.
 */
export const NOTIFY_JOBS = {
  goLive: "go-live",
  push: "push",
  discord: "discord",
  emailDigest: "email-digest",
  prune: "notify-prune",
} as const;
/** `NOTIFY_JOBS.goLive`: one page of the channel's followers after `after` (null: the first page). */
export const GoLiveJob = z.object({ eventId: z.uuid(), after: z.uuid().nullable().default(null) });
export type GoLiveJob = z.infer<typeof GoLiveJob>;
/** `NOTIFY_JOBS.push`: every push subscription of one member for one go-live. */
export const PushJob = z.object({ eventId: z.uuid(), userId: z.uuid(), channelId: z.uuid(), broadcastId: z.uuid() });
export type PushJob = z.infer<typeof PushJob>;
/** `NOTIFY_JOBS.discord`: one post (`test`: the studio's test button, no cooldown, no broadcast). */
export const DiscordJob = z.object({
  channelId: z.uuid(),
  eventId: z.uuid().nullable(),
  broadcastId: z.uuid().nullable(),
  test: z.boolean().default(false),
});
export type DiscordJob = z.infer<typeof DiscordJob>;
export const EmailDigestJob = z.object({});
export const NotifyPruneJob = z.object({});
```

Job ids (BullMQ: no `:`): `go-live-${eventId}` (first page), `go-live-${eventId}-${after}` (later
pages), `push-${eventId}-${userId}`, `discord-${eventId}`, `discord-test-${channelId}-${minute}`.

## 2. Database (follow `.claude/skills/schema-change/SKILL.md`)

There are no notification preferences, sends, push subscriptions or webhooks anywhere: clean
tables, no back-compat (ADR 0028 "Context").

### 2.1 `packages/db/src/schema/_shared.ts` (after `notificationType`, `:91`)

```ts
export const notificationMedium = pgEnum("notification_medium", E.NOTIFY_MEDIA);
export const discordWebhookError = pgEnum("discord_webhook_error", E.DISCORD_WEBHOOK_ERRORS);
```

### 2.2 `packages/db/src/schema/channels.ts`

- `follows` (`:135-152`): table options add
  `index("follows_channel_notify_idx").on(t.channelId, t.followerId).where(sql\`${t.notify}\`)`
  (comment: "the go-live fan-out pages a channel's notifying followers by follower id").
- `notifications` (`:167-180`): add `dedupeKey: text(),` (comment: "set by writers that may run
  twice (go-live: `go-live-<eventId>`); unique per user") and options
  `uniqueIndex("notifications_dedupe_uq").on(t.userId, t.dedupeKey).where(sql\`${t.dedupeKey} is not null\`)`,
  `index("notifications_user_unread_idx").on(t.userId).where(sql\`${t.readAt} is null\`)`,
  `index("notifications_created_idx").on(t.createdAt)`(comment: "the`notify-prune` job deletes
  by age in batches").

### 2.3 `packages/db/src/schema/notify.ts` (new; `export * from "./notify.ts";` in `schema/index.ts` after `interactive.ts`, `:16`)

```ts
// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Go-live notifications, web push and the Discord adapter (N1, ADR 0028). Mutable working state: no history. */
import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, discordWebhookError, id, notificationMedium, notificationType, ts, updatedAt } from "./_shared.ts";
import { users } from "./auth.ts";
import { channels } from "./channels.ts";
import { broadcasts } from "./media.ts";

/** type × channel × medium (ADR 0028 decision 4). A null channel is the member's default for the type and medium. */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: notificationType().notNull(),
    channelId: uuid().references(() => channels.id, { onDelete: "cascade" }),
    medium: notificationMedium().notNull(),
    enabled: boolean().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One default and one override per channel: nulls compare equal, so upserts can target it.
    uniqueIndex("notification_prefs_uq").on(t.userId, t.type, t.medium, t.channelId).nullsNotDistinct(),
    index("notification_prefs_channel_idx")
      .on(t.channelId)
      .where(sql`${t.channelId} is not null`),
  ],
);

/**
 * The cooldown (ADR 0028 decision 3): one row per follower and channel, moved forward by one
 * conditional upsert, so several worker replicas cannot both send.
 */
export const notificationGoLiveSends = pgTable(
  "notification_go_live_sends",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    lastSentAt: ts().notNull(),
    /** The `stream.online` that last passed: a redelivered job for the same event passes again (idempotent sends). No FK: events are pruned. */
    eventId: uuid().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.channelId] })],
);

/** Go-live emails waiting for the digest sweep (ADR 0028 decision 3). Deleted when sent. */
export const notificationEmailQueue = pgTable(
  "notification_email_queue",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventId: uuid().notNull(),
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    broadcastId: uuid()
      .notNull()
      .references(() => broadcasts.id, { onDelete: "cascade" }),
    queuedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.eventId] }), index("notification_email_queue_due_idx").on(t.queuedAt)],
);

/** One browser's push subscription (ADR 0028 decision 6): encrypted, found by an HMAC of its endpoint. */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** `hmacHex(AUTH_SECRET, "push-endpoint:" + endpoint)`: unique, so a browser belongs to the last member who subscribed it. */
    endpointHash: text().notNull().unique(),
    /** `encryptSecret(AUTH_SECRET, "push-subscription", JSON { endpoint, p256dh, auth })`; never logged. */
    subscription: text().notNull(),
    createdAt: createdAt(),
    lastSuccessAt: ts(),
    failures: integer().notNull().default(0),
  },
  (t) => [index("push_subscriptions_user_idx").on(t.userId, t.createdAt)],
);

/** A channel's Discord webhook (ADR 0028 decision 5). The URL is a secret: encrypted, never returned. */
export const discordWebhooks = pgTable("discord_webhooks", {
  channelId: uuid()
    .primaryKey()
    .references(() => channels.id, { onDelete: "cascade" }),
  /** `encryptSecret(AUTH_SECRET, "discord-webhook", url)`. */
  url: text().notNull(),
  setBy: uuid().references(() => users.id, { onDelete: "set null" }),
  setAt: createdAt(),
  /** The last go-live post (the per-channel cooldown) or test. */
  lastPostedAt: ts(),
  /** Consecutive 401/404 answers; at `NOTIFY_RULES.discordFailureLimit` the row is deleted. */
  failures: integer().notNull().default(0),
  lastError: discordWebhookError(),
  updatedAt: updatedAt(),
});
```

### 2.4 Migrations

1. `cd packages/db && bunx drizzle-kit generate --name n1_notifications` →
   **`0039_n1_notifications.sql`** (or the next free number, see the top). Check: two enums,
   five tables, `notifications.dedupe_key`, four indexes on existing tables (`follows`,
   `notifications` ×3), the `nulls not distinct` unique index, three FKs per table as declared.
2. `bunx drizzle-kit generate --custom --name n1_protections` → **`0040_n1_protections.sql`**,
   SPDX header and a header comment:

```sql
-- SPDX-FileCopyrightText: 2026 CommonAir contributors
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- N1 protections (ADR 0028), in addition to 0034:
--   1. The notifications.goLive governance setting is shape- and range-checked with the same
--      bounds as GoLiveSetting in @commonair/contracts: a decision can lengthen or shorten the
--      cooldown but never below one hour, so no vote turns go-live into a flood.
-- The new tables need no grant changes: commonair_configure_app_role (0034) grants DML on every
-- table and the migrate job re-runs it; nothing in them is append-only.

-- 1. notifications.goLive is shape- and range-checked. -------------------------------------
CREATE FUNCTION commonair_validate_notifications_go_live() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb := NEW.value;
BEGIN
  IF jsonb_typeof(v->'cooldownHours') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v->'emailDigestMinutes') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'notifications.goLive needs numeric cooldownHours and emailDigestMinutes'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (v->>'cooldownHours')::numeric NOT BETWEEN 1 AND 48
     OR (v->>'emailDigestMinutes')::numeric NOT BETWEEN 0 AND 60
     OR (v->>'cooldownHours')::numeric <> trunc((v->>'cooldownHours')::numeric)
     OR (v->>'emailDigestMinutes')::numeric <> trunc((v->>'emailDigestMinutes')::numeric) THEN
    RAISE EXCEPTION 'notifications.goLive values out of range' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER governance_settings_notifications_go_live_ck BEFORE INSERT OR UPDATE ON public.governance_settings
  FOR EACH ROW WHEN (NEW.key = 'notifications.goLive') EXECUTE FUNCTION commonair_validate_notifications_go_live();
```

### 2.5 Seed and DB tests

- `packages/db/src/seed.ts` `DEFAULT_GOVERNANCE_SETTINGS`, after `interact.points.accrual`
  (`:143-149`):

```ts
  {
    key: "notifications.goLive",
    protected: false,
    description:
      "Go-live notifications: at most one per channel per follower every cooldownHours across in-app, email and push; go-live emails wait emailDigestMinutes and go out as one digest (ADR 0028).",
    value: { cooldownHours: 4, emailDigestMinutes: 5 },
  },
```

- `services/api/src/coop/shared.ts` `VALUE_SHAPES` (`:76-88`): `"notifications.goLive": GoLiveSetting,`
  (import from `@commonair/contracts/shapes`); a case in `services/api/tests/coop.test.ts` like
  the `interact.points.accrual` one (`:425-433`).
- `packages/db/tests/n1.int.test.ts` (new, `createTestDatabase()`, app role): the go-live setting
  refuses missing keys, `cooldownHours` 0 and 49, `emailDigestMinutes` 61 and 1.5, accepts the
  default and `{1, 0}`; `notification_prefs_uq` makes a second default row for the same
  `(user, type, medium)` conflict (nulls not distinct) while two different channels do not;
  `notifications_dedupe_uq` refuses the same `(user, dedupe_key)` twice and allows many nulls;
  deleting a channel cascades its preferences, sends, queue rows and Discord row.

## 3. `packages/tokens`: unsubscribe tokens (written here, complete)

`packages/tokens/src/unsubscribe.ts` (new; export from `src/index.ts`):

```ts
/**
 * RFC 8058 unsubscribe tokens (ADR 0028 decision 4): `v1.<b64url(user id, 16 bytes)>.<b64url(mac, 16 bytes)>`,
 * mac = first 16 bytes of HMAC-SHA-256 over `"email-unsubscribe:" + list + ":" + userId` with a key
 * derived from AUTH_SECRET (purpose "email-unsubscribe"). No expiry: a link in an old email must
 * keep working (the action only turns mail off). Rotating AUTH_SECRET invalidates every link.
 */
export async function signUnsubscribeToken(secret: string, userId: string, list: string): Promise<string>;
/** The user id, or null for a malformed, foreign-list or forged token (constant-time compare). */
export async function verifyUnsubscribeToken(secret: string, token: string, list: string): Promise<string | null>;
```

Implement with the existing HKDF/HMAC helpers: `b64url`, `fromB64url` and `timingSafeEqual` are
exported from `src/index.ts`; `hkdfKey` (`secrets.ts:14`) is module-private today, so add
`export` to it in `secrets.ts` (import it from `./secrets.ts`; do **not** re-export it from
`src/index.ts`), deriving an HMAC key (`{ name: "HMAC", hash: "SHA-256" }`, usage `["sign"]`) with
info `"email-unsubscribe"`. `fromB64url` is strict (no padding), which suits the token. Tests `packages/tokens/tests/unsubscribe.test.ts`: round trip;
another list → null; a flipped bit in either part → null; another secret → null; truncated,
extra parts, bad base64, a non-UUID id → null; the token is URL-safe (no `+/=`).

## 4. Config

### 4.1 `packages/config/src/env.ts` (after `developerEnv`, `:429-445`)

```ts
/** Web push (N1, ADR 0028 decision 1). Off by default; `init-env` generates the VAPID pair either way. */
export const webPushShape = z.object({
  /** Offer browser push; each viewer still opts in per browser. Off: the push procedures answer PRECONDITION_FAILED. */
  WEB_PUSH_ENABLED: bool.default(false),
  /** VAPID public key (RFC 8292): the uncompressed P-256 point, base64url (65 bytes). Browsers get it as `applicationServerKey`. */
  VAPID_PUBLIC_KEY: z
    .string()
    .optional()
    .refine((v) => !v || vapidPublicBytes(v), "must be a base64url uncompressed P-256 point (65 bytes, 0x04 first)"),
  /** VAPID private key: P-256 PKCS#8 DER, base64. Worker only. */
  VAPID_PRIVATE_KEY: z
    .string()
    .optional()
    .refine((v) => !v || (base64Bytes(v)?.length ?? 0) > 32, "must be a base64 PKCS#8 P-256 private key"),
  /** Harness only: accept http:// and private-network push endpoints. Never on a public instance. */
  WEB_PUSH_ALLOW_INSECURE_ENDPOINTS: bool.default(false),
});
const needsVapid = (
  env: { WEB_PUSH_ENABLED: boolean; VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string },
  ctx: z.RefinementCtx,
  needPrivate: boolean,
) => {
  if (env.WEB_PUSH_ENABLED && (!env.VAPID_PUBLIC_KEY || (needPrivate && !env.VAPID_PRIVATE_KEY)))
    ctx.addIssue({
      code: "custom",
      path: ["WEB_PUSH_ENABLED"],
      message: "WEB_PUSH_ENABLED needs the VAPID key pair (bun scripts/init-env.ts --merge)",
    });
};
/** Worker: sends push (needs the private key). */
export const webPushEnv = webPushShape.superRefine((env, ctx) => needsVapid(env, ctx, true));
/** API: subscribe/status (the public key only). */
export const webPushPublicEnv = webPushShape
  .omit({ VAPID_PRIVATE_KEY: true })
  .superRefine((env, ctx) => needsVapid(env, ctx, false));
```

`vapidPublicBytes(v)` (beside `base64Bytes`): base64url-decode, 65 bytes, first byte `0x04`.
Add `webPushEnv: webPushShape,` to `ALL_ENV_SCHEMAS` (`:624-650`) after `developerEnv` (W1 put
`chatEnv: chatShape` after `interactEnv`; leave it where it is) (the
plain shape, as `moderationEnv: moderationShape` and `turnEnv: turnShape` do for refined
schemas). API: add `webPushPublicEnv` to `SCHEMAS` in `services/api/src/env.ts` (list `:33-55`, after W1's `chatEnv`;
each schema is parsed on its own) and `z.output<typeof webPushPublicEnv>` to `ApiEnv`, and log the start-up
warning the ops hook logs when `WEB_PUSH_ALLOW_INSECURE_ENDPOINTS` is on. Worker: spread
`webPushShape.shape` in `services/worker/src/env.ts` (`:28-49`) after `interactEnv` and W1's
`chatShape`/`INTERNAL_API_SECRET` spreads, keep W1's `CHAT_REPLAY_MAX_DAYS` check, and call the
same `needsVapid(env, ctx, true)` in its `superRefine` (`:50-57`; export `needsVapid` as
`webPushRefinement`). Tests in `packages/config/tests/env.test.ts`: enabled without keys fails;
a bad public key fails; disabled with placeholders absent passes.

### 4.2 `.env.example` (after the developer platform block, `:170-179`, before `# --- worker ---`)

```
# --- notifications (ADR 0028) ---
# Browser push: off by default; each viewer still opts in per browser. init-env generates the
# VAPID pair (selfhost.sh --web-push turns push on).
WEB_PUSH_ENABLED=false
VAPID_PUBLIC_KEY=__generate_vapid_public__
VAPID_PRIVATE_KEY=__generate_vapid_private__
# Harness only. Never on a public instance: accepts http:// and private-network push endpoints.
WEB_PUSH_ALLOW_INSECURE_ENDPOINTS=false
```

### 4.3 `scripts/init-env.ts`

Generate one ECDSA P-256 pair (`crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])`):
public = base64url of the `raw` export (65 bytes), private = base64 of the `pkcs8` export.
Placeholders `=__generate_vapid_public__` / `=__generate_vapid_private__` beside the X25519 ones
(`:89-92`). A merge must never pair a kept half with a fresh half: fail like the evidence check
(`:41-45`) when exactly one of `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` exists. Case in the
init-env test (`git grep -ln init-env scripts/tests`): fresh file has a valid pair (sign with the
private key, verify with the public); `--merge` keeps an existing pair; one half → exit 1.

### 4.4 Self-hosting

- `infra/selfhost/env/commonair-api.keys` and `commonair-worker.keys`: regenerate with
  `bun scripts/selfhost/unit-env.ts` (never by hand; `--check` must stay green). The API list
  gains `WEB_PUSH_ENABLED`, `VAPID_PUBLIC_KEY`, `WEB_PUSH_ALLOW_INSECURE_ENDPOINTS`; the worker
  list also `VAPID_PRIVATE_KEY`.
- `scripts/selfhost.sh`: `--web-push` / `--no-web-push` for install, upgrade and reinstall, the
  `--turn-relay` pattern (`:93-96` usage, `:1545-1546` parsing, `:129` upgrade options): sets
  `WEB_PUSH_ENABLED=true|false` in `commonair.env`; without either flag the setting is kept (off
  on a first install). The keys need nothing here: the bundled `init-env --merge` already fills
  missing keys on install and upgrade, so every operator gets a VAPID pair (self-host parity).
  Before setting it on, check both `VAPID_*` keys are non-empty and `die` with a fix line
  otherwise (as `turn_env` does for `TURN_SHARED_SECRET`). Tests in
  `scripts/tests/selfhost-sh-cli.test.ts` (flag parsing, usage text) and the upgrade test
  (kept when absent; `--no-web-push` turns it off).
- `docs/self-hosting/configuration.md`: add `WEB_PUSH_ALLOW_INSECURE_ENDPOINTS` to the "Never set
  … on a public instance" sentence (`:107-109`); regenerate the env table with
  `bun scripts/config-reference.ts` (its `--check` runs in CI). `docs/self-hosting/install.md`
  options list: `--web-push` (N1-push writes the page it links, `docs/self-hosting/web-push.md`).

## 5. API scaffolding (`services/api`)

### 5.1 Route files (every unit owns disjoint files)

- `services/api/src/routes/notifications.ts` (composer, orchestrator):
  `export const notifications = { unreadCount, preferences, push, unsubscribe, discord };`
  importing `routes/notifications/{inbox,preferences,push,unsubscribe,discord}.ts`.
- Stubs, every handler `.handler(notImplemented)` (`services/api/src/lib/errors.ts:36`):
  `inbox.ts` exports `unreadCount` (N1-inbox); `preferences.ts` exports `preferences = { get, set }`
  (N1-inbox); `push.ts` exports `push = { status, subscribe, unsubscribe }` (N1-push);
  `unsubscribe.ts` exports `unsubscribe` (N1-email); `discord.ts` exports
  `discord = { get, set, remove, test }` (N1-discord).
- `services/api/src/router.ts`: import and add `notifications` (after `ncii`, `:29-56`).
- `grep -c '.handler(notImplemented)' services/api/src/routes/notifications/*.ts` totals 11.

### 5.2 One-click unsubscribe route (stub; N1-email fills it)

`services/api/src/notifications/email-unsubscribe.ts` (new, owned by N1-email):

```ts
import { EMAIL_UNSUBSCRIBE_PATH } from "@commonair/contracts/notify";
export const isEmailUnsubscribePath = (path: string): boolean => path === EMAIL_UNSUBSCRIBE_PATH;
/** GET: 303 to the confirm page with the same query. POST (RFC 8058 one-click): apply and answer 200. */
export async function emailUnsubscribe(
  _deps: Deps,
  _raw: Request,
  _url: URL,
  _rateLimitHash: string,
): Promise<Response> {
  return new Response(null, { status: 501 });
}
```

Mount in `services/api/src/http.ts` after the `/internal/` 404 (`:239`) and before the Stripe
webhook (`:241-…`), no CORS, no cookies read:

```ts
// RFC 8058 one-click unsubscribe (ADR 0028): mail clients POST here with no session or origin.
if (isEmailUnsubscribePath(path)) {
  const info = await requestInfo(raw, url, server);
  return emailUnsubscribe(deps, raw, url, info.rateLimitHash);
}
```

Test `services/api/tests/email-unsubscribe-route.test.ts` (orchestrator): the path reaches the
handler for GET and POST (501 now) and is not swallowed by the oRPC handler.

### 5.2a API producer on `QUEUES.notifications` (written here, complete)

`notifications.discord.test` enqueues a worker job, and the API has no producer for
`QUEUES.notifications` (each queue has its own per-deps producer module, e.g.
`services/api/src/privacy/export-queue.ts`, closed in `services/api/src/index.ts` `close()`,
`:110-126`). Add `services/api/src/notifications/queue.ts` (orchestrator-owned) on the
`export-queue.ts` pattern: `interface NotifyQueue { enqueueDiscordTest(channelId: string, minute: number): Promise<void>; close(): Promise<void> }`,
`createNotifyQueue(valkeyUrl, prefix)` (BullMQ `Queue(QUEUES.notifications, { prefix: WORKER_BULL_PREFIX })`,
job `NOTIFY_JOBS.discord`, data `DiscordJob` `{ channelId, eventId: null, broadcastId: null, test: true }`,
`jobId: discord-test-${channelId}-${minute}`, `attempts: 5`, exponential backoff 60 s,
`removeOnComplete`/`removeOnFail` 1000), `notifyQueue(deps)` (WeakMap, created on first use),
`setNotifyQueue(deps, q)` for tests, `closeNotifyQueue(deps)`; add `["notify queue", closeNotifyQueue]`
to the close list in `services/api/src/index.ts`. Test `services/api/tests/notify-queue.test.ts`
(orchestrator): the job name, id and data against real Valkey. N1-discord calls
`notifyQueue(deps).enqueueDiscordTest(...)` and never edits these files.

### 5.3 Health

`services/api/src/ops/hooks.ts` `opsHealth` (`:134-149`): add `webPush: env.WEB_PUSH_ENABLED,`
with the comment "browser push is offered (ADR 0028); the harness skips push steps under
`--profile no-proprietary`". Update its test.

## 6. Worker scaffolding (`services/worker`)

### 6.1 Job stubs (register in `src/jobs/index.ts` after W1's `// Feature wins, wave 1 (W1).` block, which follows the E9 jobs, `:91-94` at `a43aa6b`, under `// Notifications (N1, ADR 0028).`)

Each a `defineJob` with the final queue, name, data and schedule and a handler returning zeros:

- `src/jobs/notify-go-live.ts` (N1-fanout): `QUEUES.notifications`, `NOTIFY_JOBS.goLive`,
  `GoLiveJob`, `attempts: 5` → `{ followers: 0, inApp: 0, email: 0, push: 0, cooledDown: 0, nextPage: false }`.
- `src/jobs/notify-push.ts` (N1-push): `QUEUES.notifications`, `NOTIFY_JOBS.push`, `PushJob`,
  `attempts: 4`, `backoffMs: 30_000` → `{ sent: 0, removed: 0 }`.
- `src/jobs/notify-email-digest.ts` (N1-email): `QUEUES.email`, `NOTIFY_JOBS.emailDigest`,
  `EmailDigestJob`, `schedule: { every: NOTIFY_RULES.emailDigestSweepMs }`, `attempts: 1` →
  `{ users: 0, sent: 0 }`.
- `src/jobs/notify-discord.ts` (N1-discord): `QUEUES.notifications`, `NOTIFY_JOBS.discord`,
  `DiscordJob`, `attempts: 5`, `backoffMs: 60_000` → `{ posted: 0 }`.
- `src/jobs/notify-prune.ts` (N1-fanout; decided 2026-10-30): `QUEUES.retention`,
  `NOTIFY_JOBS.prune`, `NotifyPruneJob`, `schedule: { every: NOTIFY_RULES.pruneEveryMs }`,
  `attempts: 1` → `{ deleted: 0, readGoLive: 0 }`. Also append `"notify-prune"` to `OPS_TICK_JOBS`
  and `OPS_JOB_QUEUES` (`{ queue: QUEUES.retention, name: "notify-prune" }`) beside W1's entries, so
  the unit's integration test and the harness can run it on demand.

### 6.2 The outbox hook (written here, complete)

`src/notify/outbox-jobs.ts` (orchestrator-owned):

```ts
/** Jobs the outbox relay enqueues for notifications (ADR 0028 decision 8), whether or not a webhook subscription exists. */
export function notifyJobsFor(
  events: readonly BusEvent[],
): { name: string; data: GoLiveJob; opts: { jobId: string } }[] {
  return events
    .filter((e) => e.type === "stream.online")
    .map((e) => ({
      name: NOTIFY_JOBS.goLive,
      data: { eventId: e.id, after: null },
      opts: { jobId: `go-live-${e.id}` },
    }));
}
```

In `src/outbox.ts` `relayOutboxBatch`, after the webhook fan-out enqueue (`:136-139`):

```ts
// N1: every stream.online starts the go-live fan-out (ADR 0028 decision 8), hooked or not.
// Same at-least-once rule: the job id is the event id, so a re-relayed batch enqueues nothing new.
const notify = notifyJobsFor(valid);
if (notify.length > 0)
  await withTimeout(ctx.enqueueBulk(QUEUES.notifications, notify), valkeyTimeoutMs, "notify enqueue");
```

Tests: `services/worker/tests/notify-outbox-jobs.test.ts` (only `stream.online`, job ids) and a
case in the outbox integration test (a `stream.online` row with no subscription enqueues one
`go-live` job; a re-relay enqueues none).

### 6.3 Settings readers (written here, complete; units read them)

`src/notify/settings.ts` (orchestrator-owned):

- `goLiveSetting(db, logger, nowMs?)`: the `notifications.goLive` value parsed with
  `GoLiveSetting`, cached 30 s per process, the seeded default (logged) when missing or invalid;
  the pattern of `packages/interact/src/accrual.ts:96-…` (the API's `lib/settings.ts` cannot be
  imported by the worker). `clearGoLiveSettingCache()` for tests.
- `interface WebPushSettings { publicKey: string; privateKeyPkcs8: string; subject: string; allowInsecure: boolean }`
  and `webPushSettings(env, site): WebPushSettings | undefined` (undefined when
  `WEB_PUSH_ENABLED` is off). `subject` = `mailto:` + `site.contacts.general` (ADR 0028 decision 1,
  rule 5).

`src/context.ts` `WorkerContext` (`:30-64`) gains
`/** Web push (N1); absent when WEB_PUSH_ENABLED is off. */ webPush?: WebPushSettings;`, filled in
`src/worker.ts` / `src/main.ts` from `webPushSettings(env, site)` like `mailer` (`main.ts:46-51`
builds `site` and `mailer`, `:69-70` passes them).

### 6.4 Env

§4.1 (`webPushShape` spread and refinement).

### 6.5 Generalize the pinned POST (`src/webhooks/http.ts`)

Add, beside `postWebhook` (`:29-…`), and make `postWebhook` call it with
`{ contentType: "application/json", userAgent: "CommonAir-EventSub/1" }` (behaviour unchanged;
its tests unchanged and green):

```ts
export interface PinnedRequest {
  headers: Record<string, string>;
  body: string | Uint8Array;
  contentType: string;
  userAgent: string;
}
/** POST to a user-supplied URL through `resolveCallback` (public, pinned address; no redirects; capped response; deadline). */
export async function postPinned(callback: string, req: PinnedRequest, opts: PostOptions): Promise<PostResult>;
```

`PostResult` on success also carries `headers: Record<string, string>` (lower-case; N1-discord
needs `retry-after`, N1-push needs `retry-after` and `location`). New cases in
`services/worker/tests/webhook-http.test.ts` (or the file that tests `postWebhook`): a binary
body arrives byte for byte; the content type and user agent are the given ones.

### 6.6 Account deletion (`src/deletion/account-deletion.ts`)

Beside the `notifications` delete (`:295-298`), counted the same way:
`notification_preferences`, `notification_go_live_sends`, `notification_email_queue` and
`push_subscriptions` where `user_id = $user` (W1 §4.7 already added the `user_blocks` delete beside `chat_messages`;
keep it). Where the deleted user's channels are pseudonymized
(`:410-430`, beside the `channel_panels` and `simulcast_targets` deletes): delete
`discord_webhooks` for those channels, and **other members' `go_live` notifications about them**
(`delete from notifications where type = 'go_live' and payload->>'channelId' = any($channelIds)`):
they carry the old slug and title. Also delete `notification_preferences`,
`notification_go_live_sends` and `notification_email_queue` rows whose `channel_id` is one of
those channels. Cases in the deletion integration test.

### 6.7 Data export (`src/exports/collectors.ts`)

- `notifications.json` (`:781-795`): add sections `preferences` (type, channel slug or null,
  medium, enabled, updated) and `pushSubscriptions` (id, created, last success, failures: never
  the endpoint or keys, which are the browser's and of no use to the member), explicit `fields`,
  filtered by the requester's id.
- `channel.json` (`:917-…`): add `discordWebhook: { configured, setAt, lastPostedAt }` (never
  the URL).
- Cases in `services/worker/tests/export-collectors.test.ts`; propose nothing: the orchestrator
  updates the `docs/testing/e6-selectors.md` "Data export" rows here.

## 7. Web scaffolding (`apps/web`)

### 7.1 Routes (placeholders; regenerate and commit `src/routeTree.gen.ts`)

- `src/routes/_app/settings.notifications.index.tsx` → `/settings/notifications`, session guard
  as `settings.subscriptions.tsx`, `component: () => <NotFoundState />` (N1-inbox fills it).
- `src/routes/_app/settings.notifications.unsubscribe.tsx` → `/settings/notifications/unsubscribe`,
  **no** session guard, `validateSearch` `{ list?: string; token?: string }` (strings; the page
  validates), placeholder (N1-email fills it).
- **No unit adds, renames or removes a route file.**

### 7.2 Nav and chrome

- `src/lib/nav.ts` `AccountEntry` (`:16-46`): id `"notifications"`, `to: "/settings/notifications"`,
  listed after `"subscriptions"`; `src/components/site-chrome.tsx` `accountItem`: the case with
  `Notification03Icon` and label `t("nav.notifications")`; core key `"nav.notifications": "Notifications"`
  in `locales/en/core.json` (+ `bun run i18n:gen`). Update `tests/nav.test.ts`.
- `site-chrome.tsx` `AppHeader` `user` prop (`:216-231`): signed in, render
  `<><NotificationBell /><UserMenu … /></>` (check `SiteHeader`'s `user` slot lays out two
  children in the bar and the phone sheet; if not, put the bell in `actions` beside
  `SidebarTrigger`). `NotificationBell` from `src/components/notifications/bell.tsx` (stub:
  `export function NotificationBell(): React.JSX.Element | null { return null; }`, N1-inbox).
- `site-chrome.tsx` `onSignOut` (`:45-53`): before `signOut()`,
  `await forgetPushSubscription().catch(() => undefined);` from
  `src/components/pwa/push-client.ts` (stub `export async function forgetPushSubscription(): Promise<void> {}`, N1-pwa)
  with the comment "sign-out removes this browser's push subscription (ADR 0028 decision 6)".
- `src/routes/__root.tsx` `head` (`:24-32`): links `{ rel: "manifest", href: "/manifest.webmanifest" }`,
  `{ rel: "icon", href: "/icons/icon.svg", type: "image/svg+xml" }`,
  `{ rel: "apple-touch-icon", href: "/icons/apple-touch-icon.png" }`; metas
  `{ name: "theme-color", content: PWA_THEME_COLORS.dark, media: "(prefers-color-scheme: dark)" }` and
  the light one, from `src/pwa/theme.ts` (new, N1-pwa may change the values only):

```ts
/**
 * Browser chrome colours for the manifest and `theme-color` (ADR 0028 decision 7). These are the only
 * colour literals in the app: a manifest and a meta tag cannot read CSS variables. They mirror the
 * zinc base of the design tokens (`--background` in dark and light).
 */
export const PWA_THEME_COLORS = { dark: "#09090b", light: "#ffffff" } as const;
```

`apps/web/tests/source-policy.test.ts` scans `src/**` (all but `src/server/**`) and fails on any
hex literal (`color-literal`, `:214-222`), so add two `ALLOWLIST` entries (`:52-…`):
`{ file: "src/pwa/theme.ts", rule: "color-literal", match: "#09090b", count: 1 }` and the same for
`"#ffffff"`, with the reason "manifest and theme-color cannot read CSS variables (ADR 0028
decision 7)". The file is orchestrator-owned: if N1-pwa changes a value, it sends the matching
allowlist edit as a contract request.

In `RootComponent`, render `<PwaRoot />` once inside the providers (from
`src/components/pwa/pwa-root.tsx`, stub returning null, N1-pwa).

- `src/routes/_studio/dashboard.tsx`: after `<SimulcastSection … />` (`:74`),
  `<DiscordWebhookSection key={\`discord-${channel}\`} channel={channel} />`from`src/components/discord-webhook-section.tsx` (stub returning null, N1-discord).
- `src/components/pwa/push-toggle.tsx` (stub `export function PushToggle(): React.JSX.Element | null { return null; }`,
  N1-pwa): N1-inbox mounts it on the settings page.

### 7.3 i18n namespaces (create each empty, then `bun run i18n:gen` and commit `keys/*.gen.ts`)

| Namespace    | Unit       | Wave | Key prefixes                        |
| ------------ | ---------- | ---- | ----------------------------------- |
| `n1-email`   | N1-email   | 2    | `unsubscribe.`                      |
| `n1-inbox`   | N1-inbox   | 2    | `notifications.`, `notifySettings.` |
| `n1-pwa`     | N1-pwa     | 2    | `pwa.`, `push.`                     |
| `n1-discord` | N1-discord | 3    | `discord.`                          |

No existing key uses these prefixes (checked at `a43aa6b`). Each unit writes only its
`locales/en/<namespace>.json` and `keys/<namespace>.gen.ts` (README "How to add a namespace");
`nav.notifications` (§7.2) is the step's only `core` key. Email strings are not a namespace
(N1-email writes `packages/email/src/messages/en.ts` in that package's format).

### 7.4 Web server: manifest and the PWA build hook

- `src/server/pwa.ts` (stub, N1-pwa): `export function manifestResponse(_config: PublicConfig): Response { return new Response(null, { status: 404 }); }`.
- `src/server/http.ts` `WebServerOptions` (`:11-22`) gains `manifest?: () => Response`; in
  `createHandler`, before the static branch (`:62`): `GET`/`HEAD` `/manifest.webmanifest` →
  `opts.manifest()` with the page security headers and `cache-control: public, max-age=0, must-revalidate`.
  `server.ts` passes `manifest: () => manifestResponse(publicConfig(env))`. Test in the web
  server tests (the route reaches the callback; absent option → SSR as before).
- `scripts/vite-pwa.ts` (stub, N1-pwa): `export function pwa(): Plugin { return { name: "commonair-pwa" }; }`;
  `vite.config.ts` plugins (`:63`): `[healthz(), pwa(), tailwindcss(), tanstackStart(), react()]`.

### 7.5 Service worker typing

- `apps/web/src/sw/sw.ts` (stub `export {};`, N1-pwa) and `apps/web/src/sw/tsconfig.json`
  (extends the app's, `"lib": ["ES2023", "WebWorker"]`, `"types": []`, `include: ["./**/*.ts"]`).
- `apps/web/tsconfig.json`: `exclude` `src/sw/**`. `apps/web/package.json` `typecheck`:
  `tsc -p . && tsc -p src/sw`. Check `vp lint` still type-aware-lints `src/sw` (add the project
  to the Oxlint config if it lists tsconfigs).

## 8. `docs/testing/n1-selectors.md` (write it; the units build against it)

Header and intro as `docs/testing/e9-selectors.md` ("N1 web ↔ harness contract (notifications
and the PWA)"). Sections `## Rules`, `## Routes`, `## Test ids`, `## Scenarios`.

### Rules

- Tests select by `data-testid`, never visible text. Numbers are plain integers in `data-*`.
- Booleans are `data-state="on|off"`; option items follow `<field>-<value>`.
- Push in the harness never reaches a vendor: the harness receiver is the endpoint and the stack
  runs with `WEB_PUSH_ALLOW_INSECURE_ENDPOINTS=true` (`harness/compose.n1.yaml`).

### Routes

| Path                                          | Who       | Unit       |
| --------------------------------------------- | --------- | ---------- |
| `/settings/notifications`                     | signed in | N1-inbox   |
| `/settings/notifications/unsubscribe`         | anyone    | N1-email   |
| `/dashboard` (Discord section)                | owner     | N1-discord |
| `/manifest.webmanifest`, `/sw.js`, `/icons/*` | anyone    | N1-pwa     |

### Test ids

**Bell (header, signed in)**: `notification-bell` (`data-unread` = count, capped 99,
`data-capped`), `notification-bell-badge` (absent at 0), `notification-list`,
`notification-item` (`data-id`, `data-type`, `data-state` `read|unread`), `notification-item-link`,
`notification-mark-all-read`, `notification-load-more`, `notification-empty`,
`notification-settings-link`.

**Settings `/settings/notifications`**: `notify-default-in_app`, `notify-default-email`,
`notify-default-push` (switches, `data-state`, `data-builtin` `true|false`),
`notify-email-unverified` (notice), `notify-channel` (row, `data-slug`), `notify-channel-bell`
(the follow's `notify`), `notify-channel-email` and `notify-channel-push` (selects with options
`notify-channel-email-default|on|off`), `notify-save-error`.
**Push toggle (inside settings)**: `push-toggle` (`data-state`:
`unsupported|unavailable|denied|off|on|busy`), `push-unsupported`, `push-denied-help`.

**Unsubscribe page**: `unsubscribe-page` (`data-list`), `unsubscribe-confirm`, `unsubscribe-done`,
`unsubscribe-invalid`.

**PWA**: `pwa-update-prompt`, `pwa-update-reload`.

**Discord (studio dashboard)**: `discord-webhook-section`, `discord-webhook-status`
(`data-configured`, `data-error`), `discord-webhook-input`, `discord-webhook-save`,
`discord-webhook-test`, `discord-webhook-remove` (opens a `ConfirmDialog`, confirm
`discord-webhook-remove-confirm`).

### Scenarios

`notifications` (ADR 0028), `--set steps=` and `--set via=api|web`:

1. **In-app** (N1-fanout): a viewer follows a fresh streamer (bell on); the streamer goes live;
   within 30 s `me.notifications` has one `go_live` row whose payload is
   `{ channelId, slug, broadcastId, title }` and `notifications.unreadCount` is 1.
2. **Email** (N1-email; needs 1): the viewer verifies their email and sets go-live email on
   (`notifications.preferences.set`); a second streamer the viewer follows goes live; Mailpit
   receives one go-live email within 120 s (the harness digest window is 1 minute) linking
   `/<slug>`, with `List-Unsubscribe: <…/api/email/unsubscribe?list=go_live&token=…>` and
   `List-Unsubscribe-Post: List-Unsubscribe=One-Click`; a `POST` of that URL with
   `List-Unsubscribe=One-Click` answers 200 and `preferences.get` shows email off.
3. **Cooldown** (N1-fanout; needs 1): the first streamer stops and goes live again; after 45 s
   there is still exactly one `go_live` row for that channel and no second email.
4. **Push over the API** (N1-push; harness need `webPush`): the harness makes a subscription
   (P-256 key, 16-byte auth) whose endpoint is its receiver, registers it with
   `notifications.push.subscribe`, sets go-live push on; a third streamer goes live; the receiver
   gets one `POST` with `Content-Encoding: aes128gcm`, `TTL`, a VAPID `Authorization` whose JWT
   verifies against `notifications.push.status().vapidPublicKey` (`aud` = the receiver origin,
   `sub` a `mailto:`); the harness decrypts it to `{ v: 1, type: "go_live", slug, title }`. The
   receiver answers that POST with 410 (it records the body first), so within 30 s
   `push.status().subscriptions` drops to 0 (expired endpoints are deleted).
5. **Inbox** (N1-inbox; web only; needs 1): the viewer's browser shows `notification-bell` with
   `data-unread` ≥ 1; the item links to `/<slug>`; mark all read → `data-unread="0"`; the
   settings page flips `notify-default-email` (whatever its state, so the step does not depend on
   step 2) and `preferences.get` agrees, then flips it back.
6. **PWA** (N1-pwa; web only): `/manifest.webmanifest` names the instance; CDP
   `Page.getInstallabilityErrors` returns none; the service worker is active; no Cache Storage
   entry is under `/api/`, `/rpc/`, `/hls/`, `/media/` or `/vod/`; CDP
   `ServiceWorker.deliverPushMessage` with a `PushPayload` shows one notification
   (`registration.getNotifications()`) whose title contains the slug and whose `data.url` is
   `/<slug>` (the click handler is unit-tested; headless Chromium cannot click a notification).
7. **Push from the browser** (N1-pwa; web only; harness need `webPush`; needs 4 and 6): with
   `PushManager.subscribe` stubbed to return a harness subscription and the `notifications`
   permission granted, `push-toggle` goes `off` → `on`, `push.status().subscriptions` is 1, the
   **fourth** streamer (a channel that has not gone live yet: step 4's channel is in its cooldown)
   goes live and its go-live reaches the receiver and decrypts; signing out removes it
   (`subscriptions` 0 on the next sign-in).

## 9. Harness scaffolding

### 9.1 Needs

- `harness/src/scenario.ts` `NEEDS` (`:16-34`): add `"webPush"`; `PROPRIETARY_NEEDS` (`:38`):
  `["stripe", "oauth", "cdn", "webPush"]` (skipped under `--profile no-proprietary`).
  `PROPRIETARY_HEALTH_KEYS` (`harness/src/runner.ts:89`) is **not** changed: the harness stack
  runs push against its own receiver, so the profile's preflight does not require it off.
- `harness/src/platform.ts` need probe (`:341-…`): `webPush` → GET `${HARNESS_API_URL}/healthz`,
  `webPush === true` ? null : "web push is off (WEB_PUSH_ENABLED; harness/compose.n1.yaml)".
- `harness/README.md`: the profile paragraph (`:38-46`) names `webPush`.

### 9.2 Stack

- `harness/compose.n1.yaml` (new, CC0 header like `harness/compose.e9.yaml`): `api` and `worker`
  `WEB_PUSH_ENABLED: "true"`, `WEB_PUSH_ALLOW_INSECURE_ENDPOINTS: "true"` (the VAPID pair comes
  from `.env`). **The user's existing `.env` predates the VAPID keys**, and with push on and no
  keys the API and worker refuse to start (§4.1), which would take the whole harness stack down,
  not only this scenario. `bun scripts/init-env.ts --merge` adds them and keeps every other value:
  say so in the base-sha message to the user, in PROGRESS.md "In flight", and in the
  `harness/README.md` stack section (CI is unaffected: `.github/actions/setup` runs `init-env` fresh). Add it to `HARNESS_OVERRIDES` (`scripts/infra.ts:437-445`) after
  W1's `compose.w1.yaml` (which follows `compose.e9.yaml`), to the tests that count overrides, to `harness/README.md` (`:70`, `:501`),
  and to the multi-instance replicas (`harness/compose.multi-instance.yaml` `api-2` `:100-106`,
  `worker-2` `:160-168`, with a `# harness/compose.n1.yaml` comment).
- Governance bootstrap: `harness/compose.e5-coop.yaml` `GOVERNANCE_BOOTSTRAP_JSON` (`:26-33`) and
  `E5_GOVERNANCE_BOOTSTRAP` (`harness/src/coop.ts:65-76`) both gain
  `"notifications.goLive": { cooldownHours: 4, emailDigestMinutes: 1 }` (kept equal;
  `harness/tests/coop.test.ts` checks). The seed inserts the missing key on the next migrate.
- `harness/src/mailpit.ts`: add `headers(id): Promise<Record<string, string[]>>`
  (`/api/v1/message/{id}/headers`) with a test.

### 9.3 Scenario and step modules

- `harness/src/n1/run.ts` (orchestrator): `N1Run` = `{ ctx, platform, log, env, via, actors: {
  viewer: SignedInUser, streamers: [E8Streamer, E8Streamer, E8Streamer, E8Streamer] }, receiver: PushReceiver,
  state: N1State, browser?: BrowserFleet }` (one fresh channel per go-live step: 1/3 use the first,
  2 the second, 4 the third, 7 the fourth, because the cooldown blocks a second go-live of a
  channel for four hours); `N1State` = `{ firstChannel?, emailChannel?,
  pushChannel?, webPushChannel?, apiSubscription?: HarnessPushSubscription }`; `N1Step` = E9's shape
  (`harness/src/e9/run.ts:80-91`: `name`, `owner`, `needs`, `webOnly?`, `run`) **without** `ready`
  (readiness is `PENDING_N1_STEPS`, below) plus `requires?: Need[]` (run through `ctx.optionalStep`); `N1_STEP_NUMBERS = [1..7]`;
  **`PENDING_N1_STEPS = [1, 2, 3, 4, 5, 6, 7]`** (only the orchestrator removes a step, when it
  merges the unit that implements it); `planN1Steps` (E9's rule plus pending). Tests
  `harness/tests/n1/run.test.ts`.
- `harness/src/n1/push-receiver.ts` (orchestrator): a Bun server on this machine recording raw
  bytes (`body: Uint8Array`) and lower-case headers per request on `POST /push/<id>`, answering a
  status the test sets per id (201 by default, then e.g. 410); `endpoint(id)` is
  `http://<HARNESS_WEBHOOK_HOST>:<port>/push/<id>` (what the worker container reaches);
  `waitFor`, `close`. Tests in `harness/tests/n1/push-receiver.test.ts`.
- `harness/src/n1/selectors.ts` (orchestrator): `N1_TEST_IDS`, `N1_ROUTES` from §8, and
  `harness/tests/n1/selectors.test.ts` against `docs/testing/n1-selectors.md` like
  `harness/tests/e9/selectors.test.ts`.
- `harness/src/n1/ece.ts` (stub, **N1-push fills it**; N1-pwa's step 7 imports it in the same
  wave), final signatures, each body throwing `new Error("N1-push not merged")`:
  `newHarnessSubscription(endpoint: string): Promise<HarnessPushSubscription>` (a P-256 ECDH pair
  and 16 random bytes, as a browser makes them; `{ endpoint, keys: { p256dh, auth }, privateKey: CryptoKey }`),
  `decryptPushBody(body: Uint8Array, sub: HarnessPushSubscription): Promise<Uint8Array>` (RFC
  8291 / RFC 8188 `aes128gcm`), `verifyVapidAuthorization(header: string, endpoint: string,
  vapidPublicKey: string, nowMs: number): Promise<{ aud: string; sub: string; exp: number }>`.
- Step stubs, each exporting `step: N1Step` whose `run` is `notMerged("<unit>")`:
  `harness/src/n1/inapp.ts` (1) and `cooldown.ts` (3) N1-fanout; `email.ts` (2) N1-email;
  `push.ts` (4) N1-push; `inbox.ts` (5) N1-inbox; `pwa.ts` (6) and `push-web.ts` (7) N1-pwa.
- `harness/scenarios/notifications.ts` (orchestrator; units never edit it): `inFull: false`,
  `needs: ["api", "web", "chat", "mail", "worker", "media", "ffmpeg", "browser"]`, steps from
  `run.ts`, `--set steps=`, `--set via=`; description: "follow → go live → in-app row → email
  digest with one-click unsubscribe → cooldown holds across a restart → encrypted web push to a
  local endpoint → bell and settings → installable PWA and the service worker's push → push
  from the browser toggle". Every step module stays in `harness/src/n1/` so CI's import-graph
  selection (`scripts/ci-changes.ts`) maps it to this scenario.
- At the end of the milestone the orchestrator sets `inFull` true, adds `notifications` to
  `FULL_REQUIRED` (`harness/src/registry.ts:33-62`) and to a shard (`harness/src/shards.ts:11-17`
  and the CI matrix): W1's `features` shard (`["timeline-sync", "surge-guard"]`, W1 §9; decided
  2026-10-30), unless the measured shard time passes ~12 minutes, then its own `notify` shard,
  updating tests that pin the shard list.

## 10. Legal drafts (counsel not reviewed)

### 10.1 `packages/db/src/legal/privacy.md`: a section after "## Peer-to-peer sharing" (`:60`)

```md
## Notifications

When a channel you follow goes live, we tell you in the app. We email you about it only if you
turn go-live emails on, and only at an address you have verified; every such email has a
one-click unsubscribe link. You get at most one go-live notification per channel within a few
hours, however often the stream restarts. We delete notifications after 90 days, and go-live
notifications you have read after 30 days.

**Browser push** is off unless the operator offers it and you turn it on in a browser. Your
browser then gives us an address at its push service, which your browser's maker runs (for
example Google, Mozilla or Apple), and two encryption keys. We store them encrypted and delete
them when you turn push off, sign out in that browser, or the push service tells us they no
longer work. Each push message is encrypted so that only your browser can read it, and it holds
only the channel name and stream title. The push service learns that a message was sent to your
browser, and when, but not what it says.

**Discord.** A streamer can connect their channel to a Discord channel through a Discord webhook.
When they go live, we post their channel link and stream title there, and Discord's own terms
and privacy policy apply to that post. We store the webhook address encrypted and never show it
again.
```

### 10.2 `packages/db/src/legal/cookies.md`: two items at the end of "## Essential (always on)" (`:22-33`)

```md
- **App files.** So the site loads quickly and can be installed as an app, your browser keeps
  copies of the site's own program files (scripts, styles and icons) in a cache. They hold
  nothing about you, and nothing you watch, read or type is cached.
- **Push permission.** If you turn on browser notifications, your browser remembers that you
  allowed them and keeps a push subscription for this site. Turning notifications off in your
  settings, or signing out in that browser, removes the subscription.
```

### 10.3 `packages/db/src/legal/index.ts` and the seed test

Bump `PRIVACY_SEED_VERSION` (`:38`) and `COOKIES_SEED_VERSION` (`:44`) to
`"<landing date>-notifications-draft"`. **The privacy bump goes on top of W1's** (decided
2026-10-30): W1 §2.6 moves privacy to `"2026-10-30-chat-replay-draft"`, and N1 adds one more
version string after it, which must sort after W1's (on the same date,
`"2026-10-30-notifications-draft"` does); both are drafts counsel has not reviewed. The cookies
version is not touched by W1; update the seed test that pins
them. Privacy `requiresAcceptance: true` (`:89`): members are asked to accept the new version.

## 11. Docs touched here

- `docs/decisions/0028-notifications.md`: an "Amendment 1 (N1 contract step)" listing §0's
  changes (the one-click route, the manifest from the instance, the mature-title rule with
  "mature" = `broadcasts.mature OR channels.mature`, the harness push approach, Discord without a
  harness step, one-click go-live unsubscribe also turning off per-channel email overrides).
- PROGRESS.md "In flight" gets the N1 units with their waves once the step is green.

## 12. Shared-file rules for the milestone (every brief repeats its part)

| Path                                                                                                                                                                                                 | Owner                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/**`, `packages/config/**`, `.env.example`, `packages/db/**`, `packages/tokens/**`                                                                                                | Orchestrator. Units send contract requests                                                                                                                                                                                                                                                   |
| `services/api/src/{router,http,main,env,index}.ts`, `notifications/queue.ts`, `routes/notifications.ts` (composer), `routes/me.ts`, `routes/channels.ts`, `lib/**`, `ops/hooks.ts`, `coop/shared.ts` | Orchestrator. Units own their `routes/notifications/<file>.ts` and `services/api/src/notifications/<area>/**`                                                                                                                                                                                |
| `services/worker/src/{outbox,context,worker,main,env,metrics}.ts`, `jobs/index.ts`, `notify/{outbox-jobs,settings}.ts`, `webhooks/**`, `deletion/**`, `exports/collectors.ts`                        | Orchestrator (`collectors.ts` too: W1 §4.7 adds `blocks.json`, this step adds its sections on top, both before wave 1; no unit writes it). Units own their job file and `services/worker/src/notify/<area>/**`, and create their own OTel instruments there with `meter("commonair.worker")` |
| `packages/email/**`                                                                                                                                                                                  | N1-email only (nobody else edits the email package in batch 4)                                                                                                                                                                                                                               |
| Route tree, `__root.tsx`, `site-chrome.tsx`, `nav.ts`, `_studio/dashboard.tsx`, `server/{http,env}.ts`, `server.ts`, `vite.config.ts`, `tsconfig.json`, `package.json`, `tests/nav.test.ts`          | Orchestrator. Units fill their placeholder routes and stub modules                                                                                                                                                                                                                           |
| i18n                                                                                                                                                                                                 | §7.3                                                                                                                                                                                                                                                                                         |
| Harness `scenarios/notifications.ts`, `src/n1/{run,push-receiver,selectors}.ts`, `scenario.ts`, `platform.ts`, `runner.ts`, `mailpit.ts`, `registry.ts`, `shards.ts`, compose overrides, CI          | Orchestrator. Units own their step modules (§9.3) and their tests                                                                                                                                                                                                                            |
| `docs/testing/*`, PROGRESS.md, ADRs, READMEs, `docs/self-hosting/{configuration,install}.md`                                                                                                         | Orchestrator; units propose text. Units own the docs page their brief names                                                                                                                                                                                                                  |
| `apps/web/tests/selectors.test.ts`                                                                                                                                                                   | Orchestrator adds the n1 check after N1-inbox, N1-pwa and N1-discord merge                                                                                                                                                                                                                   |
| `apps/web/tests/source-policy.test.ts` (the `theme.ts` allowlist, §7.2)                                                                                                                              | Orchestrator                                                                                                                                                                                                                                                                                 |

## 13. Waves (N1's part of batch 4)

At most six units at a time across the batch; W1's units fill the other slots.

W1's step (`.claude/briefs/w1/contract-step.md` §12) puts its six units in wave 1 and leaves
five slots of wave 2 to N1. Units branch from `main` after the previous wave merged.

| Wave | Units                                                                   | Why                                                                                                                                                                                                                                                                                                                                                                                               |
| ---- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | the six W1 units (W1's step)                                            | W1's choice; N1 needs nothing from them, and nothing in N1 must precede them                                                                                                                                                                                                                                                                                                                      |
| 2    | N1-fanout, N1-email, N1-push, N1-inbox, N1-pwa, beside W1-data-mode (6) | Disjoint files by §5.1, §6.1, §7 and §12; every unit codes against this step's tables, procedures, jobs, payloads and stubs (including `harness/src/n1/ece.ts`'s signatures), with fixtures where another unit's output is the input. Fan-out is the backbone; email, push and the bell consume what it writes but compile and test without it. All five in one wave keeps batch 4 at three waves |
| 3    | N1-discord (alone)                                                      | ADR 0028 decision 5: the optional proprietary adapter comes last, after the FOSS path (in-app, email) and push are merged and green                                                                                                                                                                                                                                                               |

Harness steps run on the stack only when every unit they touch has merged (1 and 3 need
N1-fanout; 2 also N1-email; 4 also N1-push; 5 N1-fanout and N1-inbox; 6 N1-pwa; 7 N1-fanout,
N1-push and N1-pwa): the orchestrator lifts
a step from `PENDING_N1_STEPS` then.

## 14. Done means for the contract step

CI green on the pushed commit; locally, targeted: `bun --bun vp test run` (and `test:int` where
they exist, one package at a time) in `packages/contracts`, `packages/db`, `packages/config`,
`packages/tokens`, `services/api`, `services/worker`, `apps/web`, `harness`, `scripts`; `bunx tsc
-p` for each (and `apps/web/src/sw`); `vp build` in `apps/web`; `bun scripts/config-reference.ts
--check`; `bun scripts/selfhost/unit-env.ts --check`; `reuse lint`. 11 `notImplemented` handlers
under `routes/notifications/`. Then record the units under "In flight" in PROGRESS.md and hand
each unit its brief and the sha.

## 15. N1 milestone done means

- No `notImplemented` under `services/api/src/routes/notifications/`.
- `notifications` passes on the harness stack with no pending steps, with `--profile
  no-proprietary` (steps 4 and 7 skipped, the rest green), is in `FULL_REQUIRED` with `inFull`
  true and in W1's `features` CI shard, or in its own `notify` shard if joining pushes `features`
  past ~12 minutes (decided 2026-10-30; the orchestrator measures at the milestone end); CI green
  on main.
- Step 6's installability check passes (no installability errors).
- The n1 selectors check is in `apps/web/tests/selectors.test.ts`.
- `privacy.md` and `cookies.md` carry the drafts at the bumped versions (counsel not reviewed).
