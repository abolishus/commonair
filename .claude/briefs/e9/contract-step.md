<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E9 contract step (orchestrator)

The orchestrator does this on `main` right after E8's contract step, commits it (`feat(e9):
contract step`), pushes and lets CI go green (CI is the gate; no local `verify`). E9 units start
later, from `main` at the start of their wave (§12), which contains this commit. Everything
below was checked against `c0c16fd` (2026-10-29); line numbers are from that commit and will have
moved by the time this lands (E8's contract step lands first and edits many of the same files):
re-find each anchor by its quoted text. Plan: `.claude/briefs/next/E9-developer-platform.md`.
ADR: `docs/decisions/0027-oauth-and-eventsub.md`. Units: `.claude/briefs/e9/E9-*.md`.

**Order.** E8's contract step (`.claude/briefs/e8/contract-step.md`) → **this step**, applied on
top of E8's → N2's contract step (`.claude/briefs/n2/contract-step.md`, on top of this one) →
wave 1 (N2-core and the five E8 API units) → wave 2 (E9-oauth, E9-apps, E9-subs, E9-ws beside
E8-studio and E8-viewer) → wave 3 (E9-sdk, E9-consent, E9-console). No E9 unit runs in wave 1, so
this step could also land later; it lands before N2's because N2's step expects it there (its
migration number and its line references sit on top of E9's), and so that N2-core migrates this
step's inline nav strings with everything else (§7.4).

**Migration numbers.** The latest at `c0c16fd` is `0032_drop_provider_tokens.sql`. E8's contract
step takes **`0033_e8_interactivity.sql` and `0034_e8_protections.sql`** (e8/contract-step.md
§2.4). **E9 takes one migration, `0035_e9_developer_platform.sql`** (if E8's step ended up with a
third migration, E9 shifts to `0036`: the rule is one more than the highest file after E8's step).
N2 then takes `0036` (n2/contract-step.md §0). E9 needs no custom protections migration: the new
table is covered by the blanket grants in `commonair_configure_app_role`
(`packages/db/drizzle/0029_w0_protections.sql:53`, re-applied by `infra/postgres/app-role.sql`
after migrations), and every invariant below is a `CHECK` Drizzle generates. Generate it on top of
E8's snapshot, never in parallel.

## 0. Corrections to the plan and the ADR (verified at `c0c16fd`)

| Plan / ADR says                                                                                                        | Code says                                                                                                                                                                                                                                                                         | What this step does                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoints `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`, `/oauth/device` (ADR §1)                                | Caddy sends only `/api/*`, `/rpc/*`, `/overlay/events` to the API (`infra/caddy/Caddyfile:162-173`); everything else goes to web (`:216-218`). The one OAuth endpoint that exists is Twitch-shaped: `GET /api/oauth2/validate` (`packages/contracts/src/api/router.ts:1396-1415`) | Machine endpoints live under the API, Twitch-shaped: `POST /api/oauth2/token`, `/api/oauth2/revoke`, `/api/oauth2/device` (raw handlers, form-encoded per RFC 6749/7009/8628). The user-facing pages are web routes `/oauth2/authorize` (consent) and `/activate` (device code entry, Twitch's name). No Caddy change for OAuth |
| "chat and IRC honour `appId`" (ADR consequences)                                                                       | The IRC gateway is a pure translator with one upstream chat socket per client (`services/irc/README.md:12-15`); it has no `BUS.userControl` subscriber and closes when chat closes its upstream (`services/irc/src/upstream.ts:74-78`)                                            | Only chat changes (§3.3). IRC follows for free                                                                                                                                                                                                                                                                                  |
| "E9 closes the chat open-socket revocation test gap" (PROGRESS.md 2B row)                                              | The test exists: `services/chat/tests/revocation.int.test.ts` (token revoked after the upgrade, announced and unannounced). PROGRESS.md:1287 is stale                                                                                                                             | This step extends that file with the app-level cases (§3.3) and fixes the PROGRESS row                                                                                                                                                                                                                                          |
| WebSocket and webhook both carry `channel.chat.message` (plan "Harness")                                               | Chat publishes `channel.chat.message` straight to `BUS.events`, never to the outbox (`services/chat/src/events.ts:4-8`, `core.ts:155`, `:170-176`); webhook fan-out starts from an outbox row (`services/worker/src/webhooks/deliver.ts:135-137`)                                 | `channel.chat.message` is WebSocket-only for now: `WEBSOCKET_ONLY_EVENT_TYPES` (§1.4), the catalog reports `transports`, `subscribe` refuses the webhook transport for it. The harness checks chat over WebSocket and follows over both                                                                                         |
| The WebSocket authenticates a token at connect, 3 sessions per (app, user) (ADR §3)                                    | Browsers cannot set headers on a WebSocket; Twitch's EventSub WebSocket is unauthenticated at connect and binds on the first subscription                                                                                                                                         | Same as Twitch: a session is anonymous until the first `subscribe` with a user access token binds it to that (app, user, token); the 3-session limit is enforced at bind; an unbound session closes after 10 s (4003). Revocation closes sessions bound to the revoked token, grant, user or app                                |
| App-only tokens make `Caller` user-less (ADR consequences: "`resolveToken` must handle a token with no user")          | `Caller` always carries `user` (`services/api/src/lib/access.ts:25-27`) and over a hundred handlers read `caller.user`                                                                                                                                                            | `Caller` is unchanged. An app-only token resolves to a separate `AppCaller` in the context (`caller` stays `null`); `decideAccess` admits it only on public procedures and those with `meta.appTokens: true` (§1.3, §3.1)                                                                                                       |
| Webhook subscriptions made with an app token are backed by "a user who has authorized the app with the event's scopes" | Events with no scopes (`stream.online`, `channel.follow`, …) need no authorization (`bindingFor` → `"none"`, `services/worker/src/webhooks/authorization.ts:24-29`), but `event_subscriptions.user_id` is `NOT NULL` (`packages/db/src/schema/platform.ts:93-95`)                 | Scope-less subscriptions made by an app are backed by the app's owner (`oauth_apps.owner_id`); scoped ones by the user the condition names, who must hold a live grant with the scopes (refused otherwise, as the ADR says). Drafting decision within ADR 0027; recorded in the E9-subs brief                                   |
| Delivery-time authorization lives in the worker                                                                        | `authorize`/`bindingFor`/`matchesCondition`/`envelope` are worker-private (`services/worker/src/webhooks/{authorization,conditions,messages}.ts`); the API's subscribe and the WebSocket fan-out need the same rules                                                              | Moved to `packages/contracts/src/eventsub.ts` (pure) and `packages/db/src/eventsub.ts` (queries), the worker re-exports them (§3.4)                                                                                                                                                                                             |
| Sign-in returns the user to the consent page                                                                           | `requireSession` redirects to `/signin` with no return path (`apps/web/src/lib/guard.ts:11-15`); sign-in always goes to `/dashboard` (`apps/web/src/routes/_app/signin.tsx:37`)                                                                                                   | `returnTo` on `/signin` and in `requireSession`, and on `/signup` through the verification link (§7.2)                                                                                                                                                                                                                          |
| ADR: unsuspending does not restore tokens                                                                              | Nothing revokes tokens on suspension today (no suspension exists)                                                                                                                                                                                                                 | Suspension revokes every token of the app in the same transaction (`grants.ts`, §4); `resolveBearer` also refuses tokens of a suspended app (defence in depth)                                                                                                                                                                  |
| ADR §3: on revocation "each subscription it backs moves to `revoked`" (WebSocket)                                      | WebSocket subscription rows are keyed by a session id that dies with the socket                                                                                                                                                                                                   | WebSocket rows get a `revocation` message and are **deleted** when their session closes 4008 (a revoked row for a dead session is useless); webhook rows move to `revoked` as the ADR says                                                                                                                                      |
| ADR §1: rotation "revokes the old one … publishes a `disconnect` for each revoked access token"                        | A plain `token_revoked` disconnect closes every socket bound to that access token, so every refresh (every 4 h) would close a bound EventSub session with 4008, which clients must treat as "re-authorize"                                                                        | Rotation publishes reason **`token_rotated`** (§1.5): chat closes sockets using the old token as before; the EventSub WebSocket ignores it (a session is bound to the grant, not one access token) and `bind` accepts any token of the same grant (§4)                                                                          |
| Account deletion deletes the user's `oauth_apps` (`services/worker/src/deletion/account-deletion.ts:263-264`)          | It publishes only `{ op: "disconnect", userId }` (`:494`), so other users' chat sockets and EventSub sessions of the deleted apps stay open until revalidation; `oauth_device_codes` (new) is not in its delete list                                                              | §3.6: delete the user's device codes, publish an app-wide `app_removed` per deleted app after commit                                                                                                                                                                                                                            |

### Decided 2026-10-29

The user settled these while reviewing the batch 3 briefs; the sections below implement them.

| Decision                                                                                                                                                 | Where                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| The SDK is Apache-2.0, `packages/sdk` only (ADR 0035); the skeleton is `"private": false` but nothing is published until the maintainer sets up npm      | §6.1, §11, E9-sdk          |
| `developer.oauth.activation` is a POST with the user code in the body (and `activate` takes it in the body too), so device codes never reach access logs | §1.8, E9-oauth, E9-consent |
| Sign-up honours `returnTo` the same way sign-in does                                                                                                     | §0, §7.2                   |
| Grant and token revocation notices stay best effort after commit, like `tokens.revoke`; the database revocation is authoritative (ADR 0027 consequences) | §4 `grants.ts`, E9-oauth   |
| `me.bots.createToken` refuses the per-channel channel bot (`PRECONDITION_FAILED` `channel_bot`), landed by E8's step; keep it                            | §3.2, E9-console           |

## 1. Contracts (`packages/contracts`)

### 1.1 `src/enums.ts` (append after `DELIVERY_STATUSES`, :208)

```ts
/** How an `oauth_tokens` row was issued. `personal`: a bot token minted by its owner (`me.bots.createToken`). */
export const OAUTH_TOKEN_KINDS = ["personal", "authorization_code", "device_code", "client_credentials"] as const;
/** RFC 8628 device authorization state. */
export const DEVICE_CODE_STATUSES = ["pending", "approved", "denied", "redeemed"] as const;
/** Why an admin suspended an OAuth app (ADR 0027 §4). Audit rows carry this, never free text. */
export const APP_SUSPENSION_REASONS = [
  "abuse",
  "spam",
  "security",
  "terms_violation",
  "impersonation",
  "other",
] as const;
```

### 1.2 `src/oauth.ts` (new; export it as `"./oauth": "./src/oauth.ts"` in `package.json` `exports` and `export * from "./oauth.ts"` in `src/index.ts`)

Browser-safe (no `node:` imports): the SDK inlines it.

```ts
// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * OAuth 2.1 for third-party apps (ADR 0027 §1-2): authorization code + PKCE (S256 only) for every
 * client, refresh-token rotation with reuse detection, client credentials (no scopes), and the
 * RFC 8628 device flow. Machine endpoints are raw form-encoded handlers on the API, Twitch-shaped
 * under `/api/oauth2/*`; the consent and activation pages are web routes.
 */
import { z } from "zod";
import { SCOPE_NAMES, type Scope } from "./scopes.ts";

