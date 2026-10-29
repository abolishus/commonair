<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E9-oauth: OAuth 2.1 for third-party apps (API)

You are implementing unit E9-oauth for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/E9-developer-platform.md`,
`docs/decisions/0027-oauth-and-eventsub.md` (§1, §2, §4, "Decisions at acceptance"),
`.claude/briefs/e9/contract-step.md` (§0 corrections, §1.2 `oauth.ts`, §1.8 router, §2 schema,
§3.1 callers, §4 `grants.ts`, §9 shared-file rules) and `docs/testing/e9-selectors.md` (Rules and
scenario step 2). Do not look outside the repository, except the RFCs you implement (6749, 7009,
7636, 8252, 8628, OAuth 2.1 draft), which you may cite from memory. Work in your own git worktree
on a branch named `e9/oauth`, created from `main` at the start of batch-3 wave 2 (the orchestrator
gives you the sha; it contains the E9 contract step and wave 1); run `git merge main` first if main
moved. Wave 2, beside E9-apps, E9-subs, E9-ws, E8-studio and E8-viewer.

## Why

Apps exist in the schema but nothing issues them a token: `oauth_codes` is unused, there is no
token endpoint, no device flow, no refresh rotation. ADR 0027 fixed the shape: authorization code
with PKCE `S256` for every client, exact redirect URI match (loopback any port), refresh rotation
with reuse detection, client credentials with no scopes, RFC 8628 device flow. This unit is the
API half; the consent and activation pages are E9-consent's (wave 3), built on the procedures you
implement.

## You own (write only these)

- `services/api/src/oauth/**` (`endpoints.ts` exists as a stub; add what you need: `pkce.ts`,
  `codes.ts`, `tokens.ts`, `device.ts`, `clients.ts`, `consent.ts`, …)
- `services/api/src/routes/developer/oauth.ts` (`developer.oauth.*`, `developer.grants.*`) and
  `services/api/src/routes/developer/tokens.ts` (`developer.tokens.*`)
- `services/worker/src/jobs/oauth-expire.ts` (stub registered by the contract step) and
  `services/worker/tests/oauth-expire*.ts`
- Tests: `services/api/tests/e9-oauth*.ts` (unit and `.int.test.ts`)
- Harness: `harness/src/e9/oauth.ts` (step 2), `harness/tests/e9/oauth*.test.ts`

Read-only: everything else, in particular `packages/contracts/**`, `packages/db/**`,
`services/api/src/developer/grants.ts`, `services/api/src/lib/**`, `services/api/src/http.ts`,
`routes/developer/index.ts`, other units' files, `harness/src/e9/{run,selectors,receiver,ws-client}.ts`.
Anything else is a **contract request** with the exact diff.

## Contracts you must honor (read-only for you)

- `packages/contracts/src/oauth.ts`: `OAUTH_PATHS`, `OAUTH_LIMITS`, `TokenRequest`,
  `TokenResponse` (RFC string `scope`), `OAuthErrorResponse`/`OAUTH_ERROR_CODES`,
  `DeviceAuthorizationRequest/Response`, `RevokeRequest`, `RedirectUri`, `redirectUriMatches`,
  `pkceChallenge`, `PKCE_VERIFIER`, `PKCE_CHALLENGE`, `parseScope`, `USER_CODE_ALPHABET`,
  `normalizeUserCode`, `DEVICE_CODE_GRANT`.
- Router (`developer:` block): `oauth.request` (GET, loose input, output `OAuthConsent`),
  `oauth.decide` (POST, strict input, `{ redirectTo }`), `oauth.activation` (POST, user code in the
  body, `OAuthDeviceConsent`), `oauth.activate` (POST approve/deny, user code in the body), `grants.list` (`OAuthGrant[]`),
  `grants.revoke({ appId })`, `tokens.list/revoke` (unchanged contract, `AccessToken` gains `appId`
  and `kind`), `tokens.validate` (`login`/`user_id` nullable for app tokens). All `oauth.*` and
  `grants.*` are session only (no `scopes` in meta).
- Tables (`packages/db/src/schema/platform.ts`): `oauth_apps` (`clientSecretHash` null for public
  clients; `suspendedAt`), `oauth_codes` (`codeChallenge` required, method `S256`, `redeemedAt`,
  `familyId`), `oauth_tokens` (`userId` null only for `client_credentials`; `kind`, `familyId`,
  `refreshExpiresAt`, `rotatedAt`; the four checks), `oauth_device_codes` (hashed codes, `status`,
  `intervalSeconds`, `lastPolledAt`, `decidedAt`).
- `services/api/src/developer/grants.ts`: `revokeTokensInTx(tx, scope, now)`,
  `revokeWebhookSubscriptionsInTx`, `publishRevocations(deps, tokens, reason, appWide?)`. Every
  revocation you make goes through them (they publish the `BUS.userControl` messages chat and the
  EventSub WebSocket act on). `webhook-queue.ts` for the `revocation` notices after
  `grants.revoke`.
- `services/api/src/oauth/endpoints.ts`: `oauthEndpoint(deps, req, info): Promise<Response>` is
  called by `http.ts` for exactly `OAUTH_PATHS.token`, `.revoke`, `.device`, with cookies already
  stripped for foreign origins and CORS added by the caller.
- `services/api/src/lib/caller.ts` `resolveBearer` (user and app tokens), `lib/ratelimit.ts`
  (`auth` bucket, `rateLimitKey`), `lib/errors.ts`, `events/audit.ts` (not needed: no admin
  action here).
- Worker: `services/worker/src/jobs/oauth-expire.ts` keeps its queue, name, schema and schedule.
- AGENTS.md: no tokens, secrets, codes or emails in logs; IDs via `uuidv7()`; Zod at boundaries;
  times in UTC.

## What is there today (verified at `c0c16fd`; re-find lines after the contract step)

- `developer.tokens.list/revoke/validate` (`services/api/src/routes/developer.ts:32-94`, moved
  verbatim to `routes/developer/tokens.ts` by the contract step). `revoke` publishes a
  `disconnect` itself (:65-70); switch it to `revokeTokensInTx` + `publishRevocations`
  (`token_revoked`).
- Bot tokens are minted `randomTokenSecret("ca_")` (lowercase: IRC clients lowercase tokens) and
  stored as `sha256Hex` (`services/api/src/routes/me.ts:394-404`). Use the same for every secret
  you mint: access `ca_`, refresh `car_`, authorization code `cac_`, device code `cad_`.
- Rate limiting: `deps.rateLimitStore.hit(rateLimitKey("auth", \`ip:${info.rateLimitHash}\`), deps.rateLimits.auth, …)`as`services/api/src/http.ts:260-273` does for auth routes.

## Build

1. **Token endpoint** `POST /api/oauth2/token` (`oauthEndpoint`). Parameters from an
   `application/x-www-form-urlencoded` body, else the query string (Twitch libraries send query);
   parse with `TokenRequest`; malformed → 400 `invalid_request`. Client authentication:
   `client_secret_basic` or `client_secret_post` for confidential apps (constant-time compare of
   `sha256Hex(secret)`); public apps send `client_id` only and must not send a secret; unknown
   client, wrong secret or a suspended app → 401 `invalid_client` (with `WWW-Authenticate: Basic`
   when basic was used). Every response `cache-control: no-store`, JSON. The `auth` bucket per IP
   applies to every grant **except** `device_code`.
   - `authorization_code`: in one transaction, CAS `update oauth_codes set redeemed_at = now, family_id = $new where code_hash = $1 and redeemed_at is null and expires_at > now returning *`;
     if the code exists but was already redeemed → `invalid_grant` **and** revoke its family
     (`revokeTokensInTx({ familyId })`, publish `token_revoked`) per OAuth 2.1 §4.1.3; app and
     `redirect_uri` must equal the stored ones exactly; `pkceChallenge(code_verifier)` must equal
     `code_challenge`; then insert one `oauth_tokens` row (`kind: "authorization_code"`, the
     code's scopes, access TTL `OAUTH_LIMITS.accessTokenTtlSeconds`, refresh token,
     `refreshExpiresAt` = now + `refreshTokenTtlSeconds`, `familyId`). A deleted user → `invalid_grant`.
   - `refresh_token`: look up by `sha256(refresh_token)`. If the row is rotated or revoked →
     `invalid_grant` and, when `rotatedAt` is set (reuse of a rotated token), revoke the whole
     family and publish (`token_revoked`); expired refresh → `invalid_grant`. Otherwise, in one
     transaction with a CAS on `rotated_at is null`: mark the old row `rotated_at = revoked_at = now`,
     insert the successor (same family, same scopes, new access and refresh token, fresh refresh
     expiry), then publish **`token_rotated`** (not `token_revoked`) for the old access token after
     commit: chat sockets using it close and clients reconnect with the new token, while bound
     EventSub sessions stay open (they are bound to the grant, contract step §0 and §1.5). A lost CAS race → `invalid_grant` without family
     revocation (two concurrent refreshes of the same token are not an attack signal; document it).
   - `client_credentials`: confidential apps only (public → `unauthorized_client`); `scope` must
     be absent or empty (`invalid_scope` otherwise); insert `kind: "client_credentials"`,
     `userId: null`, `scopes: []`, no refresh token, TTL `clientCredentialsTtlSeconds`.
   - `urn:ietf:params:oauth:grant-type:device_code`: look up by `sha256(device_code)` and app.
     Throttle per RFC 8628 §3.5 instead of the `auth` bucket: if `lastPolledAt` is within
     `intervalSeconds`, answer `slow_down` and add `OAUTH_LIMITS.deviceSlowDownSeconds` to the
     interval (CAS so concurrent polls cannot each pass); set `lastPolledAt`. `pending` →
     `authorization_pending`; `denied` → `access_denied`; expired → `expired_token`; `approved` →
     CAS to `redeemed` and issue a token (`kind: "device_code"`, refresh token, new family);
     `redeemed` → `invalid_grant`.
2. **Revocation** `POST /api/oauth2/revoke` (RFC 7009): authenticate the client as above; find
   the token by access or refresh hash (honour `token_type_hint` only as an order of lookup);
   a token of another app is ignored; a refresh token revokes its family, an access token only
   itself. Always 200 with an empty body for valid client authentication, even for unknown tokens.
   Publish `token_revoked`.
3. **Device authorization** `POST /api/oauth2/device` (RFC 8628 §3.1-3.2): any app (public or
   confidential; confidential apps authenticate), `scope` parsed with `parseScope` (unknown →
   `invalid_scope`), at least one scope. Mint `device_code` (`cad_…`) and an 8-letter user code
   from `USER_CODE_ALPHABET` via `crypto.getRandomValues` with rejection sampling (no modulo
   bias); store `sha256` of both (user code normalized); retry on the unique-index collision.
   Answer `verification_uri` = `${site.publicUrl}${OAUTH_PATHS.activatePage}`,
   `verification_uri_complete` = that + `?code=XXXX-XXXX`, `expires_in`, `interval`. `auth` bucket.
4. **Consent procedures** (`routes/developer/oauth.ts`):
   - `oauth.request`: order matters (RFC 6749 §4.1.2.1). Unknown `clientId` → `NOT_FOUND`
     (`invalid_client`); the app suspended → `PRECONDITION_FAILED` with requirement
     `app_suspended`; `redirectUri` not matching any registered URI (`redirectUriMatches`) →
     `PRECONDITION_FAILED` requirement `invalid_redirect_uri`. These never redirect. Past that, every
     problem returns `{ kind: "redirect", redirectTo }` with `error` and `state`:
     `responseType !== "code"` → `unsupported_response_type`; missing or malformed
     `codeChallenge`, or method other than `S256` → `invalid_request` (description "PKCE S256 is
     required"); unknown or no scopes → `invalid_scope`. Otherwise `{ kind: "consent", app, scopes,
     alreadyGranted }` where `alreadyGranted` is true when the caller holds a live grant (unrevoked
     token whose access or refresh is unexpired) for this app covering every requested scope and
     `forceVerify` is false. Build redirect URLs with `URL`/`URLSearchParams` (keep the registered
     URI's own query; append `code`/`error`/`state`), never string concatenation.
   - `oauth.decide`: re-run every check of `request` (never trust that the page called it); deny →
     `{ redirectTo: …?error=access_denied&state=… }`; approve → insert an `oauth_codes` row
     (`cac_…`, 60 s, scopes, the exact presented redirect URI, challenge) and return
     `{ redirectTo: …?code=…&state=… }`. A suspended user cannot (the middleware blocks writes).
     Bot accounts have no session, so they never consent.
   - `oauth.activation`: normalize the user code, look it up by hash; unknown → `NOT_FOUND`;
     expired or no longer `pending` → `PRECONDITION_FAILED` requirement `expired` (unknown and
     expired must be distinguishable for the page: `device-error data-error`). It is a POST with
     the code in the body (decided 2026-10-29: a code in a path or query reaches access logs), and
     its meta puts it in the `auth` bucket (`u:<userId>` subject, 10 a minute), which stops
     user-code guessing with no counting in the handler. Never log the user code.
   - `oauth.activate`: CAS `pending` → `approved` (with `userId`, `decidedAt`) or `denied`; anything
     else → `CONFLICT`.
   - `grants.list`: one entry per app with a live grant for the caller (tokens with `appId` not
     null, `userId` = caller, unrevoked, access or refresh unexpired), scopes the union, earliest
     `createdAt` of the live family as `authorizedAt`, latest `lastUsedAt`.
   - `grants.revoke({ appId })`: one transaction: `revokeTokensInTx({ appId, userId })` and
     `revokeWebhookSubscriptionsInTx({ appId, userId })`; after commit `publishRevocations(…,
     "grant_revoked")` and enqueue one `revocation` job per subscription id
     (`webhookQueue(deps).enqueue("revocation", { subscriptionId }, \`revocation-${id}\`)`).
     Unknown or already revoked → still `{ ok: true }`(idempotent). The notices after commit are
     **best effort, as in`tokens.revoke`** (decided 2026-10-29; ADR 0027 consequences): a failed
     publish or enqueue is logged (ids only) and the call still answers `{ ok: true }`; it is not
     retried in the request. The database revocation is authoritative: the tokens stop resolving
     at once, chat revalidates OAuth tokens within 30 s (`services/chat/src/auth.ts:57`), the
     EventSub fan-out re-authorizes each subscription at least every 30 s (E9-ws), and webhook
     deliveries are authorized at delivery time.
5. **`developer.tokens.*`** (`routes/developer/tokens.ts`): `list` returns `appId` and `kind`;
   `revoke` goes through `revokeTokensInTx({ tokenIds: [id] })` + `publishRevocations`
   (`token_revoked`), keeping today's "tokens a member answers for" rule; `validate` uses
   `resolveBearer`: for an app token `{ client_id, login: null, user_id: null, scopes: [], expires_in }`.
6. **Housekeeping job** `oauth-expire` (worker, hourly): delete `oauth_codes` expired more than a
   day ago; `oauth_device_codes` expired more than a day ago; `oauth_tokens` whose access and
   refresh (if any) expired more than 30 days ago or that were revoked more than 30 days ago
   (keep rotated rows until their refresh expiry passes, so reuse detection still finds them).
   Batched deletes (`limit` 5000 per statement, loop) so a big backlog never holds a long lock.
   Returns the three counts.
7. **Logs and errors.** Log outcomes with ids and enums only (`appId`, `grant`, `error` code);
   never a token, code, secret, `redirect_uri` with its query, or `state`. Error descriptions are
   fixed English strings (they are API reference text, not UI copy).
8. **Harness step 2** (`harness/src/e9/oauth.ts`, flip `ready: true`): exactly the
   `docs/testing/e9-selectors.md` scenario step 2, over HTTP against `HARNESS_API_URL` (the
   streamer's session approves through `developer.oauth.decide`; the loopback redirect is read
   from the returned `redirectTo`, no browser). Store the grant and app token in `E9Run.state` for
   steps 4-6 and 8 (step 5 revokes the grant; later steps re-authorize with the orchestrator's
   `authorizeOverApi` in `harness/src/e9/run.ts`, which you may also use for the happy path).
   Report ids and outcomes only.

## Tests you must add

- Unit (`services/api/tests/e9-oauth.test.ts`): form/query parameter merging, client
  authentication (basic with URL-encoded credentials per RFC 6749 §2.3.1, post, both present →
  `invalid_request`), user-code generation (alphabet, length, no modulo bias over a large sample
  by construction), redirect URL building (keeps the registered query, encodes `state`).
- Integration (`services/api/tests/e9-oauth.int.test.ts`, `createTestDatabase()`, a real Valkey):
  the full code flow; wrong verifier; code reuse revokes the family (and publishes); code expiry
  at 60 s (move `deps.now`); redirect URI exact match and loopback port freedom; public client with
  a secret refused; confidential without secret refused; refresh rotation (old row rotated and
  revoked, new row same family); reuse of a rotated refresh revokes the family and the newest
  access token no longer resolves; concurrent refresh (two in parallel → one success, no family
  revocation; the published message has reason `token_rotated`); client credentials (no user, no
  scopes, `oauth2/validate` shape, a `user` procedure refuses it with 403, a `developer.events.list`
  call passes access control: assert it is neither 401 nor 403, since E9-subs implements the
  handler in parallel and it may still answer 501 on your base); device flow end to end with
  `authorization_pending`, `slow_down` (interval grows by 5), `access_denied`, `expired_token`,
  double redemption; revocation endpoint for access and refresh tokens and an unknown token (200);
  suspended app → `invalid_client` everywhere; `oauth.request` error routing (never redirects for
  client/redirect errors, redirects for the rest); `grants.list/revoke` (subscriptions revoked,
  jobs enqueued, messages published, other grants untouched; with the Valkey publish failing the
  revocation still commits and the call answers `{ ok: true }`); `tokens.revoke` publishes;
  `oauth.activation` and `oauth.activate` take the code in the body (the OpenAPI paths carry none)
  and the eleventh lookup in a minute is `RATE_LIMITED`.
- Worker (`services/worker/tests/oauth-expire.int.test.ts`): each retention rule at its boundary;
  rotated rows kept until refresh expiry.
- Harness: pure helpers of step 2 (PKCE pair generation, redirect parsing) in
  `harness/tests/e9/oauth.test.ts`.

## Done means

Follow `.claude/briefs/_done-means.md` (targeted checks only; CI on main is the gate): `bun --bun
vp test run` and `bun run test:int` in `services/api`, then `services/worker` (never two
packages' `test:int` at once), `harness` unit tests; `bunx tsc -p services/api --noEmit`, same for
`services/worker` and `harness`; `vp lint --deny-warnings` and `vp fmt` on your paths. Never run
`bun run verify`, `verify:full`, a harness scenario, `podman compose` or `scripts/infra.ts`.
`grep -c '.handler(notImplemented)' services/api/src/routes/developer/oauth.ts` is 0. `git status`
shows only your paths. Commit in your worktree (`git commit -s`, Conventional Commits, ending with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Final message: what you built, test
counts per package, branch and sha, contract requests (exact diffs),
proposed `docs/developers/oauth.md` facts for E9-console (endpoints, lifetimes, error codes), and
the exact command the user can run live: `bun harness/src/cli.ts run developer-platform --set steps=1-2 --set via=api`.
