<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N1: go-live notifications and the installable PWA

**Goal.** When a followed channel goes live, followers who asked for it learn about it in the
app, by email and (opt-in) by browser push; a streamer can post go-live to their Discord. The
web app installs as a PWA, which web push needs anyway.

## State

- `notifications` table (`packages/db/src/schema/channels.ts:167-180`), `NOTIFICATION_TYPES`
  with `go_live` (`enums.ts:217-218`), `follows.notify` default true (`channels.ts:141`).
  Nothing writes `go_live` rows. Other types are inserted by moderation
  (`services/worker/src/moderation/records.ts:139`, `services/worker/src/moderation/scan.ts:316`,
  `services/worker/src/moderation/sor-deliver.ts:181`, `services/api/src/moderation/notify.ts:23`),
  leak checks (`services/api/src/lib/leaks.ts:48`) and governance
  (`packages/governance/src/lifecycle.ts:237`).
- `me.notifications` (list) and mark-read already exist (`services/api/src/routes/me.ts:201-243`).
- The outbox relay enqueues only event types that have a webhook subscription
  (`services/worker/src/outbox.ts:110-133`), so nothing would start a go-live job today.
- No go-live email template (`packages/email/src/registry.ts:15-32`), no per-type preferences,
  only the email unsubscribe link (`packages/email/src/samples.ts:85`,
  `/settings/notifications/unsubscribe?list=governance`), which has no handler yet.
- No web manifest, no service worker, no `apps/web/public/`.
- Discord exists only as a sign-in provider.

## Decisions: [ADR 0028](../../../docs/decisions/0028-notifications.md) (accepted 2026-10-27)

- **Web push and AGENTS.md rule 3.** The push service is whichever one the viewer's browser
  uses (FCM for Chrome, Mozilla's for Firefox, Apple's for Safari), so push is proprietary
  plumbing the instance does not choose. Default: in-app and email are the FOSS path and always
  work; push is opt-in per viewer and per instance (`WEB_PUSH_ENABLED`, default off; VAPID keys
  from `init-env`); payloads are encrypted (RFC 8291) and carry only the channel slug and title.
  Push subscriptions (`push_subscriptions`, new) are stored encrypted and sent through the SSRF
  guard like any user-supplied URL.
- **Rate limits.** At most one go-live per channel per follower per 4 hours, across all media,
  kept in `notification_go_live_sends` (new); the window and a 5-minute email digest are the
  governance key `notifications.goLive` (`cooldownHours`, `emailDigestMinutes`).
- **Preferences:** a `notification_preferences` table (type × channel × medium), defaults off
  for email go-live (opt-in) and push, on for in-app. Integrity-excluded follows get in-app rows
  but no email or push.
- **Discord:** webhook only (no bot, no Discord app), a per-channel webhook URL encrypted at rest,
  sent through the worker's existing SSRF guard (`services/worker/src/webhooks/ssrf.ts`), with no
  mentions; built last. The FOSS alternative (an EventSub webhook to Matrix or a self-hosted bot)
  works only once E9 opens webhook subscriptions; `developer.events.subscribe` is
  not-implemented today (`services/api/src/routes/developer.ts:97`).
- **Library:** RFC 8291/VAPID through Web Crypto in-repo (decided; no new dependency).
- **Service worker scope:** app shell and icons only; never caches media, API responses or
  anything personal; no offline playback.

## Contract step

`notification_preferences`, `notification_go_live_sends` and `push_subscriptions` tables;
`WEB_PUSH_ENABLED` and the VAPID env vars in `packages/config/src/env.ts` and `.env.example`
(and their `init-env` placeholders); the `notifications.goLive` seed key; the change to
`services/worker/src/outbox.ts` so the relay enqueues the go-live job for `stream.online` whether
or not a webhook subscription exists. N4 also needs an `outbox.ts` change (internal events to the
worker), so the two are made together in one contract step or coordinated.

## Units

| Unit       | Owns                                                                                                            | Builds                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| N1-fanout  | `services/worker/src/jobs/notify-go-live.ts`, `services/worker/src/notify/**`                                   | consumes the `stream.online` outbox event, writes rows, applies limits, enqueues email/push/Discord      |
| N1-email   | `packages/email/src/templates/notify.tsx`, its catalog keys, the `/settings/notifications/unsubscribe` handler  | go-live and digest templates, one-click unsubscribe per type; the handler also serves `?list=governance` |
| N1-push    | `services/worker/src/notify/push/**`, `services/api/src/routes/me.ts` (push subscription procedures), VAPID env | subscribe/unsubscribe, encrypted send, expired-endpoint cleanup                                          |
| N1-inbox   | `services/api/src/routes/notifications.ts`, `apps/web/src/components/notifications/**`, settings page           | notification bell and list on the existing list and mark-read procedures, preferences procedures and UI  |
| N1-pwa     | `apps/web/public/**` (manifest, icons), `apps/web/src/sw.ts`, Vite config entry                                 | installable manifest, service worker for shell and push, update prompt                                   |
| N1-discord | `services/worker/src/notify/discord.ts`, studio setting                                                         | optional Discord webhook post                                                                            |

## Harness

`notifications` (new in N1): viewer follows with email on; streamer goes live; the bell shows
it, Mailpit receives one email; a restart within the window sends nothing more; a Chromium push
subscription (Playwright grants the permission; a local push endpoint stands in for the vendor
service) receives an encrypted payload the test decrypts; `--no-proprietary` disables push and
Discord and the rest still passes.

## Done means

Scenario in `full`; Lighthouse-style installability check passes in the scenario; verify green.
