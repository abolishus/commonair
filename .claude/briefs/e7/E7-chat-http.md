<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E7-chat-http: chat over REST and the held-message queue

You are implementing unit E7-chat-http for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md, PLAN.md and docs/architecture.md first, then `.claude/briefs/next/E7-platform-debts.md`,
`.claude/briefs/e7/contract-step.md` (all of it, especially §9 "Shared-file rules"),
`docs/testing/e7-selectors.md`, `docs/testing/e1-selectors.md` and `docs/testing/e2-selectors.md`.
Do not look outside the repository. Work in your own git worktree on a branch named
`e7/chat-http`, created from the E7 contract-step commit the orchestrator gives you (run
`git merge main` first if main moved).

## Why

Five chat procedures still answer 501: `chat.send`, `chat.deleteMessage` and `chat.clear` (the
REST alternative to the WebSocket that bots and integrations expect) and `chat.held.list` /
`chat.held.resolve`. Word filters with action `hold` already hold messages and show them to
moderators over the socket, but nobody can release them: a held message is lost. Mod Circles (W1)
builds on a working held queue.

## You own (write only these)

- `services/api/src/routes/chat.ts` (this wave: the five stubbed handlers at :224-226 and
  :514-517, plus helpers in this file). Do not change other handlers' behaviour.
- `services/api/src/chat/**` (new: the chat relay client and held-message helpers)
- `services/api/tests/chat-http.test.ts`, `services/api/tests/chat-http.int.test.ts` (new)
- `apps/web/src/chat/**` (surface held frames to moderators; mount the queue)
- `apps/web/src/components/mod/**` (new: `held-queue.tsx` and friends)
- `apps/web/src/i18n/e7-chat.ts` (your catalog; keys prefixed `held.`)
- `apps/web/tests/e7-chat*.test.ts(x)` (new)
- `harness/scenarios/e2e-social.ts`, `harness/src/social.ts`, `harness/src/chat-client.ts` (only
  if needed), `harness/tests/social.test.ts`

Everything else is read-only, in particular `services/chat/**`, `packages/contracts/**`,
`services/api/src/moderation/**` (including the new `chat-bans.ts`), `apps/web/src/i18n/en.ts`,
`apps/web/src/routeTree.gen.ts`, and `harness/src/e7/selectors.ts`. A change you need there is a
**contract request** in your final message, with the exact diff.

## Contracts you must honor (read-only for you)

- `packages/contracts/src/api/router.ts:789-818`: `chat.send` (`user`, scope `chat:edit`, rate
  limit `chat`; input `ChannelRef + { body (1–500), replyToId? }`; output `{ id, held, dropReason }`),
  `chat.deleteMessage` and `chat.clear` (`mod`, scope `moderator:manage:chat`, output `Ok`).
  `:911-930`: `chat.held.list` (`mod`, output `ChatMessage[]`) and `chat.held.resolve` (`mod`,
  input `ChannelRef + { id, allow }`, output `Ok`).
- `packages/contracts/src/chat.ts`: `ServerFrame` (`message` with `held`, `delete`, `clear`,
  `notice`, `ack`, `error`), `ChatFanout` (:170-178, `audience: "all" | "moderators"`),
  `ChatControlMessage` (:163-166), `CHAT_LIMITS`, `NOTICE_CODES`, and (contract step) the lifted
  `fragmentsOf` / `chatMessageEventPayload`.
- `packages/contracts/src/events.ts`: `BUS.chat(channelId)`, `BUS.chatControl(channelId)`,
  `BUS.events`, `channel.chat.message`, `channel.chat.message_delete`, `channel.chat.clear` (check
  the exact names in `EVENTS`).