export const OAUTH_PATHS = {
  /** RFC 6749 §3.2 token endpoint (all grants). */
  token: "/api/oauth2/token",
  /** RFC 7009 revocation (access or refresh token; a refresh token revokes its family). */
  revoke: "/api/oauth2/revoke",
  /** RFC 8628 §3.1 device authorization endpoint. */
  device: "/api/oauth2/device",
  /** Twitch-shaped `GET` (`developer.tokens.validate`, an oRPC procedure). */
  validate: "/api/oauth2/validate",
  /** Web: the consent page apps send the browser to. */
  authorizePage: "/oauth2/authorize",
  /** Web: where a user types a device's user code (RFC 8628 `verification_uri`). */
  activatePage: "/activate",
} as const;

export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export const OAUTH_GRANT_TYPES = [
  "authorization_code",
  "refresh_token",
  "client_credentials",
  DEVICE_CODE_GRANT,
] as const;

/** Lifetimes and limits. Tests move the API's clock (`deps.now`) rather than these. */
export const OAUTH_LIMITS = {
  codeTtlSeconds: 60,
  accessTokenTtlSeconds: 4 * 3600,
  /** A refresh token is good for this long after it is issued; rotation issues a fresh one. */
  refreshTokenTtlSeconds: 30 * 86_400,
  clientCredentialsTtlSeconds: 24 * 3600,
  deviceCodeTtlSeconds: 600,
  devicePollIntervalSeconds: 5,
  /** RFC 8628 §3.5: each `slow_down` adds this to the device code's interval. */
  deviceSlowDownSeconds: 5,
  stateMaxLength: 500,
  appsPerUser: 25,
  redirectUrisPerApp: 10,
} as const;

/** RFC 8628 §6.1: 8 characters from 20 consonants (no vowels, no look-alikes), shown as XXXX-XXXX. */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const normalizeUserCode = (code: string) => code.toUpperCase().replace(/[^A-Z]/g, "");

/**
 * Redirect URIs (OAuth 2.1 §2.3.1, RFC 8252): `https:`; `http:` only on a loopback host
 * (127.0.0.1, [::1], localhost), where any port matches at authorize time; or a private-use
 * scheme with a dot (`com.example.app:/cb`). No fragment, no userinfo.
 */
export function redirectUriProblem(uri: string): string | null {
  /* implement exactly the rule above; return a short reason or null */
}
export const RedirectUri = z
  .string()
  .max(2000)
  .refine((u) => redirectUriProblem(u) === null, { message: "not an allowed redirect URI" });

/** Exact match, except a loopback `http:` URI matches on scheme, host and path with any port. */
export function redirectUriMatches(registered: string, presented: string): boolean {
  /* implement */
}

/** RFC 7636 §4.2 S256: base64url(sha256(ascii(verifier))), no padding. */
export async function pkceChallenge(verifier: string): Promise<string> {
  /* crypto.subtle */
}
export const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
export const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/** Space-separated scope string → known scopes, or the unknown names. */
export function parseScope(scope: string): { ok: true; scopes: Scope[] } | { ok: false; unknown: string[] } {
  /* split on spaces, dedupe, check against SCOPE_NAMES */
}

export const OAUTH_ERROR_CODES = [
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "access_denied",
  "authorization_pending",
  "slow_down",
  "expired_token",
  "temporarily_unavailable",
] as const;
export const OAuthErrorResponse = z.object({
  error: z.enum(OAUTH_ERROR_CODES),
  error_description: z.string().optional(),
});

