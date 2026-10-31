<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# seed-platform: OAuth apps and tokens, EventSub, webhooks, notifications, push and Discord

You are implementing unit seed-platform for CommonAir (repo: /Users/joshe/Repos/bcon).

Read these first:

- AGENTS.md
- PLAN.md
- docs/architecture.md
- `.claude/briefs/seed-full/README.md`
- `.claude/briefs/seed-full/common.md`

common.md holds the shared rules, the read-only contract and the tests every unit adds, and all of
it applies here. Do not look outside the repository.

Your branch is `seed/platform`, cut from `main` after seed-social merges. This is wave 1.

## You own (write only these)

- `harness/src/seed/platform.ts`, `harness/src/seed/platform/**`
- `harness/tests/seed/platform*.test.ts`

## Contracts you must honor (read-only for you)

- The developer, OAuth, EventSub, notifications and push procedures in `@commonair/contracts`.
- `docs/decisions/0027-oauth-and-eventsub.md`.
- `harness/src/e9/**`: the receiver, the WebSocket client and the OAuth flow helpers.
- `harness/src/n1/**`: inbox, push and Discord.
- `harness/src/mailpit.ts`.
- The VAPID keys from `init-env --merge`.
- The unsubscribe-token format: read how the API mints and verifies it.

## Build

1. **Apps.**
   - `developer` registers several apps through the API: a confidential web app, a public PKCE
     app, and a device-flow app.
   - streamer1 registers its bot app.
   - `admin` suspends one bulk developer's app, so `/admin/apps` shows both states.
   - Publish `store.extra.platform.appId`, which is developer's main app.
2. **Grants.**
   - viewer1 authorizes two apps through the real authorize and token flow, so it gets
     `oauth_codes` and `oauth_tokens`, then revokes one.
   - Publish `authorizeQuery`: a valid `/oauth2/authorize` query for an app viewer1 has not yet
     authorized. Include client_id, redirect_uri, response_type, scope, state and the PKCE
     challenge.
3. **Device flow.**
   - Start a device authorization through the API and publish `activateQuery` with its user code.
   - Device codes expire quickly, so the coverage visit must happen within the TTL. Say so in
     `notes`.
   - The table is plain. If the TTL is shorter than the time the seed takes to finish, also insert
     a second pending device code directly with a longer expiry, and publish that one instead.
4. **EventSub and webhooks.**
   - Run a local receiver for the life of the unit. Reuse the e9 receiver and bind it to
     `127.0.0.1` on a free port.
   - `developer` subscribes to several event types, with webhooks pointing at the receiver, and
     another subscription pointing at a closed port.
   - Then trigger events. These can be follows or chat events through the API, whatever the
     subscriptions cover.
   - The result in `webhook_deliveries` should be delivered rows, plus failed and retrying rows.
     Stop the receiver before returning, and note that later deliveries will fail.
5. **Notifications.**
   - viewer1's inbox gets each notification type. Insert those rows directly: `notifications` is a
     plain table. Give them a mix of read and unread, backdated.
   - `notification_preferences` for several users.
   - `notification_go_live_sends` history.
   - A drained `notification_email_queue`. The emails go to Mailpit, and the queue state must
     match what the worker leaves.
   - Publish `unsubscribeQuery`, a valid signed unsubscribe link for viewer1. If the token can't be
     minted outside the API, use a link the API itself sent to Mailpit (`findTokenLink`).
6. **Push.**
   - `push_subscriptions` for viewer1, pointing at a local sink endpoint, using the VAPID public
     key. Fail with the exact fix if the VAPID keys are missing.
7. **Discord.**
   - streamer1 sets up `discord_webhooks` that point at a local sink.
   - If the API only accepts discord.com URLs, insert the row directly. The table is plain, so a
     direct insert is allowed; say so in `notes`. Never point at a real Discord host.

## Tests you must add

- The tests in common.md.
- Every published query parses with the route's search schema, or at least has the expected keys.
- No URL in any row points outside `127.0.0.1`, `localhost`, `.invalid` or `.test`.
- Delivery states cover delivered, failed and retrying.

## Routes you fill

- `/activate` and `/oauth2/authorize`
- `/settings/connections`
- `/settings/notifications/` and `/settings/notifications/unsubscribe`
- `/developer/`, `/developer/bots` and `/developer/apps/$appId`
- `/admin/apps`
- viewer1's inbox

## Done means

common.md "Done means".