- `@commonair/tokens` `signChatToken` (used by `chat.connectToken`, chat.ts:587-…, signed with
  `INTERNAL_API_SECRET`); env
  `CHAT_INTERNAL_URL` (`packages/config/src/env.ts:108`, the chat service's internal WebSocket).
- `docs/testing/e7-selectors.md` "Held messages" and the `e2e-social` scenario section.

## What is there today (verified at `9c51c93`)

- `chat.ts:224-226` and `:514-517` are `.handler(notImplemented)`. The file header (:4-8) says REST
  endpoints "write the same tables and broadcast on BUS.chatControl".
- The chat service owns every send rule: `services/chat/src/core.ts:70-158` (`send`: auth,
  channel modes, bans, slow mode, rate limits, word filters via the worker pool, emotes, replies),
  persists through a batching writer (`heldAt` set when held, :143), fans held messages out to
  moderators only (:146-153) and accepted ones to all plus `channel.chat.message` on `BUS.events`
  (:154-155, `services/chat/src/events.ts:50-79`). Deletion and clear are moderation commands
  (`services/chat/src/moderation.ts:74-75`, `:254-298`), which publish `delete`/`clear` frames.
- The chat service authenticates WebSocket upgrades with a chat token (`services/chat/src/auth.ts:66`,
  `verifyChatToken`) or an OAuth bearer token; the IRC gateway already acts as a chat client over
  `CHAT_INTERNAL_URL` (`services/irc/src/upstream.ts:47-…`). A chat token for the caller is what
  `chat.connectToken` mints (chat.ts:587-…). The API already reads `CHAT_INTERNAL_URL` (its health
  probe, `services/api/src/index.ts:51`), so no env change is needed.
- Held state: `chat_messages.held_at` (`packages/db/src/schema/chat.ts:29`), `deleted_at`/`deleted_by`
  (:30-31). Held messages are sent to moderators as `{ op: "message", held: true }`;
  `services/chat/src/core.ts:310-319` delivers `ChatFanout` frames from `BUS.chat` to sockets by
  audience.
- Web: `apps/web/src/chat/connection.ts:160` drops every held frame (`!f.held`);
  `chat-panel.tsx:42,63` knows `canModerate`; `apps/web/src/chat/messages.ts:21` maps `msg_held`.

## Build

1. **`chat.send` over REST without duplicating rules.** Implement a small relay in
   `services/api/src/chat/relay.ts`: mint a chat token for the caller (same scopes as
   `connectToken`; a token caller keeps its `appId` so bot limits apply), open a WebSocket to
   `CHAT_INTERNAL_URL`, `join` the channel, send one `send` frame with a nonce, and resolve on the
   matching `ack` (→ `{ id, held, dropReason: null }`), a rejecting `notice` or an `error` (the
   contract's output needs an `id`, so a refused message is an `ORPCError`: `BAD_REQUEST` or
   `FORBIDDEN` by notice code, `TOO_MANY_REQUESTS` for rate limits, with the notice code in the
   message and no body), with a hard timeout (5 s → `SERVICE_UNAVAILABLE`). Close the
   socket every time (try/finally). Map rate-limit notices to `TOO_MANY_REQUESTS`. `dropReason` is
   for messages the service accepted but dropped silently (if any path does that; otherwise always
   `null` and say so in a comment). Never log the body or the token. Keep a tiny pool per caller only if a test shows the per-call socket is too
   slow (it is not expected to be).
2. **`chat.deleteMessage` and `chat.clear`.** Relay the equivalent moderation commands through the
   same client (`/delete <id>`, `/clear`, as `services/chat/src/commands.ts:104-107` parses them),
   so audit rows, `mod_actions`, events and the `delete`/`clear` frames come from the one place
   that already does them. A message that does not exist or is not in that channel → `NOT_FOUND`.
   If a command path proves unusable from a relay (it needs a change in `services/chat`), stop and
   send a contract request rather than re-implementing the rule in the API.
3. **`chat.held.list`.** Messages of the channel with `held_at is not null and deleted_at is null`,
   oldest first, at most 100, shaped like `chat.history` rows (reuse its DTO code in chat.ts:
   badges, reply) .
4. **`chat.held.resolve`.** In one transaction, `select … for update` the held row of that channel
   (else `NOT_FOUND`; already resolved → `CONFLICT`). `allow`: clear `held_at`; `deny`: set
   `deleted_at`/`deleted_by`. Write `mod_actions` (`allow` has no `MOD_ACTIONS` value: record only
   `deny` as `delete_message` with `subjectType: "chat_message"`) and an audit row
   `chat.held.allow` / `chat.held.deny` (ids only, never the body). After commit: on allow, publish a
   `ChatFanout` `{ v: 1, audience: "all", sentAt: Date.now(), frame: { op: "message", channel, message } }`
   (parse it with `ChatFanout` before publishing) once on
   `BUS.chat(channelId)` and a `channel.chat.message` `BusEvent` on `BUS.events` built with
   `chatMessageEventPayload` (contract step) so bots and EventSub see it exactly as if sent live; on
   deny, publish a `delete` frame to moderators (`ChatFanout` audience `moderators`) so their queues
   drop it. Publish failures are logged (ids only) and do not fail the call (the row is the truth).
   A held message older than chat's history window still releases (it shows to late joiners).
   The chat service persists through a batching writer (`services/chat/src/persistence.ts:61`,
   every 250 ms): a held row can appear a moment after the `ack`. `resolve` on an id that is not
   in the table yet is `NOT_FOUND` (the client retries); the web queue merges the live held frame
   and the list by id; tests and the harness poll `held.list` instead of reading it once.
5. **Web held queue.** `connection.ts` passes held frames to a new `onHeld` callback for moderators
   instead of dropping them; `apps/web/src/components/mod/held-queue.tsx` (mounted from the chat
   panel header for `canModerate` users) loads `chat.held.list` when opened, merges live held
   frames, and offers allow/deny (`IconButton tooltip`, optimistic removal, toast on failure, row
   back on error). Selectors exactly as `e7-selectors.md` "Held messages". `<EmptyState>` when
   empty, `<Skeleton*>` while loading, keyboard reachable, 320 px wide.
6. **Harness `e2e-social`.** Add the held-message steps from `e7-selectors.md` "Scenarios" after
   the existing moderation steps: the streamer adds a `hold` filter (`chat.filters.create`), the
   troll sends a matching message with REST `chat.send` (→ `held: true`), the fan does not see it
   within the settle window, the streamer allows it (web: `held-queue-open` → `held-allow`;
   `--set via=api`: `chat.held.resolve`), the fan then sees `chat-message` with that `data-id`. In
   `via=api` also exercise REST `chat.deleteMessage` (the fan's socket sees the delete) and
   `chat.clear`. Remove the filter at the end.

## Tests you must add

- Unit (`chat-http.test.ts`): ack/notice/error/timeout mapping of the relay with a fake socket;
  the held DTO; the allow fan-out envelope and event payload (equal to `chatMessageEventPayload`).
- Integration (`chat-http.int.test.ts`, `createTestDatabase()`, a real chat service started in
  the test as `services/chat` tests do, or the running one at `CHAT_INTERNAL_URL`): send ok, send
  while banned → 403-class error, slow mode → 429, a `hold` filter → `held: true` and a held row;
  held list for a mod, forbidden for a viewer; allow → row released, fan-out seen on `BUS.chat`,
  `channel.chat.message` on `BUS.events`; deny → deleted, mod-only delete frame; resolve twice →
  409; another channel's message id → 404; delete/clear over REST produce the same audit rows and
  frames as the socket commands.
- Web: held queue render (empty, rows, allow/deny optimistic + rollback), selector ids present.
- Harness: `social.test.ts` for any pure helper you add.

## Done means

Follow `.claude/briefs/_done-means.md`, except that the orchestrator runs the gate this batch:
run only targeted checks (`bun --bun vp test run` and `test:int` in `services/api`, `apps/web`
tests, `harness` tests; `bunx tsc -p` for each; `vp lint --deny-warnings` and `vp fmt` on your
paths; `vp build` in `apps/web` and then confirm `git diff apps/web/src/routeTree.gen.ts` is
empty). Never run `bun run verify`, `podman`, `scripts/infra.ts` or a harness scenario; give the
user the exact `bun harness/src/cli.ts run e2e-social` commands (web and `--set via=api`).
`git status` shows only your paths. Commit in your worktree (`git commit -s`, Conventional
Commits, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Final message:
what you built, test counts per package, branch and sha, contract requests (exact diffs), the
`services/api/README.md` text you propose for chat REST and the held queue, and anything left.

## Contract step as landed (`66e95da`)

Your base is `66e95da` (`feat(e7): contract step` + review fixes), not `9c51c93`; recheck line numbers against it.

- DMCA suspensions go through `setSuspension(…, "dmca_repeat_infringer")` (`services/api/src/moderation/suspension.ts`) and are lifted only through `liftDmcaSuspensionInTx` or `reconcileDmcaTerminationInTx` (`packages/db/src/account-actions.ts`), which takes the account-actions lock itself.
- Build the released message payload with `chatMessageEventPayload` from `@commonair/contracts/chat`. `isActiveBan` now lives in `services/api/src/moderation/chat-bans.ts`.