/** RFC 6749 §5.1. `scope` is the RFC's space-separated string (not Twitch's array; the SDK parses it). */
export const TokenResponse = z.object({
  access_token: z.string(),
  token_type: z.literal("bearer"),
  expires_in: z.number().int(),
  refresh_token: z.string().optional(),
  scope: z.string(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

/** RFC 8628 §3.2. */
export const DeviceAuthorizationResponse = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.url(),
  verification_uri_complete: z.url(),
  expires_in: z.number().int(),
  interval: z.number().int(),
});

/** Token request fields as they arrive (form body or query; the body wins). Strings only. */
export const TokenRequest = z.discriminatedUnion("grant_type", [
  z.object({
    grant_type: z.literal("authorization_code"),
    code: z.string().max(200),
    redirect_uri: z.string().max(2000),
    client_id: z.string().max(64),
    code_verifier: z.string().regex(PKCE_VERIFIER),
    client_secret: z.string().max(200).optional(),
  }),
  z.object({
    grant_type: z.literal("refresh_token"),
    refresh_token: z.string().max(200),
    client_id: z.string().max(64),
    client_secret: z.string().max(200).optional(),
  }),
  z.object({
    grant_type: z.literal("client_credentials"),
    client_id: z.string().max(64),
    client_secret: z.string().max(200),
    scope: z.literal("").optional(),
  }),
  z.object({
    grant_type: z.literal(DEVICE_CODE_GRANT),
    device_code: z.string().max(200),
    client_id: z.string().max(64),
    client_secret: z.string().max(200).optional(),
  }),
]);
export const RevokeRequest = z.object({
  token: z.string().max(200),
  client_id: z.string().max(64),
  client_secret: z.string().max(200).optional(),
  token_type_hint: z.enum(["access_token", "refresh_token"]).optional(),
});
export const DeviceAuthorizationRequest = z.object({
  client_id: z.string().max(64),
  scope: z.string().max(2000).default(""),
});

export { SCOPE_NAMES };
```

The `/* implement */` bodies are small and the step writes them, with
`packages/contracts/tests/oauth.test.ts`: redirect URI rule (https ok, http non-loopback refused,
loopback any port, private-use scheme needs a dot, fragment refused), `redirectUriMatches`
(exact, trailing slash differs, query differs, loopback port differs → match, loopback path
differs → no), `pkceChallenge` against RFC 7636 Appendix B (`dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk`
→ `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`), `parseScope`, `normalizeUserCode`.

### 1.3 `src/api/common.ts`

`ProcedureMeta` (:35-50) gains, after `whileSuspended`:

```ts
  /**
   * App access tokens (client credentials, no user) may call this procedure (ADR 0027 §1). They
   * are otherwise refused everywhere except `public` procedures. A router test keeps the holders to
   * `developer.events.*` (except `catalog`, which is public).
   */
  appTokens?: true;
```

and, after `ReturnPath`:

```ts
/** `/signin?returnTo=`: same rule as `ReturnPath`, long enough for an OAuth consent URL. */
export const SignInReturnPath = z
  .string()
  .max(4096)
  .regex(/^\/(?!\/)[^\s\\]*$/, "must be a relative path starting with a single /");
```

### 1.4 `src/eventsub.ts` (new; `"./eventsub"` export, re-exported from `src/index.ts`)

Pure, browser-safe. Moved from the worker (§3.4) plus the WebSocket constants:

```ts
// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** EventSub rules shared by the API (subscribe, WebSocket fan-out), the worker (webhooks) and the SDK. */
import type { z } from "zod";
import { EVENTS, SubscriptionEnvelope, type EventType, type PublicEventType } from "./events.ts";
import type { EVENT_TRANSPORTS, SUBSCRIPTION_STATES } from "./enums.ts";

// Moved verbatim from services/worker/src/webhooks/authorization.ts:15-39 (with their doc comments):
export type Binding = "none" | "broadcaster" | "broadcaster_or_moderator" | "self";
export function bindingFor(scopes: readonly string[]): Binding;
export function conditionComplete(type: EventType, condition: Record<string, string>): boolean;
export function broadcasterOf(condition: Record<string, string>): string | undefined;
// Moved verbatim from services/worker/src/webhooks/conditions.ts:4-31:
export function matchesCondition(
  condition: Record<string, string>,
  payload: Record<string, unknown>,
  subscriptionUserId: string,
): boolean;
// Moved from services/worker/src/webhooks/messages.ts:13-19:
export const ENVELOPE_STATUS = {
  enabled: "enabled",
  verification_pending: "webhook_callback_verification_pending",
  failed: "notification_failures_exceeded",
  revoked: "authorization_revoked",
} as const;

/** Envelope for either transport (the worker's `envelope()` assumed webhook). */
export function subscriptionEnvelope(
  sub: {
    id: string;
    type: string;
    version: string;
    status: (typeof SUBSCRIPTION_STATES)[number];
    condition: Record<string, string>;
    transport: (typeof EVENT_TRANSPORTS)[number];
    callbackUrl: string | null;
    websocketSessionId: string | null;
    createdAt: Date;
  },
  status?: string,
): z.infer<typeof SubscriptionEnvelope>;

/** Events that never pass through the outbox (chat publishes them to BUS.events directly), so webhooks cannot carry them. */
export const WEBSOCKET_ONLY_EVENT_TYPES: readonly PublicEventType[] = ["channel.chat.message"];
export const transportsFor = (type: PublicEventType): (typeof EVENT_TRANSPORTS)[number][] =>
  WEBSOCKET_ONLY_EVENT_TYPES.includes(type) ? ["websocket"] : ["webhook", "websocket"];

/** The user whose grant must back a scoped subscription (ADR 0027 §1, E9-subs brief). */
export function backingUserOf(type: EventType, condition: Record<string, string>): string | undefined {
  // self → condition.user_id; broadcaster_or_moderator → condition.moderator_user_id ?? broadcasterOf;
  // broadcaster → broadcasterOf; none → undefined
}

export const EVENTSUB_WS_PATH = "/eventsub/ws";
/** `?keepalive_timeout_seconds=` on connect (ADR 0027 §3). */
export const EVENTSUB_WS_KEEPALIVE = { defaultSeconds: 10, minSeconds: 10, maxSeconds: 600 } as const;
/** Close codes: Twitch's 4000-4007, plus 4008 for a revoked authorization (policy). */
export const EVENTSUB_WS_CLOSE = {
  internalError: 4000,
  clientSentTraffic: 4001,
  pingPongFailed: 4002,
  connectionUnused: 4003,
  reconnectGraceExpired: 4004,
  networkTimeout: 4005,
  networkError: 4006,
  invalidReconnect: 4007,
  authorizationRevoked: 4008,
} as const;
```

`packages/contracts/tests/eventsub.test.ts`: the worker's existing pure tests for these move here
(`services/worker/tests/webhook-logic.test.ts` keeps importing through the worker re-exports and
stays green), plus `subscriptionEnvelope` for both transports, `transportsFor`, `backingUserOf`.

### 1.5 `src/events.ts`

- `UserControlMessage` (:845-851) becomes:

```ts
export const UserControlMessage = z
  .object({
    op: z.enum(["invalidate", "disconnect"]),
    /** The user concerned. Absent on app-wide messages (only `appId`). */
    userId: id.optional(),
    /** With `userId`: only that user's connections made through this app. Alone: every connection of the app. */
    appId: id.optional(),
    /** sha256 of the revoked access token, when only sockets using that token must close. */
    tokenHash: z.string().optional(),
    reason: z.enum([
      "suspended",
      "deleted",
      "token_revoked",
      /**
       * The access token was replaced by a refresh (the grant lives on). Chat closes sockets using
       * the old token; the EventSub WebSocket ignores it (its sessions are bound to the grant).
       */
      "token_rotated",
      "role_changed",
      "profile_changed",
      "grant_revoked",
      "app_suspended",
      "app_removed",
    ]),
  })
  .refine((m) => m.userId !== undefined || m.appId !== undefined, "userId or appId is required");
export type UserControlMessage = z.infer<typeof UserControlMessage>;

/** Whether a connection (chat socket, EventSub session) is one a control message targets. */
export function userControlTargets(
  conn: { userId: string | null; appId: string | null; tokenHash: string | null },
  msg: Pick<UserControlMessage, "userId" | "appId" | "tokenHash">,
): boolean {
  if (msg.userId !== undefined && conn.userId !== msg.userId) return false;
  if (msg.appId !== undefined && conn.appId !== msg.appId) return false;
  if (msg.tokenHash !== undefined && conn.tokenHash !== msg.tokenHash) return false;
  return true;
}
```

- `BUS` (:801-825) gains:

```ts
  /**
   * EventSub WebSocket control (E9): `EventSubControlMessage`. The API instance holding a session
   * reloads its subscriptions when another instance created or deleted one over HTTP.
   */
  eventsubControl: "bus:eventsub-control",
```

and after `UserControlMessage`:

```ts
export const EventSubControlMessage = z.object({
  op: z.literal("subscriptions_changed"),
  sessionId: z.string().max(64),
});
export type EventSubControlMessage = z.infer<typeof EventSubControlMessage>;
```

- No new catalog events (E9 emits none; Twitch's `user.authorization.grant/revoke` are a
  follow-up). `packages/contracts/tests/contract.test.ts` needs no event-list change.

### 1.6 `src/internal.ts`

- `KEYS` (:136-210), after `issuanceLock`:

```ts
  /**
   * EventSub WebSocket session (hash, E9-ws): `instance`, `keepalive`, `connectedAt`, and once the
   * first subscription binds it `appId` ("" for personal tokens), `userId`, `tokenHash`. Expires
   * when the holding instance stops refreshing it.
   */
  eventsubSession: (sessionId: string) => `eventsub:session:${sessionId}`,
  /** ZSET of a grant's bound open session ids (score: bind time ms); `grant` = `${appId || "personal"}:${userId}`. */
  eventsubGrantSessions: (grant: string) => `eventsub:grant:${grant}`,
  /** One-time resume token (sha256) → session id, from a `session_reconnect`'s `reconnect_url`. */
  eventsubResume: (tokenHash: string) => `eventsub:resume:${tokenHash}`,
  /** Leader lock: the API instance holding it sweeps WebSocket subscriptions of vanished sessions. */
  eventsubSweepLock: "eventsub:sweep:lock",
```

- `WEBHOOK_JOBS` (:458-469) gains
  `/** A webhook subscription was revoked by the API (grant revoked, app suspended): tell the receiver once. */ revocation: "revocation",`
  and after `RedeliverJob` (:483):
  `export const RevocationJob = z.object({ subscriptionId: z.uuid() }); export type RevocationJob = z.infer<typeof RevocationJob>;`
  Re-export it from `services/worker/src/jobs/names.ts` like the others.

### 1.7 `src/api/entities.ts` (around `OAuthApp`, :523-569)

```ts
export const OAuthApp = z.object({
  id: Id,
  name: z.string(),
  description: z.string(),
  clientId: z.string(),
  redirectUris: z.array(z.string()),
  confidential: z.boolean(),
  createdAt: Timestamp,
  secretRotatedAt: Timestamp.nullable(),
  /** Set while an admin has suspended the app (ADR 0027 §4); its tokens do not resolve. */
  suspended: z.object({ at: Timestamp, reason: z.enum(E.APP_SUSPENSION_REASONS) }).nullable(),
});
export const OAuthAppSummary = z.object({
  id: Id,
  name: z.string(),
  description: z.string(),
  clientId: z.string(),
  owner: UserPublic.pick({ id: true, username: true }),
});
export const AccessToken = z.object({
  id: Id,
  appId: Id.nullable(),
  appName: z.string().nullable(),
  kind: z.enum(E.OAUTH_TOKEN_KINDS),
  scopes: z.array(z.enum(SCOPE_NAMES)),
  createdAt: Timestamp,
  expiresAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
});
export const EventSubscription = z.object({
  id: Id,
  appId: Id.nullable(),
  /** The user whose authorization backs it (the app owner for scope-less app subscriptions). */
  userId: Id,
  type: z.string(),
  version: z.string(),
  condition: z.record(z.string(), z.string()),
  transport: z.discriminatedUnion("method", [
    z.object({ method: z.literal("webhook"), callback: z.url() }),
    z.object({ method: z.literal("websocket"), sessionId: z.string() }),
  ]),
  status: z.enum(E.SUBSCRIPTION_STATES),
  failureCount: z.number().int(),
  createdAt: Timestamp,
});
/** What `developer.oauth.request` answers: show consent, or send the browser back with an error. */
export const OAuthConsent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("consent"),
    app: OAuthAppSummary,
    scopes: z.array(z.enum(SCOPE_NAMES)),
    /** The user already holds a live grant covering every requested scope. */
    alreadyGranted: z.boolean(),
  }),
  /** RFC 6749 §4.1.2.1: the redirect URI is valid, so errors go back to the client. */
  z.object({ kind: z.literal("redirect"), redirectTo: z.string() }),
]);
export const OAuthDeviceConsent = z.object({
  app: OAuthAppSummary,
  scopes: z.array(z.enum(SCOPE_NAMES)),
  expiresAt: Timestamp,
});
/** One app the user has authorized (settings, "Connections"). */
export const OAuthGrant = z.object({
  app: OAuthAppSummary,
  /** Union of the scopes of the grant's live tokens. */
  scopes: z.array(z.enum(SCOPE_NAMES)),
  authorizedAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
});
export const AdminOAuthApp = OAuthApp.extend({
  owner: UserPublic.pick({ id: true, username: true }),
  /** Users with a live grant. */
  grants: z.number().int(),
  /** Enabled webhook subscriptions. */
  subscriptions: z.number().int(),
});
```

`OAuthApp.redirectUris` loosens from `z.url()` to `z.string()` because private-use schemes are
not URLs for every parser; input validation uses `RedirectUri` (§1.2). `OAuthAppSecret` and
`WebhookDelivery` (between them at `c0c16fd`) stay as they are.

### 1.8 `src/api/router.ts`, `developer:` (:1319-1510)

- `apps.create.input.redirectUris` and `apps.update.input.redirectUris`:
  `z.array(RedirectUri).min(1).max(OAUTH_LIMITS.redirectUrisPerApp)` (import from `../oauth.ts`).
  `apps.*` keep `user` meta with no `scopes` (session only). Add `rateLimit: "write"` to
  `create`, `update`, `rotateSecret`, `remove`.
- `tokens.validate.output`: `login: Slug.nullable()`, `user_id: Id.nullable()` (null for an app
  token, as Twitch); `summary` unchanged.
- `events.subscribe`: `user.meta({ access: "user", scopes: [], appTokens: true, rateLimit: "write" })`;
  input gains `appId: Id.optional().describe("Session callers only: subscribe for an app you own")`.
- `events.list`: `.meta({ access: "user", scopes: [], appTokens: true })`; input gains `appId: Id.optional()`.
- `events.unsubscribe`, `deliveries`, `sendTest`, `redeliver`: `.meta({ access: "user", scopes: [], appTokens: true })`;
  `sendTest` and `redeliver` also `rateLimit: "write"`.
- `events.catalog` output item gains `transports: z.array(z.enum(E.EVENT_TRANSPORTS))`.
- New, inside `developer:` after `events`:

```ts
    oauth: {
      /** Validates an authorization request for the consent page (never redirects by itself). */
      request: user
        .route({ method: "GET", path: "/oauth2/authorize/request", summary: "Check an authorization request", ...tag("OAuth") })
        .input(
          z.object({
            clientId: z.string().min(1).max(64),
            redirectUri: z.string().min(1).max(2000),
            // Loose on purpose: once the redirect URI is valid, problems go back to the client (kind "redirect").
            responseType: z.string().max(40),
            scope: z.string().max(2000).default(""),
            state: z.string().max(OAUTH_LIMITS.stateMaxLength).optional(),
            codeChallenge: z.string().max(200).optional(),
            codeChallengeMethod: z.string().max(20).optional(),
            forceVerify: z.boolean().default(false),
          }),
        )
        .output(D.OAuthConsent),
      decide: user
        .meta({ access: "user", rateLimit: "write" })
        .route({ method: "POST", path: "/oauth2/authorize", summary: "Approve or deny an authorization request", ...tag("OAuth") })
        .input(
          z.object({
            clientId: z.string().min(1).max(64),
            redirectUri: z.string().min(1).max(2000),
            scope: z.string().max(2000).default(""),
            state: z.string().max(OAUTH_LIMITS.stateMaxLength).optional(),
            codeChallenge: z.string().regex(PKCE_CHALLENGE),
            codeChallengeMethod: z.literal("S256"),
            approve: z.boolean(),
          }),
        )
        .output(z.object({ redirectTo: z.string() })),
      // POST with the user code in the body, never in the path or query: a code in a URL reaches
      // access logs, and a logged code could be approved by someone else (decided 2026-10-29).
      activation: user
        .meta({ access: "user", rateLimit: "auth" })
        .route({ method: "POST", path: "/oauth2/activate/lookup", summary: "Look up a device's user code", ...tag("OAuth") })
        .input(z.object({ userCode: z.string().min(8).max(16) }))
        .output(D.OAuthDeviceConsent),
      activate: user
        .meta({ access: "user", rateLimit: "write" })
        .route({ method: "POST", path: "/oauth2/activate", summary: "Approve or deny a device", ...tag("OAuth") })
        .input(z.object({ userCode: z.string().min(8).max(16), approve: z.boolean() }))
        .output(Ok),
    },
    grants: {
      list: user
        .route({ method: "GET", path: "/me/authorizations", summary: "Apps you have authorized", ...tag("OAuth") })
        .output(z.array(D.OAuthGrant)),
      revoke: user
        .meta({ access: "user", rateLimit: "write" })
        .route({ method: "DELETE", path: "/me/authorizations/{appId}", summary: "Revoke an app's access to your account", ...tag("OAuth") })
        .input(z.object({ appId: Id }))
        .output(Ok),
    },
    admin: {
      list: admin
        .route({ method: "GET", path: "/admin/apps", summary: "OAuth apps on this instance", ...tag("Developers") })
        .input(PageInput.extend({ q: z.string().max(100).optional(), suspended: z.boolean().optional() }))
        .output(page(D.AdminOAuthApp)),
      suspend: admin
        .meta({ access: "admin", rateLimit: "write" })
        .route({ method: "POST", path: "/admin/apps/{id}/suspend", summary: "Suspend an app (revokes its tokens and subscriptions)", ...tag("Developers") })
        .input(z.object({ id: Id, reason: z.enum(E.APP_SUSPENSION_REASONS) }))
        .output(D.AdminOAuthApp),
      unsuspend: admin
        .meta({ access: "admin", rateLimit: "write" })
        .route({ method: "POST", path: "/admin/apps/{id}/unsuspend", summary: "Lift an app's suspension (tokens stay revoked)", ...tag("Developers") })
        .input(z.object({ id: Id }))
        .output(D.AdminOAuthApp),
    },
