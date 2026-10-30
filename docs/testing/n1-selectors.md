<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N1 web ↔ harness contract (notifications and the PWA)

The N1 units (go-live fan-out, email, web push, the inbox and settings, the installable PWA and
the Discord adapter) and the `notifications` harness scenario agree on these routes and
`data-testid` values (ADR 0028). Changing one is a contract change: update this file, the web app
and the scenario together. Tests select by `data-testid` (never by visible text, which is
translated). `harness/src/n1/selectors.ts` lists the ids and `harness/tests/n1/selectors.test.ts`
checks them against this file.

## Rules

- Tests select by `data-testid`, never visible text. Numbers are plain integers in `data-*`.
- Booleans are `data-state="on|off"`; option items follow `<field>-<value>`.
- Push in the harness never reaches a vendor: the harness receiver is the endpoint and the stack
  runs with `WEB_PUSH_ALLOW_INSECURE_ENDPOINTS=true` (`harness/compose.n1.yaml`).
- Email unsubscribe links point at the API (`/api/email/unsubscribe?list=…&token=…`): `POST`
  applies (RFC 8058 one-click), `GET` answers 303 to the web confirm page with the same query.

## Routes

| Path                                          | Who       | Unit       |
| --------------------------------------------- | --------- | ---------- |
| `/settings/notifications`                     | signed in | N1-inbox   |
| `/settings/notifications/unsubscribe`         | anyone    | N1-email   |
| `/dashboard` (Discord section)                | owner     | N1-discord |
| `/manifest.webmanifest`, `/sw.js`, `/icons/*` | anyone    | N1-pwa     |

## Test ids

### Header (signed in)

| Test id                      | Element / meaning                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `notification-bell`          | The bell button: `data-unread` (unread count, capped at 99), `data-capped` (`true`/`false`)     |
| `notification-bell-badge`    | The unread badge; absent at 0                                                                   |
| `notification-list`          | The popover's list (newest 20)                                                                  |
| `notification-item`          | One notification: `data-id`, `data-type` (`NOTIFICATION_TYPES`), `data-state` (`read`/`unread`) |
| `notification-item-link`     | The item's link (a `go_live` item links `/<slug>`)                                              |
| `notification-mark-all-read` | Marks every notification read                                                                   |
| `notification-load-more`     | Loads the next page inside the popover                                                          |
| `notification-empty`         | Shown instead of the list when there is nothing                                                 |
| `notification-settings-link` | Link to `/settings/notifications`                                                               |
| `account-notifications-link` | The account menu's entry for `/settings/notifications`                                          |
| `nav-signout`                | The account menu's sign-out entry (step 7 signs out to drop the subscription)                   |

### Settings (`/settings/notifications`)

| Test id                        | Element / meaning                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `notify-default-in_app`        | Switch: the member's default for in-app go-live; `data-state`, `data-builtin` (`true`/`false`) |
| `notify-default-email`         | Switch: the default for go-live email; `data-state`, `data-builtin`                            |
| `notify-default-push`          | Switch: the default for go-live push; `data-state`, `data-builtin`                             |
| `notify-email-unverified`      | Notice: email notifications need a verified address                                            |
| `notify-channel`               | One followed channel: `data-slug`                                                              |
| `notify-channel-bell`          | Switch: the follow's `notify` (the per-channel bell); `data-state`                             |
| `notify-channel-email`         | Select: the channel's email override; options below                                            |
| `notify-channel-email-default` | Option: no override (the member's default applies)                                             |
| `notify-channel-email-on`      | Option: email on for this channel                                                              |
| `notify-channel-email-off`     | Option: email off for this channel                                                             |
| `notify-channel-push`          | Select: the channel's push override; options below                                             |
| `notify-channel-push-default`  | Option: no override                                                                            |
| `notify-channel-push-on`       | Option: push on for this channel                                                               |
| `notify-channel-push-off`      | Option: push off for this channel                                                              |
| `notify-save-error`            | A save failed                                                                                  |

### Push toggle (inside settings)

| Test id            | Element / meaning                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `push-toggle`      | Switch: browser push in this browser; `data-state` (`unsupported`, `unavailable` (the instance has push off), `denied`, `off`, `on`, `busy`) |
| `push-unsupported` | Notice: this browser cannot receive push                                                                                                     |
| `push-denied-help` | Help: notifications are blocked in the browser's site settings                                                                               |

### Unsubscribe page (`/settings/notifications/unsubscribe`)

| Test id               | Element / meaning                                          |
| --------------------- | ---------------------------------------------------------- |
| `unsubscribe-page`    | The page: `data-list` (`UNSUBSCRIBE_LISTS`)                |
| `unsubscribe-confirm` | Confirms the unsubscribe                                   |
| `unsubscribe-done`    | Shown after it applied                                     |
| `unsubscribe-invalid` | Shown instead of the button for a missing or invalid token |

### PWA

| Test id             | Element / meaning                 |
| ------------------- | --------------------------------- |
| `pwa-update-prompt` | A new version of the app is ready |
| `pwa-update-reload` | Reloads into the new version      |

### Discord (studio dashboard)

| Test id                          | Element / meaning                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `discord-webhook-section`        | The section on `/dashboard`                                                           |
| `discord-webhook-status`         | `data-configured` (`true`/`false`), `data-error` (`DISCORD_WEBHOOK_ERRORS`, or empty) |
| `discord-webhook-input`          | The webhook URL input (never prefilled: the stored URL is never shown)                |
| `discord-webhook-save`           | Saves the URL                                                                         |
| `discord-webhook-test`           | Sends a test post                                                                     |
| `discord-webhook-remove`         | Opens a `ConfirmDialog` to remove the webhook                                         |
| `discord-webhook-remove-confirm` | Confirms the removal                                                                  |

## Scenarios

`notifications` (ADR 0028; `harness/src/n1/`, one module per step), `--set steps=` and
`--set via=api|web`:

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
   The PWA steps run Chromium's new headless mode with a persistent profile
   (`channel: "chromium"`, which `playwright install chromium` provides).
7. **Push from the browser** (N1-pwa; web only; harness need `webPush`; needs 4 and 6): with
   `PushManager.subscribe` stubbed to return a harness subscription and the `notifications`
   permission granted, `push-toggle` goes `off` → `on`, `push.status().subscriptions` is 1, the
   **fourth** streamer (a channel that has not gone live yet: step 4's channel is in its cooldown)
   goes live and its go-live reaches the receiver and decrypts; signing out removes it
   (`subscriptions` 0 on the next sign-in).

Discord has no harness step (ADR 0028 Amendment 1): N1-discord is covered by unit and integration
tests against a local TLS receiver. Steps run on the stack only once their units have merged
(`PENDING_N1_STEPS` in `harness/src/n1/run.ts`).
