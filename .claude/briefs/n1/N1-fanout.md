<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N1-fanout: the go-live fan-out (in-app rows, cooldown, email queue, push and Discord jobs)

You are implementing unit N1-fanout for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md, PLAN.md and docs/architecture.md first, then `.claude/briefs/next/N1-notifications-pwa.md`,
`docs/decisions/0028-notifications.md` (decisions 3, 4, 8 and Amendment 1),
`.claude/briefs/n1/contract-step.md` (§0, §1.3, §1.6, §2, §6.1-6.3, §8 scenario steps 1 and 3,
§12) and `.claude/briefs/_done-means.md`. Do not look outside the repository. Work in your own git
worktree on a branch named `n1/fanout`, created from `main` after batch-4 wave 1 (the six W1 units) merged; the orchestrator gives you the sha, which contains the W1 and N1 contract steps; run `git merge main` first if main moved. Batch 4, wave 2, beside N1-email, N1-push,
N1-inbox, N1-pwa and W1-data-mode. You write no web strings.

## Why

When a followed channel goes live, nothing happens: `stream.online` reaches the bus and webhook
subscribers, but no `go_live` notification is ever written. The contract step makes the outbox
relay enqueue `NOTIFY_JOBS.goLive` for every `stream.online`; you build the job that turns one
go-live into in-app rows, queued emails, push jobs and a Discord job, under one cooldown that
several worker replicas cannot both pass.

## You own (write only these)

- `services/worker/src/jobs/notify-go-live.ts` and `services/worker/src/jobs/notify-prune.ts`
  (stubs from the contract step)
- `services/worker/src/notify/fanout/**` and `services/worker/src/notify/prune/**` (new)
- Tests: `services/worker/tests/notify-go-live*.test.ts`, `services/worker/tests/notify-fanout*.test.ts`,
  `services/worker/tests/notify-prune*.test.ts`
- Harness: `harness/src/n1/inapp.ts` (step 1) and `harness/src/n1/cooldown.ts` (step 3),
  `harness/tests/n1/inapp.test.ts`, `harness/tests/n1/cooldown.test.ts`

Read-only, in particular: `packages/contracts/**` (`NOTIFY_JOBS`, `GoLiveJob`, `PushJob`,
`DiscordJob`, `NotifyPruneJob`, `NOTIFY_RULES`, `NOTIFY_DEFAULTS`, `GoLiveNotificationPayload`, `GoLiveSetting`),
`packages/db/**` (`schema/notify.ts`, `follows`, `notifications`, `broadcasts`, `anchoredUser`),
`services/worker/src/notify/{outbox-jobs,settings}.ts`, `services/worker/src/outbox.ts`,
`services/worker/src/context.ts`, the other `jobs/notify-*.ts` stubs, `harness/src/n1/{run,selectors,push-receiver}.ts`,
`harness/scenarios/notifications.ts`, `harness/src/e8/kit.ts` (`newE8Streamer`). Anything else is
a **contract request** with the exact diff.

## Contracts you must honor (read-only for you)

- Input: `GoLiveJob` `{ eventId, after }` on `QUEUES.notifications`, first page enqueued by the
  relay with job id `go-live-${eventId}`. Load the `events` row by id (`type = 'stream.online'`;
  payload `{ broadcaster_user_id, …, id: broadcastId, started_at }`); a missing row or another
  type logs and returns zeros (never throws: nothing would fix it on retry).
- Settings: `goLiveSetting(db, logger)` (`notify/settings.ts`) → `{ cooldownHours, emailDigestMinutes }`;
  `ctx.webPush` is undefined when push is off.
- Tables (`schema/notify.ts`): `notification_go_live_sends` (cooldown), `notification_email_queue`,
  `notification_preferences` (type × channel × medium, `nulls not distinct`), `push_subscriptions`
  (existence only), `discord_webhooks` (existence only); `notifications.dedupe_key` with
  `notifications_dedupe_uq`; `follows_channel_notify_idx`.