```

`developer.oauth.*` and `developer.grants.*` are session only (no `scopes`): no token may
approve consent or revoke grants. No new top-level namespace, so `services/api/src/router.ts`
changes only its import (§4).

- `packages/contracts/tests/contract.test.ts`: a test "only developer.events.* (but catalog) admit
  app tokens" (walk the contract, collect `meta.appTokens === true`, expect exactly
  `subscribe, list, unsubscribe, deliveries, sendTest, redeliver`), modelled on the
  `whileSuspended` test.

### 1.9 `src/scopes.ts`

No change. (`TWITCH_SCOPE_MAP` stays as is; the porting guide is E9-console's.)

## 2. Database (follow `.claude/skills/schema-change/SKILL.md`)

### 2.1 `packages/db/src/schema/_shared.ts` (after `deliveryStatus`, :78)

```ts
export const oauthTokenKind = pgEnum("oauth_token_kind", E.OAUTH_TOKEN_KINDS);
export const deviceCodeStatus = pgEnum("oauth_device_code_status", E.DEVICE_CODE_STATUSES);
export const appSuspensionReason = pgEnum("app_suspension_reason", E.APP_SUSPENSION_REASONS);
```

### 2.2 `packages/db/src/schema/platform.ts` (clean replacement of :11-64 and :87-114; ADR 0027 consequences)

Imports gain `check`, `uniqueIndex` and the three enums.

```ts
export const oauthApps = pgTable(
  "oauth_apps",
  {
    id: id(),
    ownerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text().notNull().default(""),
    clientId: text().notNull().unique(),
    /** sha256 of the client secret; null for public clients (SPAs, CLIs, native apps). */
    clientSecretHash: text(),
    redirectUris: text().array().notNull(),
    /** Confidential apps also authenticate with a secret. Every app uses PKCE (ADR 0027 §1). */
    confidential: boolean().notNull().default(true),
    secretRotatedAt: ts(),
    suspendedAt: ts(),
    suspendedReason: appSuspensionReason(),
    suspendedById: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    index("oauth_apps_owner_idx").on(t.ownerId),
    check("oauth_apps_secret_ck", sql`${t.confidential} = (${t.clientSecretHash} is not null)`),
    check(
      "oauth_apps_suspension_ck",
      sql`(${t.suspendedAt} is null) = (${t.suspendedReason} is null) and (${t.suspendedAt} is null) = (${t.suspendedById} is null)`,
    ),
  ],
);

/** One-time authorization codes. Redeemed by CAS on `redeemed_at`; a second redemption revokes the family it issued. */
export const oauthCodes = pgTable(
  "oauth_codes",
  {
    codeHash: text().primaryKey(),
    appId: uuid()
      .notNull()
      .references(() => oauthApps.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scopes: text().array().notNull(),
    redirectUri: text().notNull(),
    codeChallenge: text().notNull(),
    codeChallengeMethod: text().notNull().default("S256"),
    expiresAt: ts().notNull(),
    redeemedAt: ts(),
    /** The token family the redemption started (reuse of the code revokes it, OAuth 2.1 §4.1.3). */
    familyId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    index("oauth_codes_expires_idx").on(t.expiresAt),
    check("oauth_codes_s256_ck", sql`${t.codeChallengeMethod} = 'S256'`),
    // The family exists exactly when the code was redeemed (reuse detection revokes it).
    check("oauth_codes_redeemed_ck", sql`(${t.redeemedAt} is null) = (${t.familyId} is null)`),
  ],
);

export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: id(),
    /** Null for personal tokens minted by a bot's owner (`me.bots.createToken`). */
    appId: uuid().references(() => oauthApps.id, { onDelete: "cascade" }),
    /** Null only for client-credentials (app-only) tokens, which carry no scopes. */
    userId: uuid().references(() => users.id, { onDelete: "cascade" }),
    kind: oauthTokenKind().notNull().default("personal"),
    scopes: text().array().notNull(),
    accessTokenHash: text().notNull().unique(),
    refreshTokenHash: text().unique(),
    refreshExpiresAt: ts(),
    /** Every token descended from one authorization shares it; reuse of a rotated refresh token revokes them all. */
    familyId: uuid(),
    /** Set when its refresh token was exchanged (the row is revoked at the same moment). */
    rotatedAt: ts(),
    expiresAt: ts().notNull(),
    lastUsedAt: ts(),
    revokedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    index("oauth_tokens_user_idx").on(t.userId),
    index("oauth_tokens_app_user_idx").on(t.appId, t.userId),
    index("oauth_tokens_family_idx").on(t.familyId),
    // Both directions: an app-only token is exactly a client-credentials token, with no refresh
    // token and no scopes (its app is non-null through oauth_tokens_personal_ck).
    check(
      "oauth_tokens_app_only_ck",
      sql`(${t.userId} is null) = (${t.kind} = 'client_credentials') and (${t.userId} is not null or (${t.refreshTokenHash} is null and cardinality(${t.scopes}) = 0))`,
    ),
    check("oauth_tokens_family_ck", sql`(${t.refreshTokenHash} is null) = (${t.familyId} is null)`),
    check("oauth_tokens_refresh_expiry_ck", sql`(${t.refreshTokenHash} is null) = (${t.refreshExpiresAt} is null)`),
    check("oauth_tokens_personal_ck", sql`(${t.kind} = 'personal') = (${t.appId} is null)`),
  ],
);

/** RFC 8628 device authorizations. Codes are stored hashed; the user code is normalized (no dash, upper case). */
export const oauthDeviceCodes = pgTable(
  "oauth_device_codes",
  {
    id: id(),
    appId: uuid()
      .notNull()
      .references(() => oauthApps.id, { onDelete: "cascade" }),
    deviceCodeHash: text().notNull().unique(),
    userCodeHash: text().notNull(),
    scopes: text().array().notNull(),
    status: deviceCodeStatus().notNull().default("pending"),
    /** Who approved or denied it. */
    userId: uuid().references(() => users.id, { onDelete: "cascade" }),
    intervalSeconds: integer().notNull().default(5),
    lastPolledAt: ts(),
    decidedAt: ts(),
    expiresAt: ts().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("oauth_device_codes_user_code_uq").on(t.userCodeHash),
    index("oauth_device_codes_expires_idx").on(t.expiresAt),
    check("oauth_device_codes_decided_ck", sql`(${t.status} = 'pending') = (${t.decidedAt} is null)`),
    check("oauth_device_codes_user_ck", sql`(${t.status} = 'pending') = (${t.userId} is null)`),
  ],
);
```

`eventSubscriptions` (:87-114): keep the columns; the comment on `userId` becomes "The user whose
authorization backs this subscription (the app's owner for scope-less app subscriptions)"; the
table options become:

```ts
  (t) => [
    index("event_subscriptions_type_idx").on(t.type, t.status),
    index("event_subscriptions_app_user_idx").on(t.appId, t.userId),
    index("event_subscriptions_ws_session_idx")
      .on(t.websocketSessionId)
      .where(sql`${t.websocketSessionId} is not null`),
    // A session id is part of the key: two WebSocket sessions may hold the same subscription.
    unique("event_subscriptions_dedupe_uq")
      .on(t.userId, t.appId, t.type, t.version, t.condition, t.transport, t.callbackUrl, t.websocketSessionId)
      .nullsNotDistinct(),
    check(
      "event_subscriptions_transport_ck",
      sql`(${t.transport} = 'webhook') = (${t.callbackUrl} is not null and ${t.secretCiphertext} is not null) and (${t.transport} = 'websocket') = (${t.websocketSessionId} is not null)`,
    ),
  ],
```

### 2.3 Migration

1. `cd packages/db && bunx drizzle-kit generate --name e9_developer_platform` →
   `0035_e9_developer_platform.sql` (on top of E8's `0034`; see the header).
2. Hand-edit the generated file: prepend `DELETE FROM "oauth_codes";--> statement-breakpoint`
   before the `SET NOT NULL` on `code_challenge` (codes live 60 s and nothing has written one;
   the delete makes the migration safe on any instance), and check: three enums, one table,
   `oauth_apps` (drop not null, three columns, two checks), `oauth_codes` (three columns, not
   null, index, two checks), `oauth_tokens` (drop not null on `user_id`, four columns: `kind`,
   `refresh_expires_at`, `family_id`, `rotated_at`; index swap `oauth_tokens_app_idx` →
   `oauth_tokens_app_user_idx`, family index, four checks), the `event_subscriptions` unique
   replaced, two indexes, one check.
3. Existing rows satisfy every check: personal bot tokens have no refresh token, an app id of null
   and kind `personal` (the default); no `oauth_apps` row can exist (`create` answered 501).
   **Fix the fixtures that write refresh tokens without a family**:
   `services/worker/tests/fixtures.ts:119-130` (add `familyId: uuidv7(), refreshExpiresAt`, and
   `kind: "authorization_code"` when it sets an `appId`), and any `oauthTokens` insert in
   `services/chat/tests/helpers.ts:93`, `services/worker/tests/webhooks.int.test.ts:476`,
   `services/worker/tests/exports.int.test.ts:109` that sets an `appId` (needs a kind).
   **Also `services/chat/tests/auth.int.test.ts:123-134`**: it inserts an app and then
   `update(oauthTokens).set({ appId })` on a personal bot token, which `oauth_tokens_personal_ck`
   refuses; set `kind: "authorization_code"` in the same update.
4. `packages/db/tests/e9.int.test.ts` (new, `createTestDatabase()`, as the app role): every check
   above refuses its violation (app-only token with scopes, with a refresh token; a
   `client_credentials` token with a user; a user-less token of another kind; refresh without
   family; personal kind with an app; confidential app without secret; suspension without reason
   or without `suspended_by_id`; `oauth_codes` method `plain`; a redeemed code without a family;
   device code approved without user; webhook subscription without callback; websocket
   subscription without session id); two WebSocket subscriptions identical but for the session
   id both insert.

### 2.4 `packages/db/src/eventsub.ts` (new, exported from `src/index.ts` like `account-actions.ts`)

Moved from `services/worker/src/webhooks/authorization.ts:43-96` and `messages.ts:33-40`, using a
`Database`/`Executor` instead of the worker context:

```ts
/** Delivery- and subscribe-time authorization of a subscription (ADR 0027 §1). */
export async function authorizeSubscription(
  db: Executor,
  sub: { userId: string; appId: string | null; condition: Record<string, string> },
  type: EventType,
  now: Date,
): Promise<{ ok: true } | { ok: false; reason: string }>;
/** Deterministic per (subscription, event): every retry and both transports carry the same id. */
export function notificationMessageId(subscriptionId: string, eventId: string): string;
```

`hasToken` changes in the move (rotation makes an expired-but-refreshable token a live grant only
while its refresh token is): `user_id = sub.userId`, app match as today, `revoked_at is null`,
`(expires_at > now or (refresh_token_hash is not null and refresh_expires_at > now))`,
`scopes @> required`, and the app (when any) not suspended (`not exists (select 1 from
oauth_apps where id = app_id and suspended_at is not null)`). `isModerator` keeps its SQL.

## 3. Shared code (behaviour changes listed; the rest is moves)

### 3.1 API caller resolution and access (`services/api/src/lib/`)

- `access.ts`: export
  `interface AppCaller { appId: string; tokenId: string; expiresAt: Date }`; `AccessFacts` gains
  `app?: AppCaller | null`. In `decideAccess` (:67), right after the `relay`/`overlay` branch:

```ts
if (!f.caller && f.app) {
  if (access === "public") return { ok: true };
  if (access === "user" && f.meta.appTokens === true) return { ok: true };
  return deny("FORBIDDEN", "App access tokens cannot call this endpoint; use a user access token");
}
```

- `caller.ts`: new `resolveBearer(deps, token): Promise<{ caller: Caller } | { app: AppCaller } | null>`
  doing what `resolveToken` (:36-69) does, but with `leftJoin(users)` and `leftJoin(oauthApps)`,
  refusing `oauth_apps.suspended_at is not null`, a deleted user, and returning `{ app }` for a
  row with `user_id is null`. `resolveToken` becomes `(await resolveBearer(...))` narrowed to
  `Caller | null` (an app token → `null`), so its callers (`developer.ts:76`, chat-free API code)
  keep their types. `resolveCaller` (:81-92) returns `{ caller, app, invalidBearer }`.
- `orpc.ts`: `ResolvedContext` gains `app: AppCaller | null`; the middleware (:97-148) passes
  `app` to `decideAccess` and into the context. Rate limits (:136-145) become:

```ts
const bucket = meta.rateLimit ?? "default";
// ADR 0027 §4: an app's user token is its own subject, so one app cannot spend a user's
// allowance for every other app and the user's own session.
const appId = caller?.kind === "token" ? caller.appId : (app?.appId ?? null);
const subject = caller
  ? caller.kind === "token" && caller.appId
    ? `g:${caller.appId}:${caller.user.id}`
    : `u:${caller.user.id}`
  : app
    ? `a:${app.appId}`
    : relay
      ? `r:${relay.id}`
      : `ip:${req.rateLimitHash}`;
