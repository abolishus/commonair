<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E9-subs: EventSub subscriptions over HTTP (API) and webhook revocation notices (worker)

You are implementing unit E9-subs for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/E9-developer-platform.md`,
`docs/decisions/0027-oauth-and-eventsub.md` (§1 on app tokens and backing users, §3),
`.claude/briefs/e9/contract-step.md` (§0, §1.4 `eventsub.ts`, §1.5 `BUS.eventsubControl`, §1.6
`WEBHOOK_JOBS.revocation`, §1.8 router, §2.2 `event_subscriptions`, §2.4, §3.1 `requireActor`,
§3.4, §4 `eventsub/index.ts` and `webhook-queue.ts`, §9) and `docs/testing/e9-selectors.md`
(scenario step 4). Do not look outside the repository. Work in your own git worktree on a branch
named `e9/subs`, created from `main` at the start of batch-3 wave 2 (the orchestrator gives you
the sha; it contains the E9 contract step); run `git merge main` first if main moved. Wave 2,
beside E9-oauth, E9-apps, E9-ws (which implements the WebSocket session registry you bind
against), E8-studio and E8-viewer.

## Why

The worker already delivers webhooks end to end (`services/worker/src/webhooks/**`: signing,
backoff, SSRF guard, callback verification, test events, redelivery, pruning), but no API creates
a subscription: the seven `developer.events.*` handlers are stubs, so `webhooks.int.test.ts` seeds
rows in SQL. You build the HTTP side for both transports, the authority rules (who may subscribe
to what, backed by whom), and the one worker gap: telling a webhook receiver its subscription was
revoked when the API revokes it.

## You own (write only these)

- `services/api/src/routes/developer/events.ts` (`developer.events.*`)
- `services/api/src/developer/subscriptions/**` (new: authority, validation, DTOs, queries)
- `services/worker/src/webhooks/**` and `services/worker/src/jobs/webhook-*.ts` (the contract
  step moved the pure parts out and created the `webhook-revocation.ts` stub; keep every existing
  behaviour), `services/worker/tests/webhook*.ts`
- Tests: `services/api/tests/e9-subs*.ts`
- Harness: `harness/src/e9/webhook.ts` (step 4), `harness/tests/e9/webhook*.test.ts`

Read-only: `packages/**` (in particular `contracts/src/eventsub.ts`, `db/src/eventsub.ts`),
`services/api/src/eventsub/**` (E9-ws's), `services/api/src/developer/{grants,webhook-queue}.ts`,
`lib/**`, other units' files, `harness/src/e9/{run,selectors,receiver,ws-client}.ts`. Anything
else is a **contract request** with the exact diff.

## Contracts you must honor (read-only for you)

- Router `developer.events.*`: `catalog` (public; items gain `transports`), `subscribe` (meta
  `scopes: []`, `appTokens: true`, `write`; input `appId?` for session callers), `list` (`appId?`,
  `type?`, `status?`, page), `unsubscribe`, `deliveries` (page), `sendTest` (`{ eventId }`),
  `redeliver`. Entity `EventSubscription` (`appId`, `userId`, `failureCount`, transport union).
- `@commonair/contracts/eventsub`: `bindingFor`, `conditionComplete`, `broadcasterOf`,
  `backingUserOf`, `matchesCondition`, `subscriptionEnvelope`, `ENVELOPE_STATUS`,
  `WEBSOCKET_ONLY_EVENT_TYPES`, `transportsFor`. `@commonair/db` `authorizeSubscription(db, sub,
  type, now)` (the worker uses the same function at delivery time: one rule set).
- `services/api/src/lib/orpc.ts` `requireActor(ctx)` → `{ kind: "user", caller }` (session or
  user token; `caller.kind === "token"` carries `appId`, `tokenId`, `scopes`) or `{ kind: "app", app }`.
- `services/api/src/eventsub/index.ts`: `eventSubSessions(deps).bind(sessionId, { appId, userId, tokenHash })`
  → `"ok" | "unknown_session" | "other_grant" | "too_many_sessions"`; `setEventSubSessions` for
  tests. E9-ws implements it in parallel; code and test against the interface with a fake.
- `BUS.eventsubControl` + `EventSubControlMessage` (`subscriptions_changed`, `sessionId`): publish
  after every WebSocket subscription you create or delete, so the instance holding the session
  reloads it.
- `services/api/src/developer/webhook-queue.ts`: `webhookQueue(deps).enqueue("verify-callback" | "test-event" | "redeliver" | "revocation", data, jobId)`.
- `WEBHOOK_JOBS`, `VerifyCallbackJob`, `TestEventJob`, `RedeliverJob`, `RevocationJob`; the worker
  job file names and schedules.
- Table `event_subscriptions` (transport check: webhook ↔ callback and secret; websocket ↔ session
  id; the dedupe unique now includes the session id), `webhook_deliveries`.
- Webhook secrets are stored with `encryptSecret(env.AUTH_SECRET, "webhook", secret)` (the worker
  decrypts with purpose `"webhook"`, `services/worker/src/webhooks/deliver.ts:64-69`).
- Env: `EVENTSUB_ALLOW_INSECURE_CALLBACKS` (http and private networks allowed: dev and harness),
  `EVENTSUB_WS_MAX_SUBSCRIPTIONS`.

## Authority rules (decided here within ADR 0027; put them in the procedure docs and your final message)

1. **Actor.** A session caller, a user token (with or without an app: bot tokens have `appId:
   null`), or an app-only token (client credentials).
2. **App of the subscription.** User token → its `appId`; app token → its app; session → `input.appId`
   (must be an app the caller owns, not suspended; else `NOT_FOUND`) or `null` (personal). `appId`
   in the input from a token caller → `FORBIDDEN`.
3. **Backing user (`userId`).**
   - Scope-less event types (`bindingFor(EVENTS[type].scopes) === "none"`: `stream.online`,
     `channel.follow`, …): a user caller backs it themselves; an app (token, or session with
     `appId`) is backed by **the app's owner** (public data; the owner trivially stands behind
     their app). This is the drafting decision recorded in the contract step §0.
   - Scoped types: a user caller backs it themselves and `authorizeSubscription` must pass for
     them (their grant, or their personal token for `appId: null`, holds the scopes and the
     condition names them as broadcaster/moderator/self). An app-only token (or a session with
     `appId`) is backed by `backingUserOf(type, condition)`, who must hold a live grant of that app
     with the scopes (`authorizeSubscription` passes); otherwise `FORBIDDEN` "the broadcaster has
     not authorized this app for <scopes>". A session caller with `appId: null` cannot create a
     scoped subscription (no token backs it): `PRECONDITION_FAILED` requirement `token_required`.
4. **Transport.** `webhook` is refused for `WEBSOCKET_ONLY_EVENT_TYPES`
   (`PRECONDITION_FAILED` requirement `websocket_only`). `websocket` needs a user token (not a
   session, not an app token; `FORBIDDEN`); bind the session first:
   `unknown_session` → `PRECONDITION_FAILED` `websocket_session`; `other_grant` → `FORBIDDEN`;
   `too_many_sessions` → `PRECONDITION_FAILED` `websocket_session_limit`. Then, under
   `pg_advisory_xact_lock(hashtextextended('eventsub-session:' || sessionId, 0))`, count the
   session's enabled subscriptions; at `EVENTSUB_WS_MAX_SUBSCRIPTIONS` →
   `PRECONDITION_FAILED` `websocket_subscription_limit`. Insert `enabled`; after commit publish
   `subscriptions_changed`.
5. **Visibility** (list, unsubscribe, deliveries, sendTest, redeliver): session caller → rows with
   `appId` of an app they own, or `appId: null` and `userId` = caller; user token → rows with the
   token's `appId` and `userId` = token user; app token → every row of its app. Anything else →
   `NOT_FOUND`.

## Build

1. **`catalog`**: every public event type with `version`, `condition`, `scopes`, `description`,
   `transports: transportsFor(type)`; static, cache it.
2. **`subscribe`**: validate `type`/`version` against `EVENTS` (only version `"1"` exists),
   condition keys exactly the catalog's (unknown key → `PRECONDITION_FAILED` `condition_keys`;
   `conditionComplete` false → same requirement), the rules above. Webhook: callback must be
   `https:`, and literal private, loopback and link-local addresses and names that resolve only to
   them are refused at create time, **both unless `EVENTSUB_ALLOW_INSECURE_CALLBACKS`** (as the
   worker's guard does, `services/worker/src/webhooks/ssrf.ts:172-189`: the harness receiver is
   `http://host.containers.internal:<port>`, a private address) (reuse the API's
   outbound vetting in `services/api/src/lib/outbound.ts` where it fits; the worker re-checks at
   every delivery with its own SSRF guard); secret 10-100 chars, stored encrypted; status
   `verification_pending`; enqueue `verify-callback` (`jobId: verify-${id}`). Personal limit
   1000 webhook subscriptions per user, app limit 10 000 per app (`PRECONDITION_FAILED`
   `subscription_limit`; constants in your module, listed in your final message for the docs).
   Unique violation → `CONFLICT`.
3. **`list`**: keyset pagination on (`createdAt`, `id`) with `lib/cursor.ts`; filters. DTO from the
   row (`transport` union from `transport`/`callbackUrl`/`websocketSessionId`).
4. **`unsubscribe`**: delete the row (deliveries cascade). WebSocket rows: publish
   `subscriptions_changed`. No revocation message (the client asked).
5. **`deliveries`**: the subscription's `webhook_deliveries`, newest first, keyset pagination; never
   `responseBody` (it is in the table for operators, not in the DTO).
6. **`sendTest`**: webhook subscriptions only (`PRECONDITION_FAILED` `webhook_only`); enabled only
   (`PRECONDITION_FAILED` `not_enabled`); new `eventId = uuidv7()`; enqueue `test-event`
   (`jobId: test-${eventId}`); return `{ eventId }`.
7. **`redeliver`**: the delivery must belong to a visible subscription and be a `notification`
   that failed; enqueue `redeliver` (`jobId: redeliver-${deliveryId}-${now ms}`).
8. **Worker `webhook-revocation` job** (`jobs/webhook-revocation.ts`): load the subscription; if it
   is `revoked` and a webhook, call `sendRevocation(ctx, sub, ENVELOPE_STATUS.revoked, uuidv7())`
   once (it logs the attempt in `webhook_deliveries` with `messageType: "revocation"`); return
   `{ sent: 0 | 1 }`. Make it idempotent across retries (skip if a `revocation` delivery row exists
   for that subscription).
9. **Harness step 4** (`harness/src/e9/webhook.ts`, flip `ready: true`): scenario step 4 of
   `docs/testing/e9-selectors.md`, using `E9Run.state.appToken` and the shared receiver; verify
   signatures with `verifyWebhook` from `@commonair/contracts/events` (E9-sdk's step repeats it
   with the SDK); check `EventSubscription.status` turns `enabled` after the challenge; leave the
   follow subscription in place for steps 7 and 8.

## Tests you must add

- Unit (`services/api/tests/e9-subs.test.ts`): the authority table (actor × binding × transport),
  condition-key validation, DTO mapping for both transports.
- Integration (`services/api/tests/e9-subs.int.test.ts`, real Postgres and Valkey; fake
  `EventSubSessions` and fake webhook queue): each rule above with its error code; app token
  scope-less subscription backed by the owner; app token scoped subscription refused without a
  grant and accepted with one; WebSocket bind outcomes and the per-session limit (lower it in the
  test env); `subscriptions_changed` published; `webhook` refused for `channel.chat.message`;
  visibility across two apps and a personal caller; `sendTest`/`redeliver` enqueue with the right
  job ids; dedupe → `CONFLICT`; encrypted secret decrypts with purpose `"webhook"`.
- Worker (`services/worker/tests/webhook-revocation.int.test.ts`, the existing webhook test
  fixtures): a revoked subscription gets one revocation POST and one log row; a retry sends nothing
  more; an enabled one is skipped. The existing `webhooks.int.test.ts` and `webhook-logic.test.ts`
  stay green unchanged except for fixture updates the contract step already made.
- Harness: pure helpers of step 4.

## Done means

Follow `.claude/briefs/_done-means.md` (targeted checks only): `bun --bun vp test run` and `bun
run test:int` in `services/api`, then in `services/worker` (never at the same time); `harness`
unit tests; `bunx tsc -p` for `services/api`, `services/worker`, `harness`; `vp lint
--deny-warnings` and `vp fmt` on your paths. Never run `bun run verify`, a harness scenario,
`podman compose` or `scripts/infra.ts`. `grep -c '.handler(notImplemented)'
services/api/src/routes/developer/events.ts` is 0. `git status` shows only your paths. Commit in
your worktree (`git commit -s`, Conventional Commits, ending with `Co-Authored-By: Claude Opus 5.5
<noreply@anthropic.com>`). Final message: what you built, test counts, branch and sha, contract
requests (exact diffs), the authority rules and limits as text for `docs/developers/eventsub.md`,
and the live command after the wave: `bun harness/src/cli.ts run developer-platform --set steps=1-2,4 --set via=api`.
