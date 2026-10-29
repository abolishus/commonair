<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E9-apps: OAuth app registration and admin suspension (API)

You are implementing unit E9-apps for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/E9-developer-platform.md`,
`docs/decisions/0027-oauth-and-eventsub.md` (§1, §4), `.claude/briefs/e9/contract-step.md` (§0,
§1.7-1.8, §2.2, §4 `grants.ts`, §9) and `docs/testing/e9-selectors.md` (Rules; scenario steps 1
and 8). Do not look outside the repository. Work in your own git worktree on a branch named
`e9/apps`, created from `main` at the start of batch-3 wave 2 (the orchestrator gives you the sha;
it contains the E9 contract step); run `git merge main` first if main moved. Wave 2, beside
E9-oauth, E9-subs, E9-ws, E8-studio and E8-viewer.

## Why

`developer.apps.*` are five `notImplemented` stubs, so nobody can register an app, and ADR 0027 §4
adds admin suspension (tokens stop resolving, sockets close, webhook subscriptions revoked, audit
row; unsuspending restores nothing). E9-oauth issues tokens for the apps you create; E9-console
(wave 3) builds the pages on your procedures.

## You own (write only these)

- `services/api/src/routes/developer/apps.ts` (`developer.apps.*`) and
  `services/api/src/routes/developer/admin.ts` (`developer.admin.*`)
- `services/api/src/developer/apps/**` (new: helpers, DTO mapping, client id and secret minting)
- Tests: `services/api/tests/e9-apps*.ts`
- Harness: `harness/src/e9/app.ts` (step 1) and `harness/src/e9/suspend.ts` (step 8),
  `harness/tests/e9/apps*.test.ts`

Read-only: everything else (`packages/**`, `services/api/src/developer/{grants,webhook-queue}.ts`,
`lib/**`, other units' files, `harness/src/e9/{run,selectors,receiver,ws-client}.ts`). Anything
else is a **contract request** with the exact diff.

## Contracts you must honor (read-only for you)

- Router `developer.apps.list/create/update/rotateSecret/remove` (session only, `write` bucket on
  writes), `developer.admin.list/suspend/unsuspend` (`admin` access); input `redirectUris` uses
  `RedirectUri` (≤ `OAUTH_LIMITS.redirectUrisPerApp`), output `OAuthApp` (with `suspended`),
  `OAuthAppSecret` (shown once), `AdminOAuthApp` (`owner`, `grants`, `subscriptions`).
- `APP_SUSPENSION_REASONS`, `OAUTH_LIMITS.appsPerUser`.
- Table `oauth_apps` (checks: `confidential = (client_secret_hash is not null)`; suspension at and
  reason together), FK cascades from `oauth_apps` to `oauth_codes`, `oauth_tokens`,
  `oauth_device_codes`, `event_subscriptions` (and on to `webhook_deliveries`).
- `services/api/src/developer/grants.ts`: `revokeTokensInTx({ appId }, now)`,
  `revokeWebhookSubscriptionsInTx({ appId })`, `publishRevocations(deps, tokens, reason, { appId })`
  (`app_suspended` / `app_removed` publish the app-wide `disconnect` that closes chat-token
  sockets and EventSub sessions). `webhook-queue.ts` for `revocation` notices.
- `services/api/src/events/audit.ts`: `audit(tx, …)` with ids and enums only.
- AGENTS.md: every admin action writes an `audit_log` row; no secrets in logs.

## Build

1. **`apps.create`**: signed-in human (bots have no session). At most `OAUTH_LIMITS.appsPerUser`
   apps per owner (`PRECONDITION_FAILED` requirement `app_limit`). `clientId`: 30 lowercase
   alphanumerics from `crypto.getRandomValues` (Twitch's shape); confidential apps get a secret
   `randomTokenSecret("cas_")`, stored as `sha256Hex`, returned once in `secret`; public apps get
   `secret: null` and `clientSecretHash: null`. Names need not be unique; trim them.
2. **`apps.list`**: the caller's apps, newest first. **`apps.update`**: owner only (`NOT_FOUND` for
   anyone else, never `FORBIDDEN`, so app ids do not leak); a suspended app cannot be changed
   (`PRECONDITION_FAILED` requirement `app_suspended`). Changing redirect URIs does not revoke
   tokens (codes already issued are checked against the URI they were issued for).
   **`apps.rotateSecret`**: owner, confidential only (`PRECONDITION_FAILED` `public_client`),
   not suspended; new secret replaces the hash, `secretRotatedAt` set; the old secret stops working
   at once (no overlap window; say so in your final message for the docs). Tokens are not revoked.
3. **`apps.remove`**: owner. One transaction: `revokeTokensInTx({ appId })` (to get the hashes),
   then delete the app (cascades codes, tokens, device codes, subscriptions, deliveries). After
   commit `publishRevocations(deps, tokens, "app_removed", { appId })`. No revocation webhook is
   possible (the rows are gone); document that in your final message.
4. **Admin** (`routes/developer/admin.ts`): `list` with `q` (case-insensitive substring of name or
   exact client id) and `suspended` filter, keyset pagination on (`createdAt`, `id`) with the
   cursor helper in `lib/cursor.ts`; `grants` = distinct users with a live grant, `subscriptions` =
   enabled webhook subscriptions (two grouped counts, not N+1).
   `suspend({ id, reason })`: one transaction with a row lock: already suspended → `CONFLICT`; set
   `suspendedAt`, `suspendedReason`, `suspendedById`; `revokeTokensInTx({ appId })`;
   `revokeWebhookSubscriptionsInTx({ appId })`; audit `developer.app.suspend` (`subjectType:
   "oauth_app"`, `subjectId`, `details: { reason, tokens: n, subscriptions: m }`). After commit
   `publishRevocations(…, "app_suspended", { appId })` and one `revocation` job per subscription.
   `unsuspend({ id })`: not suspended → `CONFLICT`; clear the three columns; audit
   `developer.app.unsuspend`; tokens stay revoked (users re-authorize, ADR 0027 §4).
5. **DTOs** in `services/api/src/developer/apps/dto.ts`: `toOAuthApp(row)`,
   `toAdminOAuthApp(row, owner, counts)`; never return the hash.
6. **Harness steps** (flip `ready: true` in each):
   - Step 1 (`app.ts`): the developer creates the confidential app (redirect
     `${receiver.origin}/cb` on `127.0.0.1`) and a public app; updates the description; rotates the
     confidential secret and checks the old one now fails at `OAUTH_PATHS.token` with
     `invalid_client` (a client-credentials request is the cheapest probe; if E9-oauth has not
     merged when you run your own checks, that assertion is part of step 1 anyway, the orchestrator
     runs the scenario after the wave). Store both apps in `E9Run.state`.
   - Step 8 (`suspend.ts`): scenario step 8 of `docs/testing/e9-selectors.md` over the API (the
     admin actor suspends with `abuse`; the receiver must see one `revocation` for step 4's
     subscription; step 5 revoked the streamer's grant, so first re-authorize with
     `authorizeOverApi` (`harness/src/e9/run.ts`, the orchestrator's; never import E9-oauth's step
     module); an EventSub socket opened and bound in this step with that new grant token closes
     with `EVENTSUB_WS_CLOSE.authorizationRevoked`; the audit row is found with `safety.auditLog`
     (`subjectType: "oauth_app"`, `subjectId`); unsuspend; the owner removes the app; `developer.events.list` for
     it is empty).

## Tests you must add

- Unit: client id and secret shapes; DTO never carries the hash.
- Integration (`services/api/tests/e9-apps.int.test.ts`): create confidential/public (secret
  once, hash stored, public has none), limit 25, update/rotate/remove by non-owner → `NOT_FOUND`,
  rotate on a public app refused, suspended app cannot be updated or rotated; remove cascades and
  publishes `app_removed` (capture `BUS.userControl` with a Valkey subscriber); admin list filters
  and counts; suspend revokes tokens and webhook subscriptions, writes the audit row (no free text),
  enqueues revocation jobs (install a fake with `setWebhookQueue`), publishes `app_suspended`; a
  suspended app's token no longer resolves (`resolveBearer`); unsuspend leaves tokens revoked;
  non-admin → `FORBIDDEN`; double suspend → `CONFLICT`.
- Harness: pure helpers of steps 1 and 8, if any.

## Done means

Follow `.claude/briefs/_done-means.md` (targeted checks only): `bun --bun vp test run` and `bun
run test:int` in `services/api`; `harness` unit tests; `bunx tsc -p services/api --noEmit` and
`harness`; `vp lint --deny-warnings` and `vp fmt` on your paths. Never run `bun run verify`, a
harness scenario, `podman compose` or `scripts/infra.ts`. `grep -c '.handler(notImplemented)'
services/api/src/routes/developer/{apps,admin}.ts` is 0 for both. `git status` shows only your
paths. Commit in your worktree (`git commit -s`, Conventional Commits, ending with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Final message: what you built, test
counts, branch and sha, contract requests (exact diffs), facts for the developer docs (secret
rotation has no overlap; removal sends no revocation webhooks), and the live commands:
`bun harness/src/cli.ts run developer-platform --set steps=1 --set via=api` and, after the wave,
`--set steps=1-2,4-5,8`.