// …existing hit on (bucket, subject)…
if (appId) {
  const all = await deps.rateLimitStore.hit(
    rateLimitKey("app", `app:${appId}`),
    deps.rateLimits.app,
    nowMs,
    `${nowMs}:${crypto.randomUUID()}`,
  );
  if (!all.allowed) throw rateLimited(all.retryAfterSeconds);
}
```

and add `export function requireActor(ctx): { kind: "user"; caller: Caller } | { kind: "app"; app: AppCaller }`
(UNAUTHORIZED when neither), for the `developer.events.*` handlers.

- `ratelimit.ts`: `RateLimitBucket` (:12) gains `"app"`; `DEFAULT_RATE_LIMITS` (:18-32) gains
  `/** Every request an OAuth app makes, across all its tokens (ADR 0027 §4). */ app: { max: 6000, windowMs: 60_000 },`.
  `ProcedureMeta.rateLimit` does not gain it (no procedure names the bucket).
- Tests: `services/api/tests/ratelimit.test.ts:52` asserts `DEFAULT_RATE_LIMITS` with `toEqual`:
  add the `app` entry there. `services/api/tests/access.test.ts` (app caller on public / `appTokens` / user / owner /
  admin procedures); new `services/api/tests/e9-callers.int.test.ts`: `resolveBearer` for a user
  token, an app token, a token of a suspended app (null), a revoked one; the `g:`/`a:` subjects and
  the `app` bucket (lower it in the test's deps and see the 61st request refused).

### 3.2 `services/api/src/routes/me.ts`

E8's step §2.5 has already moved `me.bots.create`'s insert into `auth/bot-account.ts` and changed
its count, and made `bots.createToken` refuse the channel bot (`channel_bot`), so these lines
moved: re-find them by text and keep E8's changes.
`toAccessToken` (:100) fills `appId: t.appId` and `kind: t.kind`. `bots.createToken` (:386-408)
sets `kind: "personal"` explicitly. The `developer.tokens.list` mapping
(`services/api/src/routes/developer.ts:45-52`, moved to `routes/developer/tokens.ts` in §4) builds
the DTO inline: add `appId` and `kind` there too, or the moved file does not typecheck against the
new `AccessToken`.

### 3.3 Chat (`services/chat/src/`)

- `auth.ts` `findOauthToken` (:40-48): `isNotNull(t.userId)` (app tokens cannot chat) and a
  `leftJoin(oauthApps)` refusing `suspended_at is not null`; `OauthRow.userId: string`.
- `server.ts` `onUserControl` (:128-141):

```ts
const onUserControl = (raw: string): void => {
  const msg = parseJson(UserControlMessage, raw);
  if (!msg) return;
  if (msg.tokenHash) auth.forget(msg.tokenHash);
  if (msg.userId) core?.invalidateUser(msg.userId);
  if (msg.op !== "disconnect") return;
  for (const ws of sockets) if (userControlTargets(ws.data.identity, msg)) expire(ws, msg.reason);
};
```

(`Identity` already has `userId`, `appId`, `tokenHash`, `services/chat/src/types.ts:83-93`.)
`token_rotated` needs no special case in chat: it carries the old token's hash and closes the
sockets using it, like `token_revoked`.
An app-wide `disconnect` (`appId` only) also closes browser sockets opened with a chat token
minted for that app (`claims.app`).

- `services/chat/tests/revocation.int.test.ts`: add cases: a `disconnect` with `{ appId }` closes
  that app's sockets on both instances and leaves another app's and a personal token's open; with
  `{ userId, appId }` closes only that grant's; an app-only token is refused at upgrade (401); a
  token of a suspended app is refused at upgrade.

### 3.4 Worker webhooks (move, no behaviour change except `hasToken` and the envelope)

- `services/worker/src/webhooks/authorization.ts`: keep `authorize(ctx, sub, type)` as a
  one-liner over `authorizeSubscription(ctx.db, sub, type, ctx.now())`; re-export `bindingFor`,
  `conditionComplete`, `broadcasterOf`, `type Binding` from `@commonair/contracts/eventsub`.
- `conditions.ts`: re-export `matchesCondition`.
- `messages.ts`: `ENVELOPE_STATUS` re-exported; `envelope(sub, status)` =
  `subscriptionEnvelope(sub, status)`; `notificationMessageId` re-exported from `@commonair/db`.
- `deliver.ts`: export `sendRevocation` (:111) unchanged (E9-subs's revocation job calls it).
- Register in `services/worker/src/jobs/index.ts`, after E8's three interact jobs (e8 §6.1), two stub files the units then own (each
  `defineJob` with its final queue, name, schema and schedule, handler returning zeros):
  `jobs/webhook-revocation.ts` (`QUEUES.webhooks`, `WEBHOOK_JOBS.revocation`, `RevocationJob`,
  `attempts: 3`) → `{ sent: 0 }` (E9-subs); `jobs/oauth-expire.ts` (`QUEUES.retention`,
  `"oauth-expire"`, `z.object({})`, `schedule: { pattern: "17 * * * *" }`) →
  `{ codes: 0, deviceCodes: 0, tokens: 0 }` (E9-oauth).
- Run the worker's unit tests and `test:int` (webhooks) and the chat tests: green.

### 3.5 `packages/config/src/env.ts` and `.env.example`

`developerEnv` (:411-419) gains, after `EVENTSUB_ALLOW_INSECURE_CALLBACKS`:

```ts
  /** EventSub WebSocket: enabled subscriptions per session (ADR 0027 §3). */
  EVENTSUB_WS_MAX_SUBSCRIPTIONS: z.coerce.number().int().min(1).max(10_000).default(300),
  /** EventSub WebSocket: open sessions per (app, user) grant. */
  EVENTSUB_WS_MAX_SESSIONS_PER_GRANT: z.coerce.number().int().min(1).max(100).default(3),
  /** Seconds a new EventSub session has to create its first subscription before it is closed (4003). */
  EVENTSUB_WS_SUBSCRIBE_WITHIN_SECONDS: z.coerce.number().int().min(1).max(60).default(10),
  /** Seconds the old socket stays open after a `session_reconnect`. */
  EVENTSUB_WS_RECONNECT_GRACE_SECONDS: z.coerce.number().int().min(1).max(120).default(30),
```

`.env.example` (:166-168, "# --- developer platform ---"), after `EVENTSUB_ALLOW_INSECURE_CALLBACKS=false`:

```
# EventSub WebSocket limits (ADR 0027): subscriptions per session, sessions per (app, user),
# seconds to subscribe after connecting, seconds the old socket lives after a reconnect.
EVENTSUB_WS_MAX_SUBSCRIPTIONS=300
EVENTSUB_WS_MAX_SESSIONS_PER_GRANT=3
EVENTSUB_WS_SUBSCRIBE_WITHIN_SECONDS=10
EVENTSUB_WS_RECONNECT_GRACE_SECONDS=30
```

(The env/`.env.example` sync test and `scripts/config-reference.ts` output must stay green; run
the config package tests and regenerate the reference if it is checked in.) Self-host parity:
regenerate `infra/selfhost/env/commonair-api.keys` with `bun scripts/selfhost/unit-env.ts` (the
file is generated from `loadApiEnv`; the four keys must appear, and the infra tests that read the
`.keys` files must stay green).

### 3.6 Account deletion (`services/worker/src/deletion/account-deletion.ts`, orchestrator)

The deletion transaction deletes the user's `oauth_apps` (:263-264), which cascades every other
user's tokens and subscriptions of those apps, but after commit it only publishes
`{ op: "disconnect", userId }` (:494). Change:

- E8's step §2.5 already pseudonymizes the deleted owner's channel bot in this transaction; keep
  it (and its test) and add the following on top.
- In the transaction, before the `oauth_apps` delete: `del("oauth_device_codes", …where user_id = userId)`
  (the new table; `users` rows are pseudonymized, never deleted, so its FK cascade never fires),
  and collect the ids the `oauth_apps` delete returns into `Completed` (`deletedAppIds`).
- `afterCommit`: after the user's own `disconnect`, one
  `{ op: "disconnect", appId, reason: "app_removed" }` per deleted app (same try/catch and log
  shape), so chat-token sockets, OAuth chat sockets and EventSub sessions of those apps close.
- `services/worker/tests/deletion.int.test.ts`: a deleted user who owns an app another user
  authorized: the app, its tokens and device codes are gone, and an `app_removed` message for the
  app id is published (Valkey subscriber).

## 4. API scaffolding (`services/api/src`)

- **Split `routes/developer.ts`** (:1-104) into `routes/developer/`:
  - `index.ts` (orchestrator; read-only for units): `export const developer = { apps, tokens, events, oauth, grants, admin }`
    assembled from the files below. `services/api/src/router.ts:13` imports from
    `./routes/developer/index.ts`; delete `routes/developer.ts`.
  - `apps.ts` (E9-apps): the five `apps.*` stubs (`.handler(notImplemented)`).
  - `admin.ts` (E9-apps): `admin.list/suspend/unsuspend` stubs.
  - `tokens.ts` (E9-oauth): `answeredBy` and `tokens.list/revoke/validate` moved verbatim (validate
    narrows on `resolveToken` as today; E9-oauth widens it).
  - `events.ts` (E9-subs): the seven `events.*` stubs.
  - `oauth.ts` (E9-oauth): `oauth.request/decide/activation/activate` and `grants.list/revoke` stubs.
- **`services/api/src/developer/grants.ts`** (new, orchestrator, read-only for units; E9-oauth and
  E9-apps both revoke, in parallel):

```ts
export interface RevokedToken {
  id: string;
  userId: string | null;
  appId: string | null;
  accessTokenHash: string;
}
export type TokenScope =
  | { tokenIds: string[] }
  | { familyId: string }
  | { appId: string; userId: string } // one grant
  | { appId: string }; // the whole app
/** Revoke every unrevoked token in scope (`revoked_at = now`); returns them for the control messages. */
export async function revokeTokensInTx(tx: Executor, scope: TokenScope, now: Date): Promise<RevokedToken[]>;
/** Webhook subscriptions of a grant or a whole app → `revoked`; returns their ids (enqueue `revocation` after commit). */
export async function revokeWebhookSubscriptionsInTx(
  tx: Executor,
  scope: { appId: string; userId?: string },
): Promise<string[]>;
/**
 * After commit: one `disconnect` per token (`userId`, `appId`, `tokenHash`, reason) on
 * BUS.userControl, then, for an app-wide reason (`app_suspended`, `app_removed`), one
 * `{ op: "disconnect", appId, reason }` so chat-token sockets and EventSub sessions of the app close.
 * Publishes through `publishUserControl` (`services/api/src/lib/control.ts:38`), which parses
 * each message. Refresh rotation passes `token_rotated` (§1.5). Best effort, like
 * `tokens.revoke` today: never throws; a failed publish is logged with ids only. The committed
 * revocation is authoritative (tokens stop resolving at once; chat revalidates within 30 s, the
 * EventSub fan-out re-authorizes within 30 s, webhooks authorize at delivery). ADR 0027.
 */