- Output: `notifications` rows `type = 'go_live'`, `payload` = `GoLiveNotificationPayload`,
  `dedupe_key = 'go-live-' || eventId`; `notification_email_queue` rows
  `(user_id, event_id, channel_id, broadcast_id)`; `PushJob` jobs (id `push-${eventId}-${userId}`);
  one `DiscordJob` (id `discord-${eventId}`, `test: false`) on the first page when the channel has
  a `discord_webhooks` row; the next page as `GoLiveJob` with id `go-live-${eventId}-${after}`.
- Retention (decided 2026-10-30): `NOTIFY_JOBS.prune` (`notify-prune`) on `QUEUES.retention`,
  every `NOTIFY_RULES.pruneEveryMs`, ops-tickable; `NOTIFY_RULES.retentionDays` (90),
  `readGoLiveRetentionDays` (30), `pruneBatchSize` (5,000); index `notifications_created_idx`.
- Blocks (W1's `user_blocks`) do **not** affect go-live notifications in either direction (decided
  2026-10-30): do not read `user_blocks`.

## What is there today (verified at `a43aa6b`; recheck against your base)

- `stream.online` is written in the broadcast-start transaction (`services/api/src/media/hooks.ts:120-126`);
  the broadcast row holds `title` and `mature` (`packages/db/src/schema/media.ts:45-47`).
- `follows` has `notify` (the per-channel bell, default true) and `excludedAt` (integrity)
  (`packages/db/src/schema/channels.ts:135-152`). Other writers of `notifications`:
  `services/api/src/moderation/notify.ts:23`, `services/worker/src/moderation/records.ts:139` (shape reference).
- `users.emailVerified`, `accountType`, `locale`, `deletedAt`, `pseudonymizedAt` (`schema/auth.ts:31-56`), `users.matureConfirmedAt`
  (`bot` accounts never get notifications), demo identities: `anchoredUser()` (`packages/db/src/demo/anchors.ts:21`).
- Worker job pattern: `services/worker/src/jobs/points-accrue.ts` and `services/worker/src/interact/points/accrue.ts`.

## Build

1. **Pages.** One job handles one page: the channel's followers with `notify = true`, ordered by
   `follower_id`, `follower_id > after`, limit `NOTIFY_RULES.fanoutPageSize`, joined to `users`
   (skip `account_type = 'bot'`, the channel owner, and users with `deleted_at` or `pseudonymized_at` set). One transaction per page. If the page is full, enqueue the next page (id
   `go-live-${eventId}-${lastFollowerId}`) after commit; the enqueue is idempotent by id.
2. **Media per follower** (pure function in `notify/fanout/media.ts`, exhaustively unit-tested):
   for each of `in_app`, `email`, `push`: the channel override row, else the member's default
   row (`channel_id is null`), else `NOTIFY_DEFAULTS.go_live`. Then: `excludedAt` set → email
   and push off (in-app stays); email also needs `emailVerified` and not a demo identity; push
   also needs `ctx.webPush` and at least one `push_subscriptions` row. No medium left → the
   follower is skipped and does **not** consume the cooldown.
3. **Cooldown** (one statement per page, `notify/fanout/cooldown.ts`): insert
   `(user_id, channel_id, last_sent_at = now, event_id)` for the candidates `on conflict
   (user_id, channel_id) do update set last_sent_at = excluded.last_sent_at, event_id =
   excluded.event_id where notification_go_live_sends.last_sent_at <= excluded.last_sent_at -
   make_interval(hours => $cooldownHours) or notification_go_live_sends.event_id =
   excluded.event_id returning user_id`. Only returned users get anything. The `event_id`
   clause lets a retried job for the same event pass again; everything downstream is idempotent
   by event and user. Count the rest as `cooledDown`.
