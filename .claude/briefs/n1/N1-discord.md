<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N1-discord: the optional Discord webhook adapter for go-live posts

You are implementing unit N1-discord for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md (rule 3: proprietary services are optional adapters), PLAN.md and docs/architecture.md
first, then `.claude/briefs/next/N1-notifications-pwa.md`, `docs/decisions/0028-notifications.md`
(decision 5), `.claude/briefs/n1/contract-step.md` (§0, §1.3 `DISCORD_WEBHOOK_URL` and
`NOTIFY_RULES.discordFailureLimit`, §1.4 `DiscordWebhookStatus`, §1.5 `notifications.discord`,
§1.6 `DiscordJob`, §2.3 `discord_webhooks`, §5.2a the API producer, §6.1, §6.5 `postPinned`, §7.2 the dashboard mount,
§7.3, §8 Discord ids, §12), `docs/testing/n1-selectors.md`, `apps/web/src/i18n/README.md` and
`.claude/briefs/_done-means.md`. Do not look outside the repository. Work in your own git worktree
on a branch named `n1/discord`, created from `main` after batch-4 wave 2 (W1-data-mode and the five other N1 units) merged
(the orchestrator gives you the sha); run `git merge main` first if main moved. Wave 3, alone: ADR 0028 builds the
proprietary adapter last, after the FOSS path (in-app, email) and push are green.

## Why

Streamers announce go-live in their Discord. ADR 0028 allows exactly one thing: a Discord channel
webhook the streamer pastes in the studio. No bot, no Discord application, no OAuth, no instance
credentials, nothing in `.env.example`; the instance runs the same without it. The URL is a
secret (anyone holding it can post there), so it is encrypted at rest, never returned, and every
send goes through the SSRF guard with mentions disabled.

## You own (write only these)

- `services/worker/src/jobs/notify-discord.ts` (stub) and `services/worker/src/notify/discord/**` (new)
- `services/api/src/routes/notifications/discord.ts` (stub: `get`, `set`, `remove`, `test`) and
  `services/api/src/notifications/discord/**` (new)
- `apps/web/src/components/discord-webhook-section.tsx` (stub mounted on `/dashboard` by the
  contract step) and `apps/web/src/components/discord-webhook/**` (new)
- i18n: `apps/web/src/i18n/locales/en/n1-discord.json` (keys `discord.*`) and `keys/n1-discord.gen.ts`
- Tests: `services/worker/tests/notify-discord*.test.ts`, `services/api/tests/discord-webhook*.test.ts`,
  `apps/web/tests/discord-webhook*.test.tsx`
- Docs: `docs/streamers/discord.md` (new: how to make a Discord webhook and paste it; what is
  posted; that nobody gets pinged; that a deleted webhook removes itself; the FOSS alternative,
  an EventSub `stream.online` subscription to Matrix or a self-hosted bot, now that E9 shipped)

Read-only, in particular: `packages/contracts/**`, `packages/db/**`, `packages/tokens/**`
(`encryptSecret`, `decryptSecret`), `services/worker/src/webhooks/**` (`postPinned`,
`resolveCallback`, `nextRetryDelay`), `services/worker/src/notify/{settings,outbox-jobs}.ts`,
`services/worker/src/jobs/notify-go-live.ts` (N1-fanout enqueues your job),
`services/api/src/routes/notifications.ts`, `services/api/src/lib/**`,
`apps/web/src/routes/_studio/dashboard.tsx`, `apps/web/src/components/simulcast-section.tsx` (the
pattern for a dashboard section with a secret). Anything else is a **contract request** with the
exact diff.

## Contracts you must honor (read-only for you)

- `discord_webhooks (channel_id pk, url, set_by, set_at, last_posted_at, failures, last_error, updated_at)`;
  `url = encryptSecret(AUTH_SECRET, "discord-webhook", url)`; the plaintext URL never leaves the
  API's `set` handler and the worker's send, never in a response, log, audit row or export.
- API (`owner` access): `get` → `DiscordWebhookStatus`; `set({ url })` (`write` bucket; the router
  already applies `DISCORD_WEBHOOK_URL`) → status, resets `failures` and `last_error`; `remove` →
  `Ok`; `test` (`expensive` bucket) → enqueues `DiscordJob { channelId, eventId: null,
  broadcastId: null, test: true }` (id `discord-test-${channelId}-${minute}`) through the
  contract step's producer `notifyQueue(deps).enqueueDiscordTest(channelId, minute)`
  (`services/api/src/notifications/queue.ts`, read-only for you; tests install a fake with
  `setNotifyQueue`) and returns the current status (the result shows on the next `get`). `set`, `remove` and `test` write an
  `audit_log` row (a channel setting change by its owner or editor; `details` = `{ action }` only,
  never the URL).
- Job: `DiscordJob` on `QUEUES.notifications`, `attempts: 5`, `backoffMs: 60_000`; go-live jobs
  arrive with id `discord-${eventId}` from N1-fanout's first page.
- Cooldown: a go-live post only if `last_posted_at` is null or older than
  `notifications.goLive.cooldownHours` (`goLiveSetting`), decided by one conditional
  `update … set last_posted_at = now where channel_id = $1 and (last_posted_at is null or
  last_posted_at <= now - interval) returning`; tests skip it.
- Selectors: `discord-webhook-section`, `discord-webhook-status` (`data-configured`,
  `data-error`), `discord-webhook-input`, `discord-webhook-save`, `discord-webhook-test`,
  `discord-webhook-remove`, `discord-webhook-remove-confirm`.

## What is there today (verified at `a43aa6b`; recheck against your base)

