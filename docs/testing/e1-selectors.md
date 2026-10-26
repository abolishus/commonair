<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E1 web ↔ harness contract

The minimal web app (`apps/web`) and the `e2e-basic` harness scenario agree on these routes and
`data-testid` values. Changing one is a contract change: update this file, the web app and the
scenario together. Tests select by `data-testid` (never by visible text, which is translated).

## Serving

- The web server listens on `WEB_PORT` (3000) and answers `GET /healthz` with 200 JSON.
- It proxies `/api/*` and `/rpc/*` to `API_INTERNAL_URL` (same origin, so better-auth cookies are
  first-party and the verification link in the email — `PUBLIC_URL` + `/api/auth/verify-email…` —
  works). It forwards the client address in `x-forwarded-for`.
- Chat connects straight to `CHAT_PUBLIC_URL` with a token from `chat.connectToken`. Playback
  playlists come from the origin URL that `playback.start` returns.
- Public URLs the browser needs are injected at SSR time from the instance env, never hardcoded.

## Routes

| Route             | Purpose                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| `/`               | Home: links to sign up / sign in, or to the dashboard when signed in      |
| `/signup`         | Sign up (email, username, password, birth date, legal acceptance, ALTCHA) |
| `/signin`         | Sign in with email + password                                             |
| `/dashboard`      | Signed-in streamer: ingest server URL, stream key, rotate key             |
| `/$channel`       | Channel page: player + chat (username = channel slug)                     |
| `/embed/$channel` | Player only, no chrome (used by `--player web`)                           |

After following the verification link the user lands signed in on `/dashboard` (or on `/signin`
if auto sign-in is unavailable; the scenario handles both).

## Test ids

| Test id                    | Element / meaning                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `signup-email`             | email input                                                                               |
| `signup-username`          | username input                                                                            |
| `signup-password`          | password input                                                                            |
| `signup-birthdate`         | `<input type="date">` (value `YYYY-MM-DD`)                                                |
| `signup-legal`             | checkbox accepting the current legal documents (`role="checkbox"`; Playwright `.check()`) |
| `signup-altcha`            | wrapper of the ALTCHA widget; carries `data-state="verified"` once solved                 |
| `signup-submit`            | submit button (disabled until ALTCHA is verified)                                         |
| `signup-check-email`       | confirmation shown after a successful sign-up                                             |
| `resend-verification`      | button sending a new verification link (sign-in after `EMAIL_NOT_VERIFIED`, sign-up done) |
| `resend-verification-sent` | neutral confirmation after a resend (shown whether or not the address exists)             |
| `form-error`               | any form-level error message                                                              |
| `signin-email`             | email input                                                                               |
| `signin-password`          | password input                                                                            |
| `signin-submit`            | submit button                                                                             |
| `nav-user`                 | header element present only when signed in; `data-username` = the user's username         |
| `stream-server-url`        | ingest server URL (OBS "Server"), text content is the URL                                 |
| `stream-key-prefix`        | prefix of the active key (`stream.ingest` `activeKeyPrefix`), or empty when none          |
| `stream-key-rotate`        | button creating a new key (opens a `ConfirmDialog` when a key already exists)             |
| `stream-key`               | the full new key, rendered only right after `stream.rotateKey` (the API shows it once)    |
| `stream-key-copy`          | button copying the shown key                                                              |
| `confirm-dialog-confirm`   | the confirm button inside any `ConfirmDialog`                                             |
| `appearance-slot`          | dashboard avatar/banner control; `data-purpose` = `avatar` \| `banner`                    |
| `appearance-file`          | the slot's `<input type="file">` (visually hidden; Playwright `.setInputFiles()`)         |
| `appearance-preview`       | the slot's preview; `data-src` = shown URL (`blob:` while uploading), empty when none     |
| `appearance-upload`        | button opening the slot's file picker                                                     |
| `appearance-remove`        | button clearing the slot's theme key (only while one is set)                              |
| `channel-link`             | link from the dashboard to the user's own channel page                                    |
| `player`                   | wrapper of the player; `data-state` = `offline` \| `loading` \| `playing` \| `error`      |
| `player-video`             | the `<video>` element                                                                     |
| `live-badge`               | rendered only while the channel is live                                                   |
| `offline-state`            | rendered only while the channel is offline                                                |
| `chat`                     | chat panel; `data-state` = `connecting` \| `open` \| `closed`                             |
| `chat-input`               | message input (absent or disabled for anonymous viewers)                                  |
| `chat-send`                | send button                                                                               |
| `chat-signin-prompt`       | shown to anonymous viewers instead of the input                                           |
| `chat-message`             | one rendered message; `data-author` = sender username; text content includes the message  |
| `footer-source-link`       | AGPL "Source" link in the footer (`href` from `instance.info`)                            |

The full key exists only in the `stream.rotateKey` response, so the scenario always rotates:
click `stream-key-rotate`, confirm if `confirm-dialog-confirm` appears, read `stream-key`.
The stream key must be usable verbatim with the server URL as OBS does it: the publish URL is
`<stream-server-url>/<stream-key>`.
