<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# OAuth

CommonAir is an OAuth 2.1 authorization server ([ADR 0027](../decisions/0027-oauth-and-eventsub.md)):
the authorization code grant with PKCE (`S256` only) for every client, refresh tokens that rotate
on every use with reuse detection, client credentials for app-only tokens, and the device
authorization grant (RFC 8628) for devices without a browser. Register an app first
([Getting started](getting-started.md)).

## Endpoints

| Endpoint                                      | Method | What                                                                       |
| --------------------------------------------- | ------ | -------------------------------------------------------------------------- |
| `https://<your instance>/oauth2/authorize`    | GET    | The consent page you send the browser to (a web page, not an API endpoint) |
| `https://<your instance>/api/oauth2/token`    | POST   | Every grant (RFC 6749 §3.2)                                                |
| `https://<your instance>/api/oauth2/revoke`   | POST   | Revoke an access or refresh token (RFC 7009)                               |
| `https://<your instance>/api/oauth2/device`   | POST   | Start a device authorization (RFC 8628 §3.1)                               |
| `https://<your instance>/activate`            | GET    | Where a person types a device's user code (`verification_uri`)             |
| `https://<your instance>/api/oauth2/validate` | GET    | Check a bearer token (Twitch-shaped)                                       |

The three `POST` endpoints take `application/x-www-form-urlencoded` bodies and answer RFC 6749
JSON (`{"error": "...", "error_description": "..."}` on failure) with `Cache-Control: no-store`.
A confidential client authenticates with HTTP Basic (`client_secret_basic`, both halves
form-encoded) or with `client_id` and `client_secret` fields (`client_secret_post`); a public
client sends `client_id` only.

Call the API with `Authorization: Bearer <access token>`.

## Lifetimes and limits

| What                              | Value                                               |
| --------------------------------- | --------------------------------------------------- |
| Authorization code                | 60 seconds, one use                                 |
| Access token (user)               | 4 hours                                             |
| Refresh token                     | 30 days from issue; each refresh issues a fresh one |
| Access token (client credentials) | 24 hours, no refresh token                          |
| Device code                       | 600 seconds                                         |
| Device polling interval           | 5 seconds; each `slow_down` adds 5 seconds          |
| `state`                           | up to 500 characters                                |
| Apps per account                  | 25                                                  |
| Redirect URIs per app             | 10                                                  |

Token formats (prefixes): access `ca_`, refresh `car_`, client secret `cas_`, authorization code
`cac_`, device code `cad_`. Treat them as opaque and never log them.

## Authorization code with PKCE

1. **Make a verifier**: 43 to 128 characters from `A-Z a-z 0-9 - . _ ~` (RFC 7636 §4.1). Keep it
   with the login attempt, with a random `state`.
2. **Derive the challenge**: `base64url(sha256(verifier))` without padding.
3. **Send the browser** to the consent page:

   ```text
   https://<your instance>/oauth2/authorize
     ?client_id=<client id>
     &redirect_uri=<a registered redirect URI>
     &response_type=code
     &scope=chat:read%20chat:edit
     &state=<state>
     &code_challenge=<challenge>
     &code_challenge_method=S256
   ```

   A signed-out visitor signs in (or signs up) and comes back to the consent page. Someone who
   already granted every requested scope is sent straight back unless you add `force_verify=true`.

4. **Back at your redirect URI** you get `?code=<code>&state=<state>`. Check that `state` is
   yours. If the person denied, you get `?error=access_denied&state=<state>`; other request
   problems come back the same way (`invalid_request` without PKCE, `invalid_scope` for an unknown
   or empty scope, `unsupported_response_type`). An unknown client, an unregistered redirect URI or
   a suspended app is never redirected: the person sees an error page instead.
5. **Exchange the code** within 60 seconds:

   ```http
   POST /api/oauth2/token
   Content-Type: application/x-www-form-urlencoded

   grant_type=authorization_code&code=<code>&redirect_uri=<same redirect URI>
   &client_id=<client id>&code_verifier=<verifier>[&client_secret=<secret>]
   ```

   ```json
   {
     "access_token": "ca_…",
     "token_type": "bearer",
     "expires_in": 14400,
     "refresh_token": "car_…",
     "scope": "chat:read chat:edit"
   }
   ```

   `scope` is the space-separated string of RFC 6749, not an array. A code is redeemed once: a
   wrong verifier answers `invalid_grant` and the code is spent; presenting a code again answers
   `invalid_grant` and revokes every token its first redemption issued.

## Refresh tokens

```http
POST /api/oauth2/token

grant_type=refresh_token&refresh_token=<refresh token>&client_id=<client id>[&client_secret=<secret>][&scope=<subset>]
```

Every refresh returns a new access token **and a new refresh token**; store the new one. The old
refresh token is spent (rotation). An optional `scope` narrows the new tokens to a subset of the
grant's scopes.

**Reuse detection**: presenting a refresh token that was already rotated answers `invalid_grant`
and revokes the whole family (every token descended from that authorization), because a copied
refresh token is the likely cause. Two exceptions avoid punishing honest races: two concurrent
refreshes of the same live token (one wins, the other gets `invalid_grant`, nothing is revoked),
and a rotated token presented again within 2 seconds of its rotation (a bot on several instances).