- Discord exists only as a sign-in provider (`services/api/src/auth/index.ts:73`); nothing posts.
- `resolveCallback` requires https and public addresses and pins the address
  (`services/worker/src/webhooks/ssrf.ts:162-200`); after the contract step `postPinned` returns
  response headers (for `retry-after`).
- Simulcast stream keys are the model of a write-only secret in the studio
  (`services/api/src/routes/stream.ts:252`, `apps/web/src/components/simulcast-section.tsx`).

## Build

1. **Send** (`notify/discord/post.ts`): decrypt; re-check the URL against `DISCORD_WEBHOOK_URL`
   (defence in depth); `postPinned(url + "?wait=false", { body: JSON.stringify(message), contentType:
   "application/json", userAgent: "CommonAir-Notify/1", headers: {} }, { ...transport,
   timeoutMs: 10_000, maxResponseBytes: 4096 })`, where `transport: Pick<PostOptions, "allowInsecure" | "resolve" | "ca">`
   is a parameter of your job runner (`runDiscordJob(data, ctx, transport)`); the registered
   handler always passes `{ allowInsecure: false, resolve: ctx.webhooks.resolve }`. Only tests
   pass anything else: the SSRF guard refuses loopback unless `allowInsecure` is true
   (`resolveCallback`, `ssrf.ts:189-195`), so a local receiver needs it; the host can still only
   be Discord's, because the URL regex is checked first. Message: `content` = "{channel} is live: {title}
   {channelUrl}" built from the channel's display name, the broadcast title (Discord is a public
   place, so a mature broadcast, `broadcasts.mature OR channels.mature` (contract step §0), posts
   "{channel} is live (18+) {channelUrl}" without the title) and `PUBLIC_URL/<slug>`; `allowed_mentions: { parse: [] }`
   (a title can never ping `@everyone` or a role); no embeds with remote images; no username or
   avatar override. These strings are channel content posted to a third party, built in English
   from a small server-side table (`notify/discord/text.ts`), like the chat service's notices: not
   the web catalog. Test messages: "Test from {instance}: go-live posts for {channel} will appear here."
2. **Outcomes**: 2xx → keep the claim (`last_posted_at`), `failures = 0`,
   `last_error = null`; 429 → retry after `retry_after` (JSON body, seconds) or `retry-after`
   header: throw so BullMQ retries, and if the wait exceeds the backoff, re-enqueue the job with
   that delay and the same id suffix `-retry-<n>` instead (cap at 3 re-enqueues); 401/404 →
   `failures + 1`, `last_error` `unauthorized|not_found`, no retry; at
   `NOTIFY_RULES.discordFailureLimit` delete the row, insert an in-app `system` notification
   for the channel owner (`payload: { kind: "discord_webhook_removed", channelId }`; N1-inbox
   links it to `/dashboard`) and an audit row (`actor_type 'system'`, `details: { action }`), all
   in one transaction; other 4xx → `rejected`, no retry; 5xx or network → `network`, retry; SSRF rejection →
   `rejected`, delete the row (it can never work).
3. **Job** (`jobs/notify-discord.ts`): no row → zeros. Go-live: claim with the cooldown update
   first, returning the previous `last_posted_at` (nothing returned → zeros: a post already went
   out within the window, including this event's own earlier successful attempt, so a retry
   never double-posts); post; on a retryable failure put the previous `last_posted_at` back and
   throw, so the retry claims again. Test: post without claiming.
4. **API** (`routes/notifications/discord.ts`, `notifications/discord/**`): as the contract above;
   `set` upserts (`on conflict (channel_id) do update`), stores `set_by` = caller.
5. **Studio section** (`discord-webhook-section.tsx`, mounted after the simulcast section): status
   line (configured or not, last post as `RelativeTime`, last error as text), a password-type
   input that is never pre-filled, save (validates the URL shape client-side with
   `DISCORD_WEBHOOK_URL` for a quick message; the server is authoritative), test, remove (a
   `ConfirmDialog`), a short explainer that this is optional, Discord's terms apply, and the FOSS
   alternative (link to the docs page). Strings in `n1-discord.json` only; logical CSS; 320 px.

## Tests you must add

- Unit: message building (mentions disabled, mature text, long titles cut at Discord's 2000
  characters, `@everyone` in a title stays text), outcome mapping per status, retry-after parsing.
- Worker integration: a local HTTPS receiver with a test CA, driven through
  `runDiscordJob(data, ctx, { allowInsecure: true, resolve: <discord.com → 127.0.0.1>, ca })`
  (no env var; the registered handler never passes these, and a test asserts it passes
  `allowInsecure: false`): a go-live posts once; a second within the window
  does not; a retried job after success does not double-post; 429 with `retry_after` retries;
  404 ×3 → row gone, owner notified, audit row; a test post ignores the cooldown; an SSRF
  rejection deletes the row.
- API: non-owner refused; a non-Discord URL refused by the contract; the response never contains
  the URL (assert on the serialized body); audit rows without the URL; `test` enqueues one job
  per minute.
- Web: the section's states (not configured, configured, error), the remove confirmation.

## Done means

`.claude/briefs/_done-means.md`, plus: `services/worker` and `services/api` tests (unit and
`test:int`, one package at a time), `apps/web` tests including `i18n.test.ts` and
`logical-css.test.ts`, `bun run i18n:check`, `vp build`; `tsc`; lint and format on your paths;
nothing added to `.env.example` or any config schema. Final message: what you built, test counts,
branch and sha, contract requests, and the live check for the user: paste a real Discord webhook
on a staging channel, press Test, go live, and see one post with no ping; delete the webhook in
Discord and see the studio report it removed after three go-lives.