export async function publishRevocations(
  deps: Deps,
  tokens: RevokedToken[],
  reason: UserControlMessage["reason"],
  appWide?: { appId: string },
): Promise<void>;
```

with `services/api/tests/e9-grants.int.test.ts` (each scope revokes only its tokens; already
revoked rows are not returned twice; subscriptions of other grants untouched; the published
messages parse as `UserControlMessage`, captured from a Valkey subscriber; `publishRevocations`
resolves, and logs, when the publish fails).

- **`services/api/src/developer/webhook-queue.ts`** (new, orchestrator): the API's producer on
  `QUEUES.webhooks`, the exact pattern of `media/clip-queue.ts` (`webhookQueue(deps)`,
  `setWebhookQueue`, `closeWebhookQueue`), with
  `enqueue(name: "verify-callback" | "test-event" | "redeliver" | "revocation", data, jobId)`.
  `services/api/src/index.ts` close list (:116-121) gains `["webhook queue", closeWebhookQueue]`.
- **`services/api/src/oauth/endpoints.ts`** (stub, E9-oauth owns it and everything under `oauth/`):
  `export async function oauthEndpoint(deps: Deps, req: Request, info: RequestInfo): Promise<Response>`
  answering `501 { "error": "temporarily_unavailable" }`. In `http.ts` `handle` (:198), after the
  CORS lines (:240-244) and before the overlay path:

```ts
if (path === OAUTH_PATHS.token || path === OAUTH_PATHS.revoke || path === OAUTH_PATHS.device)
  return withCors(await oauthEndpoint(deps, stripCredentials(raw), await requestInfo(raw, url, server)));