## Client credentials

```http
POST /api/oauth2/token
Authorization: Basic base64(<client id>:<client secret>)

grant_type=client_credentials
```

Confidential apps only. The token acts as the app, not as a user: it has **no scopes** (sending
`scope` at all answers `invalid_scope`), no refresh token and lasts 24 hours. It can call the
EventSub subscription endpoints (create, list and delete subscriptions, read delivery logs, send
test events, redeliver) and `GET /api/oauth2/validate`; everything else needs a user's token.
Scoped event types still need the broadcaster's authorization of your app: see
[the backing user](eventsub.md#who-backs-a-subscription).

## Device flow

For a CLI, a TV app or a bot host with no browser:

1. `POST /api/oauth2/device` with `client_id`, `scope` (at least one) and, for a confidential
   app, its secret:

   ```json
   {
     "device_code": "cad_…",
     "user_code": "BCDF-GHJK",
     "verification_uri": "https://<your instance>/activate",
     "verification_uri_complete": "https://<your instance>/activate?code=BCDF-GHJK",
     "expires_in": 600,
     "interval": 5
   }
   ```

2. Show the person the `user_code` and `verification_uri` (or a QR code of
   `verification_uri_complete`). The code is eight consonants; case and the dash do not matter.
3. Poll the token endpoint every `interval` seconds:
   `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=<device code>&client_id=<client id>`.
   Until the person decides you get `authorization_pending`; polling faster than the interval
   answers `slow_down` and adds 5 seconds to it; `access_denied` if they declined;
   `expired_token` after 600 seconds. On approval you get the same token response as the code
   grant.

## Revocation

`POST /api/oauth2/revoke` with `token` (and the client authentication above; `token_type_hint` is
optional). An access token revokes itself; a refresh token revokes its whole family. The answer
is `200` whether or not the token existed (RFC 7009). Revocation closes chat, IRC and EventSub
WebSocket connections that use the token (best effort, at once). People revoke your app
themselves under **Connected apps**, which revokes every token of that authorization.

## Validate

```http
GET /api/oauth2/validate
Authorization: Bearer <token>
```

```json
{ "client_id": "…", "login": "annbot", "user_id": "…", "scopes": ["chat:read"], "expires_in": 3500 }
```

For an app token `login` and `user_id` are `null` and `scopes` is `[]`; for a personal (bot)
token `client_id` is `null`. An invalid, expired or revoked token answers `401`. Validate when
your app starts and every hour, as Twitch asks of its apps.

## Errors

| `error`                   | When                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `invalid_request`         | A parameter is missing or malformed, or the method is not `POST`                                        |
| `invalid_client`          | Unknown client, wrong or missing secret, a secret from a public client, or a suspended app              |
| `invalid_grant`           | The code, refresh token or device code is unknown, expired, spent or revoked; PKCE or redirect mismatch |
| `unauthorized_client`     | A public client asked for client credentials                                                            |
| `unsupported_grant_type`  | Another `grant_type`                                                                                    |
| `invalid_scope`           | An unknown scope, no scope where one is required, or any scope with client credentials                  |
| `access_denied`           | The person declined                                                                                     |
| `authorization_pending`   | Device flow: no decision yet                                                                            |
| `slow_down`               | Device flow: polled faster than `interval`                                                              |
| `expired_token`           | Device flow: the device code expired                                                                    |
| `temporarily_unavailable` | Too many requests from your address (`429`, with `Retry-After`); see [Rate limits](rate-limits.md)      |

## Scopes

| Scope                        | Allows                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `chat:read`                  | Read chat messages in channels the user can see                                            |
| `chat:edit`                  | Send chat messages as the user                                                             |
| `moderator:manage:chat`      | Delete messages, ban and time out users, change chat modes, in channels the user moderates |
| `channel:manage`             | Update channel title, category, tags, panels, and settings                                 |
| `channel:read:subscriptions` | Read the channel's subscribers                                                             |
| `channel:read:tips`          | Read tips received by the channel                                                          |
| `channel:manage:polls`       | Create and end polls                                                                       |
| `channel:manage:predictions` | Create, lock, resolve and cancel predictions                                               |
| `channel:manage:raids`       | Start and cancel raids                                                                     |
| `channel:manage:bot`         | Manage the built-in channel bot (commands, timers, variables, filters)                     |
| `channel:read:points`        | Read loyalty point balances                                                                |
| `channel:manage:points`      | Grant or deduct loyalty points                                                             |
| `user:read:email`            | Read the user's email address                                                              |
| `user:read:follows`          | Read the channels the user follows                                                         |
| `user:manage:follows`        | Follow and unfollow channels                                                               |
| `clips:edit`                 | Create clips                                                                               |

**Sensitive scopes**: `user:read:email`, `channel:manage`, `moderator:manage:chat` and
`channel:manage:points` are marked as sensitive on the consent page. Ask for them only when your
app needs them; people are rightly wary of an app that wants to change their channel or their
viewers' points.

Ask for the fewest scopes you need. A grant can be widened later by sending the person through
the consent page again with the larger set.
