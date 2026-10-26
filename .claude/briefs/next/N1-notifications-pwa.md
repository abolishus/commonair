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
  with `go_live` (`enums.ts:182`), `follows.notify` default true (`channels.ts:141`). Nothing
  writes `go_live` rows; the only insert is moderation (`services/worker/src/moderation/records.ts:139`).
- No go-live email template (`packages/email/src/registry.ts:15-32`), no per-type preferences,
  only the email unsubscribe link (`packages/email/src/samples.ts:76`).
- No web manifest, no service worker, no `apps/web/public/`.
- Discord exists only as a sign-in provider.

## Decisions first: ADR 0028 (notifications)

- **Web push and AGENTS.md rule 3.** The push service is whichever one the viewer's browser
  uses (FCM for Chrome, Mozilla's for Firefox, Apple's for Safari), so push is proprietary
  plumbing the instance does not choose. Default: in-app and email are the FOSS path and always
  work; push is opt-in per viewer and per instance (`WEB_PUSH_ENABLED`, VAPID keys from
  `init-env`); payloads are encrypted (RFC 8291) and carry only the channel slug and title.
- **Rate limits.** At most one go-live per channel per follower per N hours (a streamer
  restarting OBS must not spam); email goes as a digest when several follows go live together.
- **Preferences:** a `notification_preferences` table (type × channel × medium), defaults off
  for email go-live (opt-in), on for in-app.
- **Discord:** an optional adapter, a per-channel webhook URL, sent through the worker's
  existing SSRF guard (`services/worker/src/webhooks/ssrf.ts`); the URL is a secret (encrypted
  at rest like other credentials).
- **Library:** RFC 8291/VAPID through Web Crypto in-repo (recommended; no new dependency), or a
  vetted package via `bun scripts/vet-package.ts`.
- **Service worker scope:** app shell and icons only; never caches media, API responses or
  anything personal; no offline playback.

## Units

| Unit       | Owns                                                                                                            | Builds                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| N1-fanout  | `services/worker/src/jobs/notify-go-live.ts`, `services/worker/src/notify/**`                                   | consumes the `stream.online` outbox event, writes rows, applies limits, enqueues email/push/Discord |
| N1-email   | `packages/email/src/templates/notify.tsx`, its catalog keys                                                     | go-live and digest templates, unsubscribe per type                                                  |
| N1-push    | `services/worker/src/notify/push/**`, `services/api/src/routes/me.ts` (push subscription procedures), VAPID env | subscribe/unsubscribe, encrypted send, expired-endpoint cleanup                                     |
| N1-inbox   | `services/api/src/routes/notifications.ts`, `apps/web/src/components/notifications/**`, settings page           | notification bell, list, mark read, preferences UI                                                  |
| N1-pwa     | `apps/web/public/**` (manifest, icons), `apps/web/src/sw.ts`, Vite config entry                                 | installable manifest, service worker for shell and push, update prompt                              |
| N1-discord | `services/worker/src/notify/discord.ts`, studio setting                                                         | optional Discord webhook post                                                                       |

## Harness

`notifications`: viewer follows with email on; streamer goes live; the bell shows it, Mailpit
receives one email; a restart within the window sends nothing more; a Chromium push
subscription (Playwright grants the permission; a local push endpoint stands in for the vendor
service) receives an encrypted payload the test decrypts; `--no-proprietary` disables push and
Discord and the rest still passes.

## Done means

Scenario in `full`; Lighthouse-style installability check passes in the scenario; verify green.
