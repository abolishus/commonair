<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E9 web ↔ harness contract (developer platform)

The E9 units (OAuth apps, the OAuth flows and consent, EventSub webhooks and the WebSocket, the
SDK, the developer console) and their harness scenarios agree on these routes and `data-testid`
values (ADR 0027). Changing one is a contract change: update this file, the web app and the
scenarios together. Tests select by `data-testid` (never by visible text, which is translated).
`harness/src/e9/selectors.ts` lists the ids and `harness/tests/e9/selectors.test.ts` checks them
against this file.

## Rules

- Tests select by `data-testid`, never visible text. Option items follow `<field>-<value>`.
- Secrets (client secrets, access, refresh, device and authorization codes, webhook secrets) are
  shown once in the UI, never logged by any service, never put in harness reports, never in URLs
  except the authorization `code` on the redirect and the one-time `resume` token on a
  `reconnect_url`. Prefixes: access `ca_`, refresh `car_`, client secret `cas_`, authorization
  code `cac_`, device code `cad_`, resume token `ces_`.
- Audit rows for `developer.app.suspend` and `developer.app.unsuspend` carry the app id and the
  reason code only.

## Routes

| Route                    | Purpose                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `/oauth2/authorize`      | New, signed in (returns after sign-in): consent for an app's authorization request; approve or deny         |
| `/activate`              | New, signed in: enter a device's user code (`?code=` prefills), then the same consent                       |
| `/settings/connections`  | New, signed in: apps you authorized, their scopes, revoke                                                   |
| `/developer`             | New, studio: your OAuth apps, register one                                                                  |
| `/developer/apps/$appId` | New, studio: one app: credentials, redirect URIs, secret rotation, delete; its subscriptions and deliveries |
| `/developer/bots`        | New, studio: bot accounts you own, their tokens; tokens authorized on your account                          |
| `/admin/apps`            | New, admins: every app; suspend with a reason, unsuspend                                                    |

## Test ids

### Consent (`/oauth2/authorize`)

| Test id                 | Element / meaning                                                                                                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oauth-consent`         | The consent card: `data-client-id`, `data-already-granted` (`true`/`false`)                                                                                                                                                                     |
| `oauth-consent-owner`   | Who registered the app (username)                                                                                                                                                                                                               |
| `oauth-consent-scope`   | One per requested scope: `data-scope` (the scope name)                                                                                                                                                                                          |
| `oauth-consent-approve` | Approve: the browser goes to the app's redirect URI with `code` and `state`                                                                                                                                                                     |
| `oauth-consent-deny`    | Deny: the browser goes to the redirect URI with `error=access_denied` and `state`                                                                                                                                                               |
| `oauth-consent-error`   | Shown instead of the card when the request cannot go back to the app: `data-error` (`invalid_client`, `invalid_redirect_uri`, `app_suspended`, `invalid_request`: the API refused the request as malformed, e.g. a `state` over 500 characters) |

### Device activation (`/activate`)

| Test id          | Element / meaning                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `device-form`    | `device-code` (input, `XXXX-XXXX`, dash optional), `device-submit`                                         |
| `device-consent` | The consent for that device: `data-client-id`; `oauth-consent-scope` rows; `device-approve`, `device-deny` |
| `device-done`    | After a decision: `data-result` (`approved`/`denied`)                                                      |
| `device-error`   | Unknown or expired code: `data-error` (`not_found`, `expired`)                                             |

### Connections (`/settings/connections`)

| Test id                    | Element / meaning                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `account-connections-link` | In the account menu, a link to `/settings/connections`                                                                      |
| `connections`              | Page wrapper; `connections-empty` `<EmptyState>`                                                                            |
| `connection`               | One authorized app: `data-app-id`, `data-client-id`, `data-scopes` (space-separated); `connection-revoke` (`ConfirmDialog`) |

### Developer console (`/developer`, `/developer/apps/$appId`)

| Test id                 | Element / meaning                                                                                                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `studio-developer-link` | In the studio sidebar, a link to `/developer`                                                                                                                                                                                                               |
| `devapps`               | Page wrapper; `devapps-empty`; `devapp-new` opens `devapp-form`                                                                                                                                                                                             |
| `devapp-form`           | `devapp-name`, `devapp-description`, `devapp-redirects` (one URI per line), `devapp-confidential` (switch, on by default), `devapp-submit`; inline errors `devapp-form-error`                                                                               |
| `devapp-row`            | One app: `data-app-id`, `data-client-id`, `data-suspended` (`true`/`false`); links to the app page                                                                                                                                                          |
| `devapp-secret`         | Dialog shown once after create (confidential) or rotate: `data-client-id`; `devapp-secret-value` (the secret as text), `devapp-secret-copy`, `devapp-secret-done`                                                                                           |
| `devapp`                | App page wrapper: `data-app-id`, `data-client-id`, `data-confidential`, `data-suspended`; `devapp-client-id` (text); `devapp-edit` (opens `devapp-form` filled); `devapp-rotate` (`ConfirmDialog`, then `devapp-secret`); `devapp-delete` (`ConfirmDialog`) |
| `devsubs`               | The app's subscriptions; `devsubs-empty`; `devsub-new` opens `devsub-form`                                                                                                                                                                                  |
| `devsub-form`           | `devsub-type` (items `devsub-type-<type>`), one `devsub-condition-<field>` input per condition field of the type, `devsub-callback`, `devsub-secret`, `devsub-submit`                                                                                       |
| `devsub`                | One subscription: `data-subscription-id`, `data-type`, `data-transport`, `data-status`; `devsub-test`, `devsub-deliveries` (opens the log), `devsub-delete` (`ConfirmDialog`)                                                                               |
| `devdelivery`           | One logged delivery: `data-delivery-id`, `data-message-type`, `data-status`, `data-response-status` (empty when none), `data-attempt`; `devdelivery-redeliver` (notifications; failed ones emphasised)                                                      |

### Bots and tokens (`/developer/bots`)

| Test id             | Element / meaning                                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devbots`           | Page wrapper; `devbots-empty`; `devbot-new` opens `devbot-form` (`devbot-username`, `devbot-display-name`, `devbot-submit`)                               |
| `devbot`            | One bot: `data-bot-id`, `data-username`; `devbot-token-new` opens `devbot-token-form`                                                                     |
| `devbot-token-form` | `devbot-scope-<scope>` checkboxes, `devbot-token-days`, `devbot-token-submit`; then `devbot-token-value` (shown once) and `devbot-token-done`             |
| `devtoken`          | One token authorized on your account or your bots': `data-token-id`, `data-app-id` (empty for personal), `data-kind`; `devtoken-revoke` (`ConfirmDialog`) |