```

(`OPTIONS` for these already answers through `preflight` because they start with `/api/`.)

- **`services/api/src/eventsub/index.ts`** (stub, E9-ws owns `eventsub/**`):

```ts
export interface EventSubSocketData {
  sessionId: string /* E9-ws extends */;
}
export interface EventSub {
  websocket: WebSocketHandler<EventSubSocketData>;
  /** Upgrade `GET /eventsub/ws`; `undefined` once upgraded, a Response otherwise. */
  upgrade(req: Request, server: Server<EventSubSocketData>): Promise<Response | undefined>;
  /** True once the BUS subscribers listen (readiness). */
  readonly warm: boolean;
  /** Before shutdown: `session_reconnect` to every session, then wait out the grace. */
  drain(): Promise<void>;
}
export function startEventSub(deps: Deps): EventSub; // stub: upgrade answers 503, warm true, drain no-op
export function eventSub(deps: Deps): EventSub;
export async function closeEventSub(deps: Deps): Promise<void>;
/** Session lookups for `developer.events.subscribe` (E9-subs), implemented by E9-ws. */
export interface EventSubGrant {
  appId: string | null;
  userId: string;
  tokenHash: string;
}
export type BindResult = "ok" | "unknown_session" | "other_grant" | "too_many_sessions";
export interface EventSubSessions {
  /**
   * Bind an unbound session to this grant, or confirm it is already this grant's. The grant is
   * (appId, userId): a session bound with one access token accepts later subscriptions made with
   * any other token of the same grant (a refreshed one), and records the presented `tokenHash`.
   */
  bind(sessionId: string, grant: EventSubGrant): Promise<BindResult>;
}
export function eventSubSessions(deps: Deps): EventSubSessions; // stub: always "unknown_session"
export function setEventSubSessions(deps: Deps, s: EventSubSessions): void; // tests
```

`main.ts` (:20-42, after E8's step added `...interactHealth(built.deps)` to `checks` (e8 §4.2): keep
it; the `checks: { …, eventsub }` below means the existing entries plus `eventsub`; likewise
`http.ts` already mounts E8's interact hook next to the ops hook): `const eventsub = startEventSub(built.deps);` **before** `runService`,
`runService<EventSubSocketData>({ …, checks: { …, eventsub: async () => { if (!eventsub.warm) throw new Error("eventsub subscriber connecting"); } }, fetch: (req, server) => (new URL(req.url).pathname === EVENTSUB_WS_PATH ? eventsub.upgrade(req, server) : app.fetch(req, server)), websocket: eventsub.websocket, shutdownTimeoutMs: (built.deps.env.EVENTSUB_WS_RECONNECT_GRACE_SECONDS + 10) * 1000, onShutdown: async () => { await built.close(); await telemetry.shutdown(); } })`.
**`drain()` is not called from `onShutdown`**: runService's `stop()` awaits `server.stop()`
before `onShutdown` (`packages/service/src/server.ts:116-121`), and `server.stop()` waits for
open WebSockets to close (chat works around the same thing, `services/chat/src/server.ts:331-342`),
so a drain there would never run while sessions are open. Instead `startEventSub` registers
`process.once("SIGTERM" | "SIGINT", () => void drain())` itself, which runs before runService's
handlers because `startEventSub` is called first (the stub registers nothing; E9-ws implements
it, and `drain()` ends by closing whatever is left with 4004, which lets `server.stop()`
resolve). `index.ts` close list gains `["eventsub", closeEventSub]`. If `app.fetch`'s `server` parameter
type (`Pick<Server<undefined>, "requestIP">`, `http.ts:40`) does not accept a
`Server<EventSubSocketData>`, widen it to `Pick<Server<unknown>, "requestIP">`.

- **Stop grace for the API container** (the reconnect grace is 30 s; Podman's default stop timeout
  is 10 s, after which it SIGKILLs): `compose.yaml` `api` gains `stop_grace_period: 45s`,
  `infra/quadlet/commonair-api.container` gains `StopTimeout=45` under `[Container]`, and
  `harness/compose.multi-instance.yaml` `api-2` the same `stop_grace_period` (the drift test
  compares replicas). Update any infra test that pins these files.
- `apps/web/vite.config.ts:60`: `proxy` gains `"/eventsub": { ...proxied, ws: true }` (dev only).
- Stub count after this step: `grep -c '.handler(notImplemented)' services/api/src/routes/developer/*.ts`
  → apps 5, admin 3, events 7, oauth 6, tokens 0.

## 5. Infra

- `infra/caddy/Caddyfile`, after the `/overlay/events` block (:168-173):

```
	# EventSub WebSocket (ADR 0027 §3): wss://<host>/eventsub/ws → the API.
	handle /eventsub/ws {
		reverse_proxy api:3001
	}
```

`infra/tests/caddy.test.ts` routing table (:31-45) gains `"/eventsub/ws": "api:3001"`, and a
test that it is a plain (no rewrite) proxy. Quadlet and `selfhost.sh` use the same Caddyfile:
nothing else to change (self-host parity holds).

- `harness/compose.e9.yaml` (new, CC0 header like `harness/compose.e6.yaml`): `api` and `worker`
  get `EVENTSUB_ALLOW_INSECURE_CALLBACKS: "true"` (the harness webhook receiver is plain http on the
  host). Add it to `HARNESS_OVERRIDES` (`scripts/infra.ts:436-443`) after E8's `compose.e8.yaml` and before the multi-instance
  override, and to whatever test lists the overrides. **`harness/compose.multi-instance.yaml`**:
  `api-2` and `worker-2` get the same variable (with a `# harness/compose.e9.yaml` comment, as
  `:98` and `:158` do for e6): `harness/tests/multi-compose.test.ts` merges every override in
  `HARNESS_OVERRIDES` and fails when a replica differs from its original, and without it
  `worker-2` would refuse the receiver and make step 4 flaky under `--multi`. Add the file to the
  override list in `harness/README.md:70` and `:501`.

## 6. Harness scaffolding

- `harness/src/e9/selectors.ts` + `harness/tests/e9/selectors.test.ts`: `E9_TEST_IDS`,
  `E9_ROUTES`, `E9_ID_PATTERNS` from §8, in the shape of `harness/src/e7/selectors.ts`, checked
  against `docs/testing/e9-selectors.md` like `harness/tests/e7/selectors.test.ts`.
- `harness/src/e9/run.ts` (orchestrator): `E9Run` = `{ platform, log, env, actors: { developer, streamer, viewer, admin }, state: E9State, browser? }`,
  where `E9State` holds `confidentialApp?`, `publicApp?` (`{ id, clientId, clientSecret: string | null, redirectUri }`),
  `grant?` (`{ userId, accessToken, refreshToken, scopes }`), `appToken?`, `receiver`; `E9Step` =
  `{ name: string; owner: string; ready: boolean; needs: number[]; webOnly?: true; run(run: E9Run): Promise<void> }`.
  It also exports `authorizeOverApi(run, { app, actor, scopes }): Promise<Grant>` (PKCE `S256`
  via `pkceChallenge`, `developer.oauth.decide` with the actor's session, `code` read from the
  returned `redirectTo`, then `POST OAUTH_PATHS.token`), so every step that needs a live grant
  gets one without importing another unit's step module: step 5 revokes the streamer's grant
  (`developer.grants.revoke`), so step 8 must re-authorize with it before it opens its socket.
  Step 2 (E9-oauth) may use it for its happy path and tests its own edge cases around it.
- `harness/src/e9/receiver.ts` (orchestrator): a Bun HTTP server on `0.0.0.0:<free port>` that
  records every request (headers, raw body), answers `webhook_callback_verification` with the
  challenge, 204 otherwise, exposes `url` as `http://${HARNESS_WEBHOOK_HOST}:<port>/hook`
  (`HARNESS_WEBHOOK_HOST` added to `harness/src/env.ts`, default `host.containers.internal`, which
  Podman resolves in containers) and `waitFor(predicate, timeoutMs)`. Also serves
  `GET /cb` (the OAuth loopback redirect target) recording the query.
- `harness/src/redact.ts` (:9): extend the query pattern with `code`, `refresh_token`,
  `device_code`, `client_secret` and `resume`, and add a pattern for the bare prefixed secrets
  above (`\bc(?:a|ar|as|ac|ad|es)_[a-z0-9]{20,}\b`; check the alphabet `randomTokenSecret` emits, `packages/tokens/src/index.ts:186`), with cases in `harness/tests/redact.test.ts`.
- `harness/src/e9/ws-client.ts` (orchestrator): `openEventSub(url)` → `{ messages, next(type, timeoutMs), closed: Promise<{ code, reason }>, close() }`.
- Step modules, each exporting `export const step: E9Step` with `ready: false` and a `run` that
  throws `new Error("<unit> not merged")`; the owning unit flips `ready` and implements it:

| #   | Module                        | Owner      | Step                                                                                                                             | Needs |
| --- | ----------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1   | `harness/src/e9/app.ts`       | E9-apps    | register a confidential and a public app over the API (`developer.apps.*`), update, rotate the secret                            | –     |
| 2   | `harness/src/e9/oauth.ts`     | E9-oauth   | PKCE code flow over the API, refresh rotation, reuse revokes the family, device flow, client credentials                         | 1     |
| 3   | `harness/src/e9/consent.ts`   | E9-consent | the same through `/oauth2/authorize`, `/activate`, `/settings/connections` in Chromium (web only)                                | 1     |
| 4   | `harness/src/e9/webhook.ts`   | E9-subs    | webhook subscription to `channel.follow`, delivery, signature, log, test event, redelivery, refusals                             | 2     |
| 5   | `harness/src/e9/websocket.ts` | E9-ws      | WebSocket welcome, chat and follow notifications, keepalive, 4003, session limit, revocation 4008                                | 2     |
| 6   | `harness/src/e9/sdk.ts`       | E9-sdk     | the same flows through `@commonair/sdk`                                                                                          | 4, 5  |
| 7   | `harness/src/e9/console.ts`   | E9-console | (web only) register an app in `/developer`, its subscriptions and deliveries, a test event, redelivery, bot token, `/admin/apps` | 4     |
| 8   | `harness/src/e9/suspend.ts`   | E9-apps    | admin suspends the app: tokens dead, webhook revoked with a notice, socket closed 4008, audit; delete                            | 4, 5  |

Steps 1–2, 4–5 and 8 need only wave 2, so the scenario exercises the API as soon as wave 2
merges; 3, 6 and 7 arrive with wave 3.

- `harness/scenarios/developer-platform.ts` (orchestrator): `--set steps=` (as `harness/src/safety.ts:18-75`:
  numbers, ranges, `all`), `--set via=web|api` (`web` default), runs the selected steps in order;
  a step that is not `ready`, or whose `needs` are not all ready and selected, is reported as
  pending and skipped (so `full` stays green while units are in flight); `webOnly` steps are
  skipped with `via=api`. `harness/tests/e9/steps.test.ts` covers the selection.
- `harness/package.json` gains `"@commonair/sdk": "workspace:*"` (with §6.1's skeleton, so the
  orchestrator reconciles `bun.lock` once).
- `FULL_REQUIRED` (`harness/src/registry.ts:33-60`): add `"developer-platform"` only after the
  last E9 unit merges (orchestrator). It falls in the `rest` shard (`harness/src/shards.ts:11-16`).

### 6.1 `packages/sdk` skeleton (so the workspace and lockfile exist before any wave)

The SDK is **Apache-2.0** (decided 2026-10-29, ADR 0035); every other package stays
AGPL-3.0-or-later.

- `packages/sdk/package.json`: `"name": "@commonair/sdk"`, `"version": "0.0.0"`,
  `"license": "Apache-2.0"`, `"private": false` (the publish workflow is not run until the
  maintainer creates the `@commonair` npm organisation and the trusted publisher; only `dist/` is
  ever published, by `sdk-publish.yml`), `"type": "module"`, `"exports": { ".": "./src/index.ts" }`,
  scripts `test`, `typecheck`, dependencies `@commonair/contracts: workspace:*`, `@orpc/client`,
  `@orpc/contract`, `zod` (all `catalog:`), dev `typescript`, `vite-plus`. `tsconfig.json` like
  `packages/tokens`. `src/index.ts` with `// SPDX-FileCopyrightText: 2026 CommonAir contributors`
  and an `SPDX-License-Identifier` line of `Apache-2.0`, and `export {};`. Run `bun install`.
- `LICENSES/Apache-2.0.txt`: `reuse download Apache-2.0` (the SPDX text, unmodified).
- `REUSE.toml`: a new annotation after the `**/package.json` block, so the package's JSON files
  (which carry no header) are Apache-2.0 and not the aggregate AGPL:
  `path = ["packages/sdk/**"]`, `precedence = "override"`,
  `SPDX-FileCopyrightText = "2026 CommonAir contributors"`, `SPDX-License-Identifier = "Apache-2.0"`.
  Files with their own header keep it (E9-sdk writes Apache-2.0 headers on every file it adds).
- `scripts/check-licenses.ts` (:65-66): the blanket skip of `@commonair/*` becomes a check of our
  own declared licences: `const OWN_LICENSES: Record<string, string> = { "@commonair/sdk": "Apache-2.0" };`
  and every other `@commonair/*` package (and `commonair`) must declare `AGPL-3.0-or-later`; a
  mismatch is a finding (reason `own package must be <expected>`). Update the comment ("Our own
  workspace packages are AGPL by construction") to name the SDK exception and ADR 0035. Test in
  `scripts/tests/licenses.test.ts`: a fixture `node_modules` with `@commonair/sdk` at Apache-2.0
  passes, `@commonair/sdk` at AGPL fails, `@commonair/db` at Apache-2.0 fails.
- `docs/decisions/0035-sdk-license.md` (written with these briefs, linked from ADR 0027 §5) is
  committed with this step if it is not on `main` yet.

E9-sdk keeps all of this and adds the dual-licence contract request for the contract files its
bundle inlines (E9-sdk Build 8; ADR 0035).

## 7. Web scaffolding (`apps/web`)

### 7.1 Routes (placeholders)

Each `createFileRoute(...)({ component: () => <NotFoundState /> })` with the guard it keeps:

| File                                       | Route                    | Guard                                                                                                                                                                | Owner      |
| ------------------------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `routes/_app/oauth2.authorize.tsx`         | `/oauth2/authorize`      | `beforeLoad: ({ location }) => requireSession(() => getSessionUser(), { returnTo: location.href })` (§7.2); `validateSearch` is E9-consent's                         | E9-consent |
| `routes/_app/activate.tsx`                 | `/activate`              | same                                                                                                                                                                 | E9-consent |
| `routes/_app/settings.connections.tsx`     | `/settings/connections`  | `requireSession(() => getSessionUser())`                                                                                                                             | E9-consent |
| `routes/_studio/developer.index.tsx`       | `/developer`             | `requireSession(() => getSessionUser())` (the studio layout guards nothing: "Each page guards its own session", `routes/_studio.tsx:19`; as `_studio/relays.tsx:29`) | E9-console |
| `routes/_studio/developer.apps.$appId.tsx` | `/developer/apps/$appId` | same                                                                                                                                                                 | E9-console |
| `routes/_studio/developer.bots.tsx`        | `/developer/bots`        | same                                                                                                                                                                 | E9-console |
| `routes/_admin/admin.apps.tsx`             | `/admin/apps`            | the admin layout's                                                                                                                                                   | E9-console |

Regenerate and commit `apps/web/src/routeTree.gen.ts`. **No unit adds, renames or removes a route file.**

### 7.2 Return after sign-in

`apps/web/src/lib/guard.ts`: `requireSession(load, opts?: { returnTo?: string })`: with
`returnTo` (the route passes `location.href` from `beforeLoad`'s argument: path + search, since
the guard itself has no access to the location), the redirect is
`redirect({ to: "/signin", search: { returnTo }, replace: true })`; a value that fails
`SignInReturnPath` is dropped (plain `/signin`). `routes/_app/signin.tsx`:
`validateSearch: z.object({ returnTo: SignInReturnPath.optional() })` and
`window.location.assign(search.returnTo ?? "/dashboard")` (:37); the link to sign-up keeps the
`returnTo`. A test in `apps/web/tests/` that a protocol-relative or absolute `returnTo` is
refused (falls back to `/dashboard`).

**Sign-up honours `returnTo` the same way** (decided 2026-10-29), so a visitor who reaches the
consent page without an account comes back to it after verifying: `routes/_app/signup.tsx` gets
the same `validateSearch: z.object({ returnTo: SignInReturnPath.optional() })`; its link to
sign-in (:163) keeps the `returnTo`; `lib/auth.ts` `signUp` and `resendVerificationEmail` take an
optional `callbackURL` (default `"/dashboard"`, :47 and :56), and the page passes
`search.returnTo` to both: `components/resend-verification.tsx` gains an optional `callbackURL`
prop passed to `send`, used on the sign-up check-email screen (:87) and on sign-in's unverified
notice (`signin.tsx:65`), so the verification link lands on the original page. Only a value that passed `SignInReturnPath`
ever reaches `callbackURL`; better-auth checks it against its trusted origins as well. Tests: the
same refusal cases for `/signup`, and `signUp` sends `callbackURL` = the validated `returnTo`.

### 7.3 Nav and access

- `lib/nav.ts`: `StudioEntry` gains `{ id: "developer", to: "/developer" }` (last, after E8's `interact` and `bot`; `current` for
  `/developer` and anything under `/developer/`); `AccountEntry` gains
  `{ id: "connections", to: "/settings/connections" }` after `privacy`; `AdminEntry` gains
  `{ id: "apps", to: "/admin/apps" }` under `admin`, after `incidents`.
- `components/safety/access.ts`: `AdminPage` gains `"apps"`, `adminPageFor` maps `/admin/apps`,
  `mayOpenAdminPage`: admin only.
- `routes/_studio.tsx` `studioItem` (:23-60, plus E8's two cases): case `developer` (Hugeicons `SourceCodeIcon` or
  `CodeIcon`; check it exists in `@hugeicons/core-free-icons`), `data-testid="studio-developer-link"`.
  `routes/_admin.tsx` `adminItem`: case `apps`, `data-testid="admin-apps-link"`.
  `components/site-chrome.tsx` account menu: `connections` → `data-testid="account-connections-link"`.
- Update `apps/web/tests/nav.test.ts`.

### 7.4 i18n (before N2-core: inline keys only; n2/contract-step.md §8)

- Inline keys in `apps/web/src/i18n/en.ts` next to the ones E7 and E8 added, as E7 did:
  `studio.developer` ("Developer") after E8's studio keys (`studio.relays`, :50 at `c0c16fd`),
  `nav.connections` ("Connected apps") after `nav.copyright` (:42), `nav.adminApps` ("OAuth apps")
  after `nav.adminIncidents` (:46). N2-core moves them into its `core` namespace with everything
  else.
- **No per-unit catalog files.** E9-consent and E9-console get JSON namespaces **`e9-consent`** and
  **`e9-console`**, which N2-core creates empty from the "i18n namespaces" list in
  `.claude/briefs/batch3/README.md`: the orchestrator adds both names there before N2-core starts.
  **That file does not exist at `c0c16fd`** (N2-core.md Build §2 and n2/contract-step.md §8 both
  read it): the orchestrator creates it with its "i18n namespaces" list (`e8-studio`, `e8-viewer`
  from E8's briefs, `e9-consent`, `e9-console`) before wave 1.
  Each unit then follows "How to add a namespace" in `.claude/briefs/n2/N2-core.md` and writes only
  `apps/web/src/i18n/locales/en/<its namespace>.json` and the regenerated
  `apps/web/src/i18n/keys/<its namespace>.gen.ts`. If N2-core landed different paths, update the
  two briefs' paths in the hand-off message.

## 8. `docs/testing/e9-selectors.md` (write it; the units build against it)

Header and intro as `docs/testing/e7-selectors.md:1-12` ("E9 web ↔ harness contract (developer
platform)"). In the document each `###` below is a `##`, bold group labels become `###`.

### Rules

- Tests select by `data-testid`, never visible text. Option items follow `<field>-<value>`.
- Secrets (client secrets, access, refresh, device and authorization codes, webhook secrets) are
  shown once in the UI, never logged by any service, never put in harness reports, never in URLs
  except the authorization `code` on the redirect and the one-time `resume` token on a
  `reconnect_url`. Prefixes: access `ca_`, refresh `car_`, client secret `cas_`, authorization
  code `cac_`, device code `cad_`, resume token `ces_`.
- Audit rows for `developer.app.suspend` and `developer.app.unsuspend` carry the app id and the
  reason code only.

### Routes

| Route                    | Purpose                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `/oauth2/authorize`      | New, signed in (returns after sign-in): consent for an app's authorization request; approve or deny         |
| `/activate`              | New, signed in: enter a device's user code (`?code=` prefills), then the same consent                       |
| `/settings/connections`  | New, signed in: apps you authorized, their scopes, revoke                                                   |
| `/developer`             | New, studio: your OAuth apps, register one                                                                  |
| `/developer/apps/$appId` | New, studio: one app: credentials, redirect URIs, secret rotation, delete; its subscriptions and deliveries |
| `/developer/bots`        | New, studio: bot accounts you own, their tokens; tokens authorized on your account                          |
| `/admin/apps`            | New, admins: every app; suspend with a reason, unsuspend                                                    |

### Test ids

**Consent (`/oauth2/authorize`)**

| Test id                 | Element / meaning                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `oauth-consent`         | The consent card: `data-client-id`, `data-already-granted` (`true`/`false`)                                                                    |
| `oauth-consent-owner`   | Who registered the app (username)                                                                                                              |
| `oauth-consent-scope`   | One per requested scope: `data-scope` (the scope name)                                                                                         |
| `oauth-consent-approve` | Approve: the browser goes to the app's redirect URI with `code` and `state`                                                                    |
| `oauth-consent-deny`    | Deny: the browser goes to the redirect URI with `error=access_denied` and `state`                                                              |
| `oauth-consent-error`   | Shown instead of the card when the request cannot go back to the app: `data-error` (`invalid_client`, `invalid_redirect_uri`, `app_suspended`) |

**Device activation (`/activate`)**

| Test id          | Element / meaning                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `device-form`    | `device-code` (input, `XXXX-XXXX`, dash optional), `device-submit`                                         |
| `device-consent` | The consent for that device: `data-client-id`; `oauth-consent-scope` rows; `device-approve`, `device-deny` |
| `device-done`    | After a decision: `data-result` (`approved`/`denied`)                                                      |
| `device-error`   | Unknown or expired code: `data-error` (`not_found`, `expired`)                                             |

**Connections (`/settings/connections`)**

| Test id                    | Element / meaning                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `account-connections-link` | In the account menu, a link to `/settings/connections`                                                                      |
| `connections`              | Page wrapper; `connections-empty` `<EmptyState>`                                                                            |
| `connection`               | One authorized app: `data-app-id`, `data-client-id`, `data-scopes` (space-separated); `connection-revoke` (`ConfirmDialog`) |

**Developer console (`/developer`, `/developer/apps/$appId`)**

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
| `devdelivery`           | One logged delivery: `data-delivery-id`, `data-message-type`, `data-status`, `data-response-status` (empty when none), `data-attempt`; `devdelivery-redeliver` (failed notifications only)                                                                  |

**Bots and tokens (`/developer/bots`)**

| Test id             | Element / meaning                                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devbots`           | Page wrapper; `devbots-empty`; `devbot-new` opens `devbot-form` (`devbot-username`, `devbot-display-name`, `devbot-submit`)                               |
| `devbot`            | One bot: `data-bot-id`, `data-username`; `devbot-token-new` opens `devbot-token-form`                                                                     |
| `devbot-token-form` | `devbot-scope-<scope>` checkboxes, `devbot-token-days`, `devbot-token-submit`; then `devbot-token-value` (shown once) and `devbot-token-done`             |
| `devtoken`          | One token authorized on your account or your bots': `data-token-id`, `data-app-id` (empty for personal), `data-kind`; `devtoken-revoke` (`ConfirmDialog`) |

**Apps (`/admin/apps`)**

| Test id                 | Element / meaning                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `admin-apps-link`       | In the admin sidebar                                                                                                                      |
| `adminapps`             | Page wrapper; `adminapps-search`, `adminapps-filter-suspended` (switch); `adminapps-empty`                                                |
| `adminapp`              | One app: `data-app-id`, `data-client-id`, `data-suspended`, `data-grants`, `data-subscriptions`; `adminapp-suspend`, `adminapp-unsuspend` |
| `adminapp-suspend-form` | `adminapp-reason` (items `adminapp-reason-<reason>`, `APP_SUSPENSION_REASONS`), `adminapp-suspend-submit` (`ConfirmDialog`)               |

### Scenarios

- **`developer-platform`** (new; steps and owners in §6 of the contract step):
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

## 9. Shared-file rules for E9 (every brief repeats its part)

| Shared thing                                                                                                                                                                                  | Resolution                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/**`, `packages/db/**`, `packages/config/**`, `.env.example`                                                                                                               | Orchestrator only (this step). Units send contract requests with exact diffs                                                                                                                                                                                                             |
| `services/api/src/routes/developer/index.ts`, `router.ts`, `http.ts`, `main.ts`, `index.ts`, `lib/{access,caller,orpc,ratelimit}.ts`                                                          | Orchestrator. Each unit owns its own `routes/developer/<file>.ts` (§4)                                                                                                                                                                                                                   |
| `services/api/src/developer/{grants,webhook-queue}.ts`                                                                                                                                        | Orchestrator; E9-oauth, E9-apps and E9-subs import them read-only                                                                                                                                                                                                                        |
| `services/api/src/eventsub/index.ts` signatures                                                                                                                                               | E9-ws owns the file and implements it; the exported names and types in §4 are the contract E9-subs codes against                                                                                                                                                                         |
| `services/worker/src/jobs/index.ts`                                                                                                                                                           | Orchestrator (§3.4). E9-subs owns `jobs/webhook-*.ts` and `services/worker/src/webhooks/**`; E9-oauth owns `jobs/oauth-expire.ts`                                                                                                                                                        |
| `services/chat/**`                                                                                                                                                                            | This step only (§3.3). No E9 unit edits chat; E8-bot-engine owns `services/chat/src/plugins/**`                                                                                                                                                                                          |
| `services/worker/src/deletion/**`, `services/worker/tests/deletion*.ts`                                                                                                                       | This step only (§3.6)                                                                                                                                                                                                                                                                    |
| `infra/**`, `harness/compose.*.yaml`, `scripts/**`, `REUSE.toml`, `.github/workflows/ci.yml`                                                                                                  | Orchestrator. E9-sdk owns only the new `.github/workflows/sdk-publish.yml`                                                                                                                                                                                                               |
| i18n                                                                                                                                                                                          | N2-core's format (wave 1). E9-consent writes only the `e9-consent` namespace (`locales/en/e9-consent.json`, `keys/e9-consent.gen.ts`), E9-console only `e9-console`; the nav keys are this step's (inline, migrated by N2-core). Nobody edits another namespace or N2-core's files/tests |
| `apps/web/src/routeTree.gen.ts`, nav, access, `_studio.tsx`, `_admin.tsx`, `site-chrome.tsx`, `lib/guard.ts`, `signin.tsx`, `signup.tsx`, `lib/auth.ts`, `components/resend-verification.tsx` | This step (§7). Units fill their placeholder route files only                                                                                                                                                                                                                            |
| Harness                                                                                                                                                                                       | `scenarios/developer-platform.ts`, `src/e9/{run,selectors,receiver,ws-client}.ts`, `tests/e9/{selectors,steps}.test.ts`: orchestrator. Each unit owns its step module (§6). `sdk-bot.ts`: E9-sdk                                                                                         |
| `harness/src/registry.ts` (`FULL_REQUIRED`)                                                                                                                                                   | Orchestrator, after the last E9 unit merges                                                                                                                                                                                                                                              |
| `docs/testing/e9-selectors.md`, PROGRESS.md, HANDOFF.md, ADRs, READMEs                                                                                                                        | Orchestrator. Units put proposed text in their final message. `docs/developers/sdk.md` is E9-sdk's, the rest of `docs/developers/**` E9-console's                                                                                                                                        |
| `apps/web/tests/selectors.test.ts`                                                                                                                                                            | Orchestrator adds the e9 check after E9-consent and E9-console merge                                                                                                                                                                                                                     |

## 10. Done means for the contract step

Targeted checks (CI is the gate; the orchestrator pushes and watches it): `bun --bun vp test run`
in `packages/contracts`, `packages/config`, `packages/db` (+ `test:int`), `services/api` (+
`test:int`), `services/chat` (+ `test:int`), `services/worker` (+ `test:int`, not at the same
time as another package's), `apps/web`, `harness`, `infra`; `bunx tsc -p` for each; `vp lint
--deny-warnings` and `vp fmt` on the changed paths; `vp build` in `apps/web`. Then push, wait for
CI green on main, record the units under "In flight" in PROGRESS.md (and fix its 2B chat row),
add `e9-consent` and `e9-console` to the "i18n namespaces" list in `.claude/briefs/batch3/README.md`
before N2-core starts (§7.4), recheck the `actions/setup-node` pin in `E9-sdk.md` Build 9 before
wave 3 (filled 2026-10-29 with v7.1.0, the newest release older than 7 days; resolve a newer one
with `gh api repos/actions/setup-node/git/ref/tags/<tag>`), and hand the E9 units their
briefs with the base sha of their wave (wave 2: `main` after wave 1 merged; wave 3: after wave 2).

## 11. E9 milestone done means

- `grep -c '.handler(notImplemented)' services/api/src/routes/developer/*.ts` is 0 for every file.
- `developer-platform` (all eight steps with `via=web`; steps 1-2, 4-6 and 8 with `--set via=api`) and `e2e-social` pass on the
  harness stack in CI; `developer-platform` is in `FULL_REQUIRED`.
- `packages/sdk` has its own unit tests and its licence test, passes `check-licenses` as
  Apache-2.0 (ADR 0035; `reuse lint` clean with the `packages/sdk/**` annotation), and
  `sdk-publish.yml` passes the workflow lint (nobody publishes until the maintainer sets up the
  npm organisation and trusted publisher).
- `docs/developers/` exists with the porting guide, `sdk.md`, and links to the type-checked
  examples in `packages/sdk/examples/`.
- The e9 selectors check is in `apps/web/tests/selectors.test.ts`.

## 12. Waves (batch 3; at most six units at a time)

Aligned with `e8/contract-step.md` §15 (wave 1: N2-core + five E8 API units; wave 2: E8-studio,
E8-viewer and "up to four E9 units") and `n2/contract-step.md` §0 (E8 step, E9 step, N2 step,
then wave 1).

| Wave | Units                                                                   | Starts from       | Why                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | ----------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| –    | E8 step, **E9 step**, N2 step (in that order)                           | `main`            | each edits the shared contract files on top of the previous one; migrations 0033-0034, 0035, 0036                                                                                                                                                                                                                                                                     |
| 1    | N2-core, E8-polls, E8-raids-goals, E8-points, E8-bot-engine, E8-bot-api | the N2 step's sha | E8's and N2's choice; no E9 unit: the six slots are taken, and nothing in E9's API needs to precede E8                                                                                                                                                                                                                                                                |
| 2    | **E9-oauth, E9-apps, E9-subs, E9-ws**, E8-studio, E8-viewer             | wave 1 merged     | the four E9 API units are disjoint by §9 and need no web strings; E9-subs codes against E9-ws's `EventSubSessions` interface with a fake; six in all                                                                                                                                                                                                                  |
| 3    | **E9-sdk, E9-consent, E9-console**, N2-consent                          | wave 2 merged     | the two web units write strings (N2-core merged) and drive real endpoints (consent, grants, subscriptions, admin suspension); the SDK is the E9 unit that gains most from building against merged endpoints (its harness step 6 needs steps 4 and 5) and has no dependant inside E9 except `e2e-social`'s bot; N2-consent (added 2026-10-29) shares no file with them |

Why the consent page left E9-oauth (the plan had them together): the OAuth API then runs in wave 2
without waiting for N2-core's namespaces or for a web reviewer, and one unit (E9-consent) owns
every user-facing OAuth page (consent, activation, connections) and their copy, written once in
N2-core's format. E9-console stays separate from E9-consent: different pages, a different
audience (developers and admins vs every viewer), and the developer docs.

`docs/developers/sdk.md` is E9-sdk's and the rest of `docs/developers/` E9-console's; both run in
wave 3, so E9-console does not link `sdk.md` itself: the orchestrator adds that link to
`docs/developers/README.md` when both have merged.
