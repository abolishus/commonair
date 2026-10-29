<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E9-ws: the EventSub WebSocket transport (API)

You are implementing unit E9-ws for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/E9-developer-platform.md`,
`docs/decisions/0027-oauth-and-eventsub.md` (§3 in full), `.claude/briefs/e9/contract-step.md`
(§0 rows on the WebSocket, §1.4 `eventsub.ts`, §1.5 `UserControlMessage`/`userControlTargets`/
`BUS.eventsubControl`, §1.6 `KEYS.eventsub*`, §2.4, §3.5 env, §4 `eventsub/index.ts` and the
`main.ts` wiring, §5 Caddy, §9) and `docs/testing/e9-selectors.md` (scenario step 5). Do not look
outside the repository, except Twitch's public EventSub WebSocket semantics, which you may cite
from memory. Work in your own git worktree on a branch named `e9/ws`, created from `main` at the
start of batch-3 wave 2 (the orchestrator gives you the sha; it contains the E9 contract step);
run `git merge main` first if main moved. Wave 2, beside E9-subs (which creates the subscriptions
your sessions carry), E9-oauth, E9-apps, E8-studio and E8-viewer.

## Why

The message shapes exist (`WsMetadata`, `WsMessage`, `packages/contracts/src/events.ts:775-798` at
`c0c16fd`) but no server speaks them. Bots and browser apps that cannot receive webhooks need a
socket: welcome, keepalive, notifications, reconnect during rolling upgrades, revocation that
closes the socket when a token, grant, user or app is revoked.

## You own (write only these)

- `services/api/src/eventsub/**` (`index.ts` exists as a stub with the exported names the
  contract step fixed; add `server.ts`, `sessions.ts`, `hub.ts`, `fanout.ts`, `sweep.ts`, …)
- Tests: `services/api/tests/e9-ws*.ts`
- Harness: `harness/src/e9/websocket.ts` (step 5), `harness/tests/e9/websocket*.test.ts`

Read-only: `packages/**`, `services/api/src/{main,index,http}.ts` (already wired by the contract
step), `lib/**`, `developer/**`, other units' files, `services/chat/**`,
`harness/src/e9/{run,selectors,receiver,ws-client}.ts`. Anything else is a **contract request**
with the exact diff.

## Contracts you must honor (read-only for you)

- `services/api/src/eventsub/index.ts` exported surface (keep every name and type; extend
  `EventSubSocketData` freely): `startEventSub(deps)`, `eventSub(deps)`, `closeEventSub(deps)`,
  `EventSub { websocket, upgrade(req, server), warm, drain() }`, `EventSubSessions.bind`,
  `eventSubSessions(deps)`, `setEventSubSessions`, `EventSubGrant`, `BindResult`. `main.ts` routes
  `GET /eventsub/ws` to `upgrade`, passes `websocket` to `runService`, checks `warm` for
  readiness, calls `startEventSub` before `runService`, and sets `shutdownTimeoutMs` to the
  reconnect grace + 10 s; the drain itself is yours, on SIGTERM/SIGINT (see Reconnect). The API
  container's stop grace is 45 s (compose and Quadlet, contract step §4).
- `@commonair/contracts/eventsub`: `EVENTSUB_WS_PATH`, `EVENTSUB_WS_KEEPALIVE` (default 10,
  10-600, query `keepalive_timeout_seconds`), `EVENTSUB_WS_CLOSE` (4000-4008),
  `subscriptionEnvelope`, `matchesCondition`. `@commonair/db`: `authorizeSubscription`,
  `notificationMessageId` (same id the webhook path uses for the same subscription and event).
- `@commonair/contracts/events`: `WsMessage`/`WsMetadata` (validate what you send in tests),
  `BusEvent`, `BUS.events`, `BUS.userControl` + `UserControlMessage` + `userControlTargets`,
  `BUS.eventsubControl` + `EventSubControlMessage`.
- `KEYS.eventsubSession`, `eventsubGrantSessions`, `eventsubResume`, `eventsubSweepLock`.
- Env: `EVENTSUB_WS_MAX_SESSIONS_PER_GRANT`, `EVENTSUB_WS_SUBSCRIBE_WITHIN_SECONDS`,
  `EVENTSUB_WS_RECONNECT_GRACE_SECONDS` (and `EVENTSUB_WS_MAX_SUBSCRIPTIONS`, enforced by E9-subs).
- Table `event_subscriptions` (`transport = 'websocket'`, `websocket_session_id`, index
  `event_subscriptions_ws_session_idx`). E9-subs inserts and deletes rows and publishes
  `subscriptions_changed`; you delete a session's rows when the session ends.
- Caddy routes `/eventsub/ws` to `api:3001` unchanged (no rewrite); the harness connects to the
  API port directly.

## Design (decided in the contract step; implement exactly)

- **Connect** (`upgrade`): `GET` with `Upgrade: websocket` only (else 400/426). Query
  `keepalive_timeout_seconds` (absent → 10; outside 10-600 → 400) and `resume` (see reconnect).
  Rate-limit connects per client address with the `auth` bucket keyed `ip:<rateLimitHash>`
  (compute it with `clientIp`, `canonicalIp`, `rateLimitSubjectIp` and `hmacHex(AUTH_SECRET, "rl:" + …)`
  exactly as `http.ts` `requestInfo` does; never store or log the address). No authentication at
  connect: browsers cannot send headers. New session id: `uuidv7()`. Write the session hash
  (`instance` = a per-process random id, `keepalive`, `connectedAt`) with a TTL of 3× keepalive,
  refreshed with each keepalive. Send `session_welcome` (`status: "connected"`,
  `keepalive_timeout_seconds`, `reconnect_url: null`, `connected_at`).
- **Bind** (`EventSubSessions.bind`, called by E9-subs on the first and every later WebSocket
  subscribe): atomically (one Lua script): unknown or expired session → `unknown_session`; unbound
  → check the grant ZSET (`appId || "personal"` + `userId`) has fewer than
  `EVENTSUB_WS_MAX_SESSIONS_PER_GRANT` members (drop members whose session key is gone first),
  else `too_many_sessions`; then set `appId`, `userId`, `tokenHash` and add to the ZSET; bound to
  the same grant (`appId`, `userId`), with this or any other token of it → `ok` and store the
  presented `tokenHash` (a refreshed token keeps using the session); bound to another grant →
  `other_grant`. The holding instance
  learns of the binding from its next reload (below) or the `subscriptions_changed` message.
- **Unused session**: if `EVENTSUB_WS_SUBSCRIBE_WITHIN_SECONDS` after welcome the session has no
  subscription row, close with 4003.
- **Inbound traffic**: any client text or binary frame closes with 4001 (Twitch semantics). Pongs
  to server pings are fine.
- **Keepalive**: send `session_keepalive` whenever nothing was sent for the keepalive period. Set
  Bun's `websocket.idleTimeout` above the 600 s maximum (Bun's default 120 s would close quiet
  sockets) and keep `sendPings` on.
- **Fan-out**: one Valkey subscriber per process on `BUS.events`, `BUS.userControl`,
  `BUS.eventsubControl` (model it on `services/api/src/overlay/stream.ts`: shared subscriber,
  start-up retry, `warm`). Keep an in-memory index of the subscriptions of the sessions this
  process holds, loaded from Postgres when a session binds or on `subscriptions_changed`, and fully
  reloaded every 60 s as a safety net. For each `BusEvent`: candidate subscriptions by
  `type`/`version` → `matchesCondition(sub.condition, event.payload, sub.userId)` →
  `authorizeSubscription` (cache the result per subscription for 30 s; drop the cache entries of a
  session on any `userControl` message that targets it) → send `notification` with
  `metadata.message_id = notificationMessageId(sub.id, event.id)`, `subscription_type`,
  `subscription_version`, `payload: { subscription: subscriptionEnvelope(sub), event: event.payload }`.
  An authorization that fails → send `revocation` for that subscription, delete its row. Never
  block the subscriber loop on a slow socket: respect Bun's backpressure (`send` result) and close
  a socket that stays over a buffered-bytes cap with 4000.
- **Revocation**: on `BUS.userControl` `disconnect`, for every held session whose binding
  `userControlTargets({ userId, appId, tokenHash }, msg)` matches (bound sessions only): send one
  `revocation` per subscription (`status: "authorization_revoked"`), delete the session's rows,
  close with 4008. **Except reason `token_rotated`** (a refresh replaced the access token; the
  grant lives on): drop cached authorizations only, never close. `invalidate` drops cached
  authorizations only. (A rotated token's binding hash may be stale; that is fine: a real
  revocation of the grant or family arrives as one message per token, or app/user-wide.)
- **Reconnect** (`drain()`, rolling upgrades). `startEventSub` registers
  `process.once("SIGTERM")`/`("SIGINT")` handlers that call `drain()` (main.ts calls it before
  `runService`, so they run first): `main.ts` does **not** call `drain()` from `onShutdown`,
  because runService awaits `server.stop()` first and that waits for open WebSockets (contract
  step §4; chat does the same in `services/chat/src/server.ts:331-342`). For every held session, mint a one-time resume
  token (`randomTokenSecret("ces_")`), store `sha256 → sessionId` under `KEYS.eventsubResume` for
  `EVENTSUB_WS_RECONNECT_GRACE_SECONDS`, send `session_reconnect` with `reconnect_url` =
  `${wss origin of site.publicUrl}${EVENTSUB_WS_PATH}?resume=<token>` (`ws://` for an `http:`
  public URL); then wait until every session has moved or the grace passes, and close the rest
  with 4004. A connect with `resume`: consume the token (GETDEL); unknown → close 4007 right after
  the upgrade; otherwise take over the session (same id, same binding, `instance` = this process),
  send `session_welcome` with the same session id, and the old instance stops delivering to it as
  soon as it sees `instance` changed (check the hash before each send batch, or have the new
  instance publish `subscriptions_changed` for the session). Subscriptions stay: they are rows
  keyed by the session id.
- **Session end** (client closes, 4001/4003/4008, process stop without drain): delete the session
  hash and ZSET member and the session's subscription rows (unless the session was resumed
  elsewhere). **Sweep**: every 5 minutes, under `KEYS.eventsubSweepLock` (`SET NX PX`), delete
  WebSocket subscription rows whose session key no longer exists and that are older than the
  grace (a crashed instance leaves them behind).
- **Logging and metrics**: session counts, sends, closes by code; never a token, resume token or
  payload.

## Tests you must add

- Unit (`services/api/tests/e9-ws.test.ts`): keepalive parsing and bounds, close-code mapping,
  message builders validate as `WsMessage`, the in-memory index (add/remove/reload), backpressure
  policy, the reconnect URL (wss/ws from the public URL).
- Integration (`services/api/tests/e9-ws.int.test.ts`; start a real Bun server with the eventsub
  `websocket` handler on port 0 inside the test, real Postgres and Valkey, insert subscription rows
  directly the way E9-subs will): welcome; keepalive after the (lowered, e.g. 1 s via a test-only
  option) period; 4003 for an unused session; 4001 on client traffic; `bind` outcomes including
  the per-grant limit and a stale ZSET member; a `BusEvent` published on `BUS.events` arrives as a
  `notification` with the deterministic message id, a non-matching condition does not; an
  authorization that no longer holds yields `revocation` and the row is gone; `userControl`
  disconnect by token hash, by `{ userId, appId }`, by `{ appId }` alone closes exactly the right
  sessions with 4008, while a `token_rotated` disconnect for the bound token closes nothing; `bind`
  with a second token of the same grant → `ok` (and a third grant's token → `other_grant`); two processes (two `startEventSub` instances on two servers sharing Valkey):
  `drain()` on the first → `session_reconnect`, the client reconnects to the second with the URL,
  gets the same session id, and the next event arrives once, on the new socket; unknown resume →
  4007; sweep deletes orphaned rows.
- Harness: pure helpers of step 5 if any.

## Harness step 5 (`harness/src/e9/websocket.ts`, flip `ready: true`)

Scenario step 5 of `docs/testing/e9-selectors.md` with `harness/src/e9/ws-client.ts` against
`${HARNESS_API_URL.replace(/^http/, "ws")}${EVENTSUB_WS_PATH}`, subscribing through
`developer.events.subscribe` with the grant's access token (E9-subs). Besides chat and follow,
subscribe `channel.poll.begin` and `channel.points.change` and trigger them with
`interact.polls.create` and `bot.points.adjust` as the streamer (E8-polls and E8-points merged in
wave 1): this is E8's EventSub delivery check (e8/contract-step.md §0). For the chat side, the
viewer sends with the existing harness chat client; for the "chat socket closes too" check, open
a chat connection with the grant's token (`harness/src/chat-client.ts` with `bearer`) and expect it
to close after `developer.grants.revoke`. Leave one bound socket open in `E9Run.state` only if
step 8 needs it (it opens its own; prefer that).

## Done means

Follow `.claude/briefs/_done-means.md` (targeted checks only): `bun --bun vp test run` and `bun
run test:int` in `services/api`; `harness` unit tests; `bunx tsc -p services/api --noEmit` and
`harness`; `vp lint --deny-warnings` and `vp fmt` on your paths. Never run `bun run verify`, a
harness scenario, `podman compose` or `scripts/infra.ts`. `git status` shows only your paths.
Commit in your worktree (`git commit -s`, Conventional Commits, ending with `Co-Authored-By: Claude
Opus 5.5 <noreply@anthropic.com>`). Final message: what you built, test counts, branch and sha,
contract requests (exact diffs), the protocol facts for `docs/developers/eventsub.md` (connect
URL, keepalive, close codes, reconnect, limits, WebSocket-only types), and the live command after
the wave: `bun harness/src/cli.ts run developer-platform --set steps=1-2,5 --set via=api`.