4. **Writes for winners** in the same transaction: `notifications` (`on conflict do nothing` on
   the dedupe index; payload `{ channelId, slug, broadcastId, title }` where `title` is `""` when
   `broadcasts.mature OR channels.mature` (the one mature rule every N1 unit uses, contract step
   §0) and the follower has no `matureConfirmedAt`);
   `notification_email_queue` (`on conflict do nothing`). After commit, enqueue the push jobs in
   one `enqueueBulk`.
5. **Discord**: on the first page only (`after = null`), if `discord_webhooks` has the channel,
   enqueue the `DiscordJob` (N1-discord applies its own per-channel cooldown).
6. **Logs and metrics**: structured, ids and counts only (never emails, endpoints, titles).
   OTel counters in your own `notify/fanout/metrics.ts` with `meter("commonair.worker")` from
   `@commonair/observability` (the pattern of `services/worker/src/metrics.ts`, which you do not
   edit): `worker.notify.go_live_rows` (attribute `medium`) and `worker.notify.go_live_cooled_down`.
7. **Performance**: a channel with 100,000 followers is 200 jobs; each page is one query for
   followers + preferences (a lateral or `array_agg` join, not one query per follower), one
   cooldown upsert, two inserts. Check the plan uses `follows_channel_notify_idx` and
   `notification_prefs_uq` (include the `EXPLAIN` in your final message).

8. **Retention job** (`jobs/notify-prune.ts` + `notify/prune/**`): delete `notifications` rows
   with `created_at` older than `retentionDays`, and `type = 'go_live'` rows with `read_at` set and
   `created_at` older than `readGoLiveRetentionDays`, every type, every user. Batched: `DELETE …
   WHERE id IN (SELECT id … ORDER BY created_at LIMIT pruneBatchSize)`, each batch its own
   statement (no long transaction, no table lock), looping until a batch is short; under a run
   lock (`withRunLock`) so two replicas do not race. Return `{ deleted, readGoLive }`; log counts
   only. Check the plan uses `notifications_created_idx` (include the `EXPLAIN`). Notifications
   are not append-only and carry no audit duty, so no audit or outbox row.

## Tests you must add

- Unit: media resolution (every combination of override/default/built-in × excluded × verified ×
  push available × subscriptions; the mature title rule); page planning (full page → next job id;
  short page → none); job id formats.
- Integration (`createTestDatabase()`, real Valkey, the worker's test context):
  a follower with defaults gets one in-app row and no email or push; email on + verified → one
  queue row; email on + unverified → none; excluded follow → in-app only; bell off → nothing;
  a second event for the same channel inside the window → nothing, outside (clock moved) → sent;
  the **same** event processed twice → still one row per member (dedupe), one queue row, push
  jobs with the same ids; two concurrent jobs for two events of one channel (two connections)
  → each member passes once; 1,203 followers → 3 pages, every member once; a demo follower gets
  no email row; a Discord row → one `DiscordJob` on page one only; a missing event → zeros.
- Retention (unit + integration): a row 91 days old is deleted, one 89 days old kept; a read
  `go_live` row 31 days old deleted, an unread one kept, a read row of another type 31 days old
  kept; boundaries at exactly 90 and 30 days; more rows than `pruneBatchSize` all go across
  batches; an empty table returns zeros; the ops tick runs it.
- Harness steps 1 and 3 (`harness/src/n1/inapp.ts`, `cooldown.ts`) per §8 of the contract step,
  with pure helpers unit-tested in `harness/tests/n1/`.

## Done means

`.claude/briefs/_done-means.md`, plus: `services/worker` `bun run test` and `bun run test:int`
green; `bunx tsc -p services/worker --noEmit` and `bunx tsc -p harness --noEmit`; lint and format
on your paths; `git status` shows only your paths. Final message: what you built, test counts,
the `EXPLAIN` of the page query and of the prune batch, contract requests, and the live commands for the user
(`bun harness/src/cli.ts run notifications --set steps=1,3` on the harness stack).
