<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0028: Go-live notifications, web push and the PWA

- Status: accepted (2026-10-27; the maintainer accepted the recommended answers, see
  [Decisions at acceptance](#decisions-at-acceptance-2026-10-27))
- Date: 2026-10-27 (code checked at `ccf9c17`)

## Context

Milestone N1 (`.claude/briefs/next/N1-notifications-pwa.md`, batch 4 with W1) tells followers
when a channel goes live: in the app, by email, by opt-in browser push, and on the streamer's
Discord. Web push needs a service worker, so the web app becomes an installable PWA in the same
milestone. N4 (federation, [ADR 0030](0030-federation.md)) reuses the go-live fan-out built here.

What the code has today:

- **The go-live event exists.** `stream.online` is a public catalog event
  (`packages/contracts/src/events.ts:75`), written to the outbox in the transaction that starts a
  broadcast (`services/api/src/media/hooks.ts:120-126`). Its payload carries the broadcaster and
  broadcast id, not the title; the title is on the broadcast row the same transaction inserts.
- **The outbox relay only feeds the bus and webhooks.** It publishes each row to Valkey and
  enqueues a webhook fan-out only for event types that have an enabled webhook subscription
  (`services/worker/src/outbox.ts:110-133`). Nothing else reacts to `stream.online` yet.
- **In-app notifications exist without a writer for go-live.** `notifications` holds
  `userId`, `type`, a JSON `payload` and `readAt` (`packages/db/src/schema/channels.ts:167-180`);
  `go_live` is in `NOTIFICATION_TYPES` (`packages/contracts/src/enums.ts:217-218`). Moderation,
  leaks, governance and statements of reasons insert rows
  (`services/api/src/moderation/notify.ts:23`, `services/worker/src/moderation/records.ts:139`,
  `services/worker/src/moderation/scan.ts:316`, `services/api/src/lib/leaks.ts:48`,
  `packages/governance/src/lifecycle.ts:237`, `services/worker/src/moderation/sor-deliver.ts:181`);
  nothing inserts `go_live`. `me.notifications` (cursor list) and `me.markNotificationsRead`
  already exist (`services/api/src/routes/me.ts:201-243`); the web app has no bell or list.
- **Follows carry one switch.** `follows.notify` defaults to true, and integrity-excluded follows
  are kept with `excludedAt` set (`packages/db/src/schema/channels.ts:141-143`). There are no
  per-type or per-medium preferences.
- **Email can carry one-click unsubscribe, but nothing answers it.** The mailer turns a
  template's `unsubscribeUrl` into `List-Unsubscribe` and `List-Unsubscribe-Post`
  (`packages/email/src/mailer.ts:84-91`). The governance templates take one, and the samples point
  it at `/settings/notifications/unsubscribe?list=governance` (`packages/email/src/samples.ts:85`),
  which no route serves. There is no go-live template (`packages/email/src/registry.ts:20-40`).
- **Outbound HTTP to user-supplied URLs has a guard.** `resolveCallback` requires https, rejects
  credentials in the URL, requires every resolved address to be public, and pins the address it
  connects to so DNS rebinding cannot redirect the request
  (`services/worker/src/webhooks/ssrf.ts:162-200`); `postWebhook` sends through it
  (`services/worker/src/webhooks/http.ts:29-40`). Retries use `DEFAULT_BACKOFF_MS`
  (`services/worker/src/webhooks/backoff.ts:7`).
- **Secrets at rest use one helper.** `encryptSecret` / `decryptSecret` (AES-256-GCM, key derived
  from `AUTH_SECRET` per purpose, `packages/tokens/src/secrets.ts:30-60`) already protect simulcast
  stream keys and webhook secrets (`services/api/src/routes/stream.ts:252`,
  `services/worker/src/webhooks/deliver.ts:66`).
- **Instance tunables are unprotected governance settings**, such as `discovery.ranking`
  (`packages/db/src/seed.ts:110`), read with a short cache (`services/api/src/lib/settings.ts:31`).
- **No PWA.** `apps/web/public/` and a service worker do not exist. Discord exists only as a
  sign-in provider (`services/api/src/auth/index.ts:73`).

The constraint that shapes most of this is AGENTS.md rule 3: proprietary services are optional
adapters with a FOSS default. Web push is delivered by whichever push service the viewer's
browser uses (Google's for Chrome, Mozilla's for Firefox, Apple's for Safari). The instance does
not choose it and cannot replace it.

There are no self-hosters and no public instance yet, so the new tables and settings arrive
clean, with no data to migrate.

## Decisions

### 1. Web push is allowed, opt-in per instance and per viewer

`WEB_PUSH_ENABLED` (new, `packages/config/src/env.ts` and `.env.example`) defaults to false. When
it is off, the push subscribe procedures answer `PRECONDITION_FAILED` and the web app hides the
push toggle. When it is on, each viewer still opts in, per browser, through the browser's own
permission prompt, and only from a click on the toggle (never on page load).

Why this is compatible with rule 3:

- **The platform runs without it.** In-app and email are the FOSS path, always on, and cover
  every notification type. The harness `--no-proprietary` profile turns push off, and the
  `notifications` scenario (new in N1) must still pass on in-app and email alone.
- **The push service is the viewer's choice, not the instance's.** It comes with the browser the
  viewer picked; the instance only learns an endpoint URL the browser hands it.
- **The vendor learns almost nothing.** Payloads are end-to-end encrypted to the browser
  (RFC 8291, decision 2) and carry only the channel slug and the stream title, which are public
  on the channel page anyway. No user id, no follower list, no viewer data.

VAPID keys (an ECDSA P-256 key pair, RFC 8292) are generated by `bun scripts/init-env.ts` from a
new placeholder, like the existing signing keys. The VAPID `sub` claim is the instance contact
address from `instanceSite()` (rule 5).

### 2. RFC 8291 and VAPID are implemented in-repo on Web Crypto

Message encryption (ECDH P-256, HKDF-SHA-256, AES-128-GCM with the `aes128gcm` content coding of
RFC 8188) and the VAPID JWT (ES256) are all available in `crypto.subtle`. The module lives under
`services/worker/src/notify/push/` (new). Unit tests use the RFC 8291 Appendix A vector byte for
byte and the RFC 8188 examples; the harness decrypts a real Chromium subscription's payload.

Why: no new dependency to vet, pin and audit (rules 2 and 7, ADR 0022), and the surface is small
and fixed by RFCs with published vectors.

### 3. At most one go-live notification per channel per follower per 4 hours

The window is an instance setting, a new unprotected governance key `notifications.goLive`
(`packages/db/src/seed.ts`, beside `discovery.ranking`) with `cooldownHours: 4` and
`emailDigestMinutes: 5`. Members can change it by ordinary proposal like the other tunables.

The cooldown covers every medium together: if a follower got in-app, email or push for a channel
in the last four hours, a second `stream.online` for that channel sends them nothing. It is
decided by one conditional upsert on a small table, `notification_go_live_sends (user_id,
channel_id, last_sent_at)` (new), which is safe with several worker replicas (ADR 0032) because
the row lock decides who sends.

Why four hours: it absorbs OBS restarts, dropped connections and "one more try" restarts, which
come minutes apart, while a morning stream and an evening stream on the same day still alert
twice.

**Email goes as a digest.** Go-live emails are held for `emailDigestMinutes` from the first one
queued for a user; everything queued in that window goes out as one email listing each channel.
In-app rows and push are sent at once. The cost is that the first email can be up to five minutes
late, which is acceptable for email.

### 4. Preferences: `notification_preferences` (type x channel x medium)

A new table `notification_preferences (user_id, type, channel_id null, medium, enabled)`, with
`medium` one of `in_app`, `email`, `push`. A null `channel_id` is the user's default for that type;
a channel row overrides it. Built-in defaults when no row exists: go-live in-app **on**, go-live
email **off** (opt-in), go-live push **off** (it also needs the browser permission). Other types
keep their current in-app behaviour; N1 does not add email for them.

`follows.notify` stays as the per-channel bell: when it is false, no go-live goes out for that
channel in any medium. Preferences decide the media.

Fan-out skips follows with `excludedAt` set for email and push. Why: the integrity system
excludes follows it judges inauthentic, and a follow farm must not be able to turn a go-live into
outbound mail volume. Email also requires a verified address (`users.emailVerified`,
`packages/db/src/schema/auth.ts:20`).

Every go-live email carries a one-click unsubscribe for go-live email (RFC 8058, through the
existing mailer headers). N1-email builds the `/settings/notifications/unsubscribe` handler that
the samples already point at; for go-live it sets the user's default email preference for that
type to off, and it also serves the governance list those templates already link.

Rows cascade on account deletion, and the user's preferences go into their data export
(`services/worker/src/exports/collectors.ts`).

### 5. Discord: a webhook-only adapter, built last in N1

A streamer can paste a Discord channel webhook URL in the studio; go-live then posts there. No
Discord bot, no Discord application, no OAuth to Discord.

- The URL is a secret (anyone holding it can post to that Discord channel). It is stored with
  `encryptSecret` under its own purpose and never returned by the API; the studio shows only that
  one is set.
- Accepted hosts are Discord's webhook hosts (`discord.com`, `discordapp.com`, path
  `/api/webhooks/…`), and every send goes through `resolveCallback`, so the address is public and
  pinned (`services/worker/src/webhooks/ssrf.ts:162`).
- The post carries the channel URL and the stream title, with `allowed_mentions` set to parse
  nothing, so a title can never ping `@everyone`.
- The same four-hour cooldown applies per channel. A 429 is retried after Discord's
  `retry_after`; repeated 401/404 (the webhook was deleted) clears the setting and tells the
  streamer in-app.
- It is the last N1 unit (N1-discord), after fan-out, email, push, inbox and PWA are green.

Why webhook only: it needs no Discord credentials on the instance, so nothing changes in
`.env.example`, and the instance runs exactly the same without it (rule 3). The FOSS route to the
same result is EventSub: `stream.online` is a public event, so once E9 opens webhook subscriptions
([ADR 0027](0027-oauth-and-eventsub.md); `developer.events.subscribe` answers not-implemented
today, `services/api/src/routes/developer.ts:97`) a streamer can point one at Matrix, a
self-hosted bot or anything else.

### 6. Push subscriptions are stored encrypted and treated as user-supplied URLs

`push_subscriptions` (new): user id (cascade on deletion), the endpoint and its `p256dh` and
`auth` keys encrypted with `encryptSecret`, created and last-success times. The endpoint is a URL
the client chose, so sends go through `resolveCallback` like any webhook; only the harness sets
`allowInsecure` for its local push endpoint. A 404 or 410 from the push service deletes the
subscription. Sign-out from a browser removes that browser's subscription. Endpoints are never
logged (rule: no tokens in logs); logs carry the subscription id.

### 7. Service worker scope: app shell and icons only

`apps/web/src/sw.ts` (new) is same-origin and bundled with the app (rule 4). It precaches the
hashed app shell assets and icons and nothing else. `/api`, `/media`, chat, uploads and every
response that depends on who is signed in are network-only and never cached. There is no offline
playback and no background sync. Each deploy uses a new cache name; old caches are deleted on
activate, and the app shows an update prompt rather than reloading under the viewer.

The push handler shows a notification built from the slug and title in the payload, with the
"is live" text from the bundled i18n catalog (N2's infrastructure lands in batch 3, before N1),
and opens the channel page on click.

Why: nothing personal sits in a cache that outlives a session on a shared computer, and an
offline mode would add a second rendering path we would have to keep correct.

### 8. The fan-out runs in the worker from the outbox

`services/worker/src/jobs/notify-go-live.ts` (new) consumes `stream.online` once per event id,
reads the broadcast title and the channel's followers in pages, applies the bell, the
preferences, the cooldown and the exclusion rule, writes `go_live` rows (payload: channel id,
slug, broadcast id, title), and enqueues email, push and Discord jobs. Delivery is at least once,
so every step is keyed on the event id and the user.

## Consequences

- One go-live can mean many rows and sends for a large channel. Fan-out is paged and
  queue-backed so a big channel delays its own notifications, not the outbox.
- The outbox relay has to enqueue the go-live job for `stream.online` whether or not a webhook
  subscription exists; today it enqueues only "hooked" types (`services/worker/src/outbox.ts:131`).
  That is a change to a file N1-fanout does not own (see the milestone correction).
- Push depends on vendor services we do not run. If a vendor is down or blocks us, push silently
  degrades and in-app and email still work.
- A streamer who restarts after more than four hours alerts followers again; that is intended.
- The PWA install prompt and the push permission prompt are the browser's own UI and are not
  translatable by us; our toggle and explanation text are (i18n catalog).

## Alternatives considered

- **Push off entirely (rule 3 read strictly).** Rejected: push is what makes go-live useful on
  mobile, the viewer chooses the vendor, the payload is encrypted, and the FOSS path stays
  complete without it.
- **A self-hosted push service (ntfy, UnifiedPush).** Browsers only deliver Web Push through their
  vendor's service, so this does not reach browser users. UnifiedPush can be a later adapter for
  native clients.
- **A web-push npm package.** Workable after `vet-package`, but the RFC surface is small and
  vector-tested; one less dependency is worth more.
- **Cooldown per medium, or a short (15-minute) window.** Rejected: separate windows let one
  restart produce three alerts, and 15 minutes does not cover a troubled stream's restarts.
- **Cooldown in Valkey with a TTL.** Simpler, but a Valkey flush or failover resends to everyone;
  the row-level upsert is exact and cheap.
- **A Discord bot or app.** Needs credentials on the instance, a privileged-intent review and a
  second identity on Discord; a webhook does the one thing needed.
- **Caching API responses for offline use.** Rejected for privacy (decision 7).

## Decisions at acceptance (2026-10-27)

The maintainer accepted the recommended answers:

1. **Web push** is allowed, opt-in per viewer and per instance (`WEB_PUSH_ENABLED` off by default,
   VAPID keys from `init-env`), for the rule 3 reasons in decision 1.
2. **RFC 8291 and VAPID** are built in-repo on Web Crypto; no new dependency.
3. **Go-live cooldown:** at most one go-live notification per channel per follower per 4 hours,
   as an instance setting; email goes as a digest when several follows go live together.
4. **Preferences:** a `notification_preferences` table (type x channel x medium); go-live email off
   by default (opt-in), in-app on.
5. **Discord:** yes, webhook only (no bot or Discord app), a per-channel webhook URL encrypted at
   rest, sent through the worker SSRF guard, built as the last N1 unit.
6. **Service worker scope:** app shell and icons only; never media, API responses or anything
   personal; no offline playback.

Decided by the head agent within these answers (recorded so reviewers can check them):

- The cooldown is one window across all media, kept in `notification_go_live_sends`, and the
  instance setting is the governance key `notifications.goLive` with a 5-minute email digest
  window.
- Push is off by default for each viewer even when the instance enables it.
- Integrity-excluded follows get in-app rows but no email or push.
- Push endpoints are treated as user-supplied URLs (SSRF guard, encrypted at rest).
- Discord posts never mention anyone, and a dead webhook clears itself.

## Amendment 1 (N1 contract step)

- Status: accepted (2026-10-30; orchestrator defaults and the maintainer's answers, batch 4
  decisions (g), (n) and (o))
- Date: 2026-10-30 (code checked at `a43aa6b`, landed on top of the W1 contract step)
- Scope: where the code differed from this ADR's plan, and what the N1 contract step
  ([`.claude/briefs/n1/contract-step.md`](../../.claude/briefs/n1/contract-step.md) §0) decided
  within the decisions above. Migrations `0039_n1_notifications` and `0040_n1_protections`.

**Counsel has not reviewed the privacy and cookie paragraphs** this step adds; they land as
drafts, and the privacy bump asks members to accept again.

1. **One-click unsubscribe lives on the API.** `List-Unsubscribe` points at
   `/api/email/unsubscribe?list=…&token=…` (same origin as the site): `POST` applies it (RFC 8058),
   `GET` answers 303 to the web confirm page `/settings/notifications/unsubscribe` with the same
   query. The web server sends every non-API request to SSR and the dev server has no POST route,
   so a one-click POST to a web page could not be answered. A one-click go-live unsubscribe also
   turns off the member's per-channel email overrides, so no channel keeps mailing them.
   `list=governance` stores email-off rows for `proposal` and `vote_open`, ready for when
   governance mail has a sender.
2. **The manifest comes from the instance.** One web image serves every instance and the name must
   come from `instanceSite()`, so the web server builds `/manifest.webmanifest` from the instance
   config; `public/` holds only icons. The two `theme-color` values are the app's only colour
   literals (`apps/web/src/pwa/theme.ts`), because a manifest and a meta tag cannot read CSS
   variables.
3. **Mature broadcasts without the title.** A follower who has not confirmed 18+ is still notified
   of a mature broadcast, with an empty title (email and push say only "is live"). "Mature" is
   `broadcasts.mature OR channels.mature`, read when the message is built, since a channel can be
   labelled mature after the broadcast started. Fan-out, email, push and Discord use this one rule.
4. **Harness push without a vendor.** Headless Chromium cannot subscribe without a vendor push
   service, so the harness makes its own subscription keys, registers them over the API (or through
   the web toggle with `PushManager.subscribe` stubbed), receives the real encrypted POST on its own
   receiver and decrypts it; the service worker's push handler is driven with CDP
   `ServiceWorker.deliverPushMessage`. `webPush` is a proprietary harness need (skipped under
   `--profile no-proprietary`) but not part of that profile's preflight, because the harness stack
   pushes only to its own receiver (`WEB_PUSH_ALLOW_INSECURE_ENDPOINTS`, harness only).
5. **Discord has no harness step.** N1-discord is covered by unit and integration tests against a
   local TLS receiver with an injected resolver; no test-origin setting is added.
6. **Smaller decisions within this ADR:** the email digest is a 30-second sweep over
   `notification_email_queue` (replica-safe, nothing lost on a Valkey flush); go-live email strings
   carry no counts; the bell is a popover with no `/notifications` page; a push subscription
   belongs to the last member who subscribed that browser, and sign-out there deletes it; turning
   push on in a browser also turns the member's go-live push default on; user blocks do not affect
   go-live notifications; `notify-prune` deletes notifications older than 90 days and read
   `go_live` rows older than 30 days; push sends use a generalized pinned POST
   (`postPinned`) instead of the EventSub `postWebhook`, which stays a wrapper.
