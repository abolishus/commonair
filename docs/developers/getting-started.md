<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Getting started

## Register an app

1. Sign in and open the studio's **Developer** page (`https://<your instance>/developer`).
2. **Register an app**: a name (up to 50 characters) and an optional description (up to 500).
   People see both on the consent page when they authorize the app.
3. Add one to ten **redirect URIs**, one per line (rules below).
4. Choose **confidential** or **public** (below). This cannot be changed later.
5. Submit. You get a **client id**. A confidential app also gets a **client secret** (it starts
   with `cas_`), shown **once**: copy it into your server's configuration before you close the
   dialog. If you lose it, **Rotate secret** on the app's page issues a new one; the old secret
   stops working at once (there is no overlap window), while tokens already issued keep working.

One account can register up to 25 apps. On the app's page you can edit the name, description and
redirect URIs (changing redirect URIs revokes nothing), rotate the secret, delete the app and
manage its [webhook subscriptions](eventsub.md). Deleting an app revokes every token it holds and
deletes its subscriptions and delivery logs; no revocation message is sent, since the
subscriptions are gone.

## Confidential or public

| Kind         | For                                                                     | Authenticates with                                          | Grants                                                             |
| ------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| Confidential | An app with a server that can keep a secret (a web backend, a bot host) | `client_secret` (HTTP Basic or a form field) plus PKCE      | Authorization code, refresh token, device code, client credentials |
| Public       | Apps that run on people's devices: desktop, mobile, single-page         | `client_id` only; PKCE proves the request on every exchange | Authorization code, refresh token, device code                     |

Every client uses PKCE with `S256` for the authorization code, confidential or not (OAuth 2.1).
A public client must not send a secret, and cannot use client credentials.

## Redirect URI rules

The developer console and the API check each URI the same way:

- `https://` with a host, for example `https://bot.example.org/oauth/callback`.
- `http://` only on a loopback host: `127.0.0.1`, `[::1]` or `localhost`. For these the port is
  ignored when matching (RFC 8252 §7.3), so a native app may listen on any free port:
  register `http://127.0.0.1/callback` and redirect to `http://127.0.0.1:53127/callback`.
- A private-use scheme for native apps that contains a dot (reverse domain name), for example
  `com.example.myapp:/callback`.
- Never a fragment (`#…`) or a user name or password in the URI.
- At most 2000 characters each.

Every other URI must match a registered one exactly.

## Bots and tokens

Bots are accounts of their own, shown as owned by you. On **Bots and tokens**
(`https://<your instance>/developer/bots`):

- **Create a bot**: a username (3 to 25 lowercase letters, digits or underscores) and a display
  name. You can own up to 10 bots. Your channel's built-in bot (the one the channel bot settings
  create) is not listed here and can never have a token: it speaks only through the bot engine.
- **New token**: pick the [scopes](oauth.md#scopes) and a lifetime of 1 to 365 days (90 by
  default). The access token (it starts with `ca_`) is shown once. It is a personal token: no app,
  no refresh token. To use it with a Twitch-style IRC library, send `PASS oauth:<token>` and the
  bot's username as `NICK` (see [Porting from Twitch](porting-from-twitch.md)).
- **Tokens on your account** lists every live token that can act as you or one of your bots
  (personal tokens and the tokens of apps you or your bots authorized). Revoking one stops it at
  once and closes the chat, IRC and EventSub connections that use it.

People who authorized your app can revoke it themselves under **Connected apps**
(`https://<your instance>/settings/connections`).

## Next

- [OAuth](oauth.md): get a token.
- [EventSub](eventsub.md): receive events.
- The SDK, `@commonair/sdk`, wraps both.