### Apps (`/admin/apps`)

| Test id                 | Element / meaning                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `admin-apps-link`       | In the admin sidebar                                                                                                                      |
| `adminapps`             | Page wrapper; `adminapps-search`, `adminapps-filter-suspended` (switch); `adminapps-empty`                                                |
| `adminapp`              | One app: `data-app-id`, `data-client-id`, `data-suspended`, `data-grants`, `data-subscriptions`; `adminapp-suspend`, `adminapp-unsuspend` |
| `adminapp-suspend-form` | `adminapp-reason` (items `adminapp-reason-<reason>`, `APP_SUSPENSION_REASONS`), `adminapp-suspend-submit` (`ConfirmDialog`)               |

## Scenarios

- **`developer-platform`** (new; steps and owners in `harness/src/e9/`, one module per step):
  1. A developer registers a confidential app (redirect `http://127.0.0.1:<receiver>/cb`) and a
     public app over the API; updates the description; rotates the secret (the old secret then
     fails at the token endpoint with `invalid_client`).
  2. The streamer authorizes the confidential app over the API with PKCE (`S256`) for
     `chat:read channel:read:subscriptions channel:manage:polls channel:read:points` (the last two for
     step 5's E8 events); a wrong verifier → `invalid_grant`; the code twice →
     `invalid_grant` and the first family revoked; refresh rotates; replaying the old refresh token
     → `invalid_grant` and the newest access token fails `oauth2/validate`; re-authorize. Device
     flow with the public app: `authorization_pending`, then `slow_down` when polled faster than
     `interval`, approve, token. Client credentials: `oauth2/validate` shows `login: null`, scopes
     `[]`; `chat.send` with it → 403. `oauth2/revoke` on a refresh token kills its family.
  3. (web) The same authorization through `/oauth2/authorize` signed out → sign in → back to the
     consent → `oauth-consent-scope` per scope → approve → the receiver's `/cb` gets `code` and the
     same `state`; deny → `error=access_denied`; `/activate` approves a device code;
     `/settings/connections` lists the app with its scopes.
  4. With the app token, a webhook subscription to `channel.follow` (condition: the streamer) →
     the receiver answers the challenge → `enabled`; the viewer follows → one signed delivery
     (`verifyWebhook` true), in `developer.events.deliveries`; `sendTest` arrives; `redeliver`
     re-sends the same message id. Refused: `channel.chat.message` by webhook (WebSocket only); an
     app-token webhook for `channel.subscribe` of a broadcaster who never authorized the app.
  5. `ws://<api>/eventsub/ws` → `session_welcome` (keepalive 10); with the streamer's grant token,
     subscribe `channel.chat.message` (`broadcaster_user_id` = streamer, `user_id` = streamer),
     `channel.follow`, `channel.poll.begin` and `channel.points.change` (both `broadcaster_user_id`
     = streamer; E8's delivery check, e8/contract-step.md §0); the viewer chats and follows → two
     `notification`s; the streamer starts a poll (`interact.polls.create`) and rewards the viewer
     (`bot.points.adjust`, `reward`) → one `notification` each; `session_keepalive`
     after 10 idle seconds; a second socket that never subscribes closes with 4003; a fourth bound
     session for the grant is refused; the streamer revokes the app in
     `developer.grants.revoke` → `revocation` per subscription, then close 4008, and a chat socket
     opened with the same token closes too.
  6. A bot built on `@commonair/sdk` repeats 2, 4 and 5 through the SDK (PKCE and device helpers,
     the EventSub client, the webhook verifier rejecting a tampered body).
  7. (web) The developer registers a third app in `/developer` and reads its secret once from
     `devapp-secret`; on the confidential app's page `devsub` shows step 4's subscription
     `enabled`, `devsub-deliveries` lists step 4's deliveries, `devsub-test` adds one,
     `devdelivery-redeliver` adds an attempt; `/developer/bots` creates a bot and mints a token
     (`devbot-token-value` once); an admin finds the third app on `/admin/apps`, suspends it
     (`adminapp-reason-spam`) and unsuspends it.
  8. The streamer re-authorizes the confidential app over the API (step 5 revoked the grant) and
     binds a WebSocket session with it. An admin suspends the confidential app (`abuse`): its
     tokens fail `oauth2/validate`, its webhook subscription is `revoked` and the receiver got a
     `revocation`, that socket closes 4008, `safety.auditLog` (subject `oauth_app`) has `developer.app.suspend` with the reason; unsuspend leaves tokens
     revoked; the owner deletes the app and its subscriptions are gone.
- **`e2e-social`**: its SDK bot (`harness/src/bots/sdk-bot.ts`) runs on `@commonair/sdk` (E9-sdk);
  no step changes.
