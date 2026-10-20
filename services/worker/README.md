<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# `@commonair/worker`

Background processing for CommonAir: BullMQ job workers and schedulers, the event
outbox relay, webhook delivery, segment-stream aggregation, live viewer counters and
housekeeping. One process runs everything; run more replicas to scale (every part is
safe to run concurrently).

```sh
bun services/worker/src/main.ts      # health on WORKER_PORT: /healthz, /readyz (postgres, valkey, queues)
bun run --filter @commonair/worker test       # unit
bun run --filter @commonair/worker test:int   # integration (Postgres + Valkey)
```

## Continuous loops (not BullMQ jobs)

| Loop             | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbox relay     | Claims unpublished `events` rows (`FOR UPDATE SKIP LOCKED`, batches of 200, oldest first), validates each against `EVENTS[type]`, publishes a `BusEvent` to `BUS.events`, enqueues `webhooks/fanout` when an enabled webhook subscription of that type exists, sets `published_at`. Polls with adaptive backoff 50 ms → 1 s and no sleep while a backlog remains. Invalid rows are logged and marked published so they cannot block the outbox. At-least-once: consumers dedupe by event id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Segment consumer | Consumer group `worker` on `STREAMS.segments`: `XREADGROUP` batches of 2000, per-minute aggregation into `egress_samples` (bytes and requests by source, for the session's broadcast; session → broadcast is cached) and `playback_sessions.segments_fetched` / `bytes_http` increments, one transaction per batch, then integrity fetch evidence (origin and p2p entries only) is recorded in Valkey, then `XACK`; a batch whose write fails is retried entry by entry. An `XACK` that fails after the write is retried on its own (3 tries) and never re-runs the batch; if it keeps failing the batch stays pending and is reclaimed below, so it is counted twice (as after a crash between commit and ack). A failed evidence write is logged and counted (`worker.segments.evidence{outcome:"failed"}`) without failing the batch. Every 30 s it first trims entries older than an hour (`XTRIM MINID ~`, independent of anything else failing), then reclaims entries pending for over a minute (`XAUTOCLAIM`); entries delivered 5 times without success are acknowledged and logged. Entries with `at` more than a day old or 5 min in the future are dropped. Sessions without a broadcast are re-looked-up after 60 s. |

## Queues and jobs

| Queue       | Job                        | Schedule              | Payload                                | What it does                                                                                                                                                                                             |
| ----------- | -------------------------- | --------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webhooks`  | `fanout`                   | from the outbox       | `{ eventId }`                          | Matches enabled webhook subscriptions (type, version, condition); revokes subscriptions that fail authorization (see Webhooks); enqueues one `deliver` each.                                             |
| `webhooks`  | `deliver`                  | from `fanout`         | `{ subscriptionId, eventId, attempt }` | One signed notification POST, logged in `webhook_deliveries`; schedules the next attempt on failure.                                                                                                     |
| `webhooks`  | `verify-callback`          | enqueued by the API   | `{ subscriptionId }`                   | Sends `webhook_callback_verification`; the receiver must answer 200 with the challenge within 10 s → `enabled`, else `failed`.                                                                           |
| `webhooks`  | `test-event`               | enqueued by the API   | `{ subscriptionId, eventId? }`         | Delivers a sample payload synthesized from the catalog schema (with the subscription's condition values) once.                                                                                           |
| `webhooks`  | `redeliver`                | enqueued by the API   | `{ deliveryId }`                       | Re-sends a logged notification once, with the same message id. Test events have no outbox row and cannot be redelivered.                                                                                 |
| `integrity` | `live-counters`            | every 10 s            | `{}`                                   | Prunes stale (30 s) members of `KEYS.viewers`, counts verified sessions, sets `KEYS.viewerCount` (30 s TTL), updates `peak_verified_viewers` and viewer-seconds.                                         |
| `integrity` | `close-stale-sessions`     | every 60 s            | `{}`                                   | Ends playback sessions with no heartbeat for 2 min, at their last heartbeat.                                                                                                                             |
| `integrity` | `relays-offline`           | every 60 s            | `{}`                                   | Active/degraded relays with no health check for 3 min → `offline`, `audit_log` row, removed from `KEYS.relays`.                                                                                          |
| `integrity` | `score-sessions`           | every 15 s            | `{}`                                   | Scores active playback sessions (verified / pending / excluded), least recently scored first, at most 2000 per run; republishes viewer counts of channels whose sessions changed verdict. See Integrity. |
| `integrity` | `verify-receipts`          | every 60 s            | `{}`                                   | Checks up to 1000 relay receipts per run against issuance; suspends over-reporting relays and removes them from `KEYS.relays` at once.                                                                   |
| `integrity` | `follow-bursts`            | every 60 s            | `{}`                                   | Excludes low-quality follows that arrived in bursts.                                                                                                                                                     |
| `integrity` | `stream-hours`             | every 5 min           | `{}`                                   | Recomputes streaming-hour eligibility from verified viewers.                                                                                                                                             |
| `retention` | `expire-auth-rows`         | hourly (`7 * * * *`)  | `{}`                                   | Deletes expired `verifications` and `sessions`.                                                                                                                                                          |
| `retention` | `prune-webhook-deliveries` | daily (`17 3 * * *`)  | `{}`                                   | Deletes `webhook_deliveries` older than 30 days.                                                                                                                                                         |
| `retention` | `vod-retention`            | hourly (`27 * * * *`) | `{}`                                   | Deletes expired VODs' objects (`deletePrefix` of exactly `vods/<vod id>/` on the media bucket; any other stored prefix is refused and logged), then marks them `deleted`; failures are retried next run. |
| `payments`  | `money-expire-pending`     | every 5 min           | `{}`                                   | Pending payments past `expires_at` → `failed`, with their incomplete subscriptions, unpaid renewals (end event) and tips. See Money jobs.                                                                |
| `payments`  | `money-renew`              | every 5 min           | `{}`                                   | Ends canceled, gift and tierless subscriptions at period end; opens one pending manual renewal (`past_due`). See Money jobs.                                                                             |
| `payments`  | `money-release-holds`      | hourly (`41 * * * *`) | `{}`                                   | Moves creator shares past the `payout.rules` hold to available, draining any backlog within 30 s. See Money jobs.                                                                                        |

Producers in other services import the job names and payload schemas from
`@commonair/worker` (`WEBHOOK_JOBS`, `VerifyCallbackJob`, …) until they move into
`@commonair/contracts/internal`.

Scheduled jobs are BullMQ job schedulers, so each tick runs once across all replicas.
Schedulers that are no longer in the registry are removed at startup.

## Integrity

The four integrity jobs (`score-sessions`, `verify-receipts`, `follow-bursts`, `stream-hours`;
ADR 0003 §5) each run as their own job scheduler, so a slow pass of one never delays another.

| Job               | Interval | Batch cap     | Attempts | Backoff (exponential, from) | Max lock hold |
| ----------------- | -------- | ------------- | -------- | --------------------------- | ------------- |
| `score-sessions`  | 15 s     | 2000 sessions | 3        | 2 s                         | 5 min         |
| `verify-receipts` | 60 s     | 1000 receipts | 3        | 10 s                        | 5 min         |
| `follow-bursts`   | 60 s     | —             | 3        | 10 s                        | 5 min         |
| `stream-hours`    | 5 min    | —             | 3        | 30 s                        | 20 min        |

- **Run locks.** BullMQ enqueues the next iteration when the current one starts, so each run
  also takes a Valkey lock (`worker:lock:integrity:<job>`, `SET NX` with a 30 s TTL renewed every
  10 s). A tick that finds the lock held is skipped (`outcome:"skipped"`). A run renews for at
  most its max hold; past that, or when a renewal fails or finds the lock no longer its own, the
  lock may lapse and the next tick may overlap the run once: this is logged as a warning (job
  name and reason) and counted as `outcome:"lock_lapsed"`.
- **Retries.** A run that throws is retried by BullMQ with the attempts and backoff above; the
  next scheduled tick runs regardless of a pending retry (the lock keeps them from overlapping).
  Rows beyond a batch cap wait for the next tick.
- **P2P evidence.** `score-sessions` reads the tracker's per-session evidence (`KEYS.p2pPeer`,
  `KEYS.p2pLinks`, `KEYS.p2pChannelNet`) for each batch alongside heartbeat and fetch evidence. A
  session is judged "too few fetches" against the reduced P2P HTTP share (10 %) only when, within
  the last 120 s, the tracker saw it announce to a swarm of its own channel and complete a
  signalling exchange with a peer on another network, at most 16 sessions on its network announced
  to the channel, and so did at most 16 on a linked network. Announcing into a diverse swarm earns
  nothing. "Too many" is always judged against share 1, and client `p2pCapable` / `bytesP2p` never
  matter. Failed Valkey reads never fail the run: those sessions are judged without the reduced
  share, logged as a warning and counted (`worker.integrity.evidence{source:"p2p",outcome:"error"}`).
  Residual risk (ADR 0005): a farm that answers offers from a second network, or gets honest
  clients to answer, can earn the reduced share for up to 16 sessions per network and channel; the
  other signals still apply. Details: `packages/integrity/README.md`.
- **Relay suspension.** A relay `verify-receipts` suspends is removed from `KEYS.relays` in the same
  run, so assignment stops immediately; a failed removal is logged and counted
  (`worker.integrity.actions{kind:"relay_deassign_failed"}`) and the API drops the relay on its
  next heartbeat.
- **Network list.** `INTEGRITY_DATACENTER_CIDRS_FILE` (CIDRs and ASNs of hosting networks) is
  loaded at startup and reloaded on `SIGHUP` (`kill -HUP <pid>`). A file that cannot be read
  keeps the previous list (at startup: scores without one, logged as an error). A reload that
  parses to no entries while the previous list had some is also refused with a warning, so a
  truncated file never switches hosting detection off; to drop the list entirely, unset the
  variable and restart. Replace the file atomically: write the new list to a temporary file in
  the same directory and `mv` (rename) it over the old one, then send `SIGHUP`. Never edit it in
  place while the worker may reload.

## Money jobs

Three recurring jobs on the `payments` queue carry out the worker rows of
`docs/testing/e4b-selectors.md` (Expiry, Renewal, Hold release). Each takes a Valkey run lock
(`worker:lock:money:<job>`, same mechanics as the integrity locks above), so two replicas or a
retry racing the next tick never run the same job at once; a tick that finds the lock held is
skipped (`worker.money.runs{outcome:"skipped"}`). Runs that throw retry 3 times (backoff from 10 s).

| Job                    | Schedule              | Max lock hold | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | --------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `money-expire-pending` | every 5 min           | 5 min         | `pending` payments with `expires_at <= now` → `failed` (CAS on status, rows locked `skip locked` so a confirm in flight wins). Their `incomplete` subscriptions (own or gifted via `gift_payment_id`) → `expired`; a `past_due` subscription whose renewal it was → `expired` with `channel.subscription.end`; the tip → `failed`. Nothing to reverse: nothing was posted.                                                                                                                                                                                                   |
| `money-renew`          | every 5 min           | 5 min         | `active` subscriptions with `current_period_end <= now`: `cancel_at_period_end` → `canceled`, gifts → `expired` (any provider: gifts never renew), a channel without the tier → `expired`, each with `channel.subscription.end`. A manual self subscription gets one `pending` renewal payment (today's tier price, fresh `CA-` reference, `expires_at` = the later of period end + `PAYMENT_PENDING_DAYS` and now + 1 day, so a renewal opened late after an outage still leaves a day to pay) and turns `past_due`. Stripe self subscriptions are left to Stripe's events. |
| `money-release-holds`  | hourly (`41 * * * *`) | 20 min        | `releaseDueHolds(asOf now)` with `holdDays` and currency from `payout.rules`, read per run: creator shares older than the hold move from `creator-hold` to `creator` (available). Calls repeat (500 payments each) while one releases its full limit, within the 30 s budget, so a backlog drains in one run.                                                                                                                                                                                                                                                                |

- **Batches and budget.** Expiry handles at most 500 payments per transaction, and stops adding
  payments once their subscriptions would pass 500 (a gift payment carries up to 100; the first
  payment is always taken so a batch never stalls). Renewal pages
  through 500 subscriptions at a time (one transaction each, the row locked `for update`); both
  loop until the work is done or 30 s have passed, and the rest waits for the next tick.
- **Idempotency.** Every transition is compare-and-set on the expected status, so a second run
  (or a racing treasurer confirm) changes nothing. Lock order is payment before subscription, as
  in the API's confirm; expiry skips a payment a confirm has locked, and the confirm wins. A renewal checks for an open `pending`
  renewal payment with the subscription row locked, so a subscription never gets two for one
  period (the normal flow never reaches that check, since renewal moves the row to `past_due` in
  the same transaction; it guards a subscription put back to `active` by hand); a reference clash (`payments_provider_ref_uq`) retries with a fresh reference. Hold
  releases are idempotent postings per payment (`hold-release:<payment id>`).
- **Outbox and chat.** End events are written in the transaction that ends the subscription and
  are published by the outbox relay. After commit the job publishes a chat `invalidate`
  (`BUS.chatControl(channelId)`, `scope:"user"`) per ended subscriber so the badge goes; chat
  keeps the badge while a subscription is `past_due`.
- **What the treasurer sees.** Renewal payments appear in the treasury payment list as `pending`
  with their reference, like any checkout, and are confirmed the same way (confirming continues
  the period from the previous `current_period_end`). Unconfirmed ones turn `failed` once
  expired. Released holds show as available creator balance in the next payout run.
- **Configuration.** `CURRENCY` and `PAYMENT_PENDING_DAYS` (`paymentsEnv`, validated at startup);
  the cut, minimum payout and hold period are governance settings, never env. `createWorker`
  reads them once into `ctx.money` (`MoneyJobConfig`: currency, pending days, batch size, time
  budget); pass `money` to `createWorker` (or set `ctx.money`) to inject config in tests. Jobs
  read it through `moneyConfig(ctx)`, which falls back to the env for a context without it.
- **Release dating.** Each hold release is dated when it fell due (payment time + `holdDays`,
  capped at the run's `now`), not when the job ran, so an outage does not push earnings into
  the next month's payout run (`runPayoutBatch` counts only postings dated at or before the
  period end).
- **Metrics.** `worker.money.runs{job,outcome}`, `worker.money.expired{kind}`,
  `worker.money.renewed`, `worker.money.subscriptions_ended{reason}` (`canceled`, `gift`,
  `no_tiers`, `renewal_unpaid`), `worker.money.released_cents{currency}`. Logs carry counts only,
  never user ids.

## Webhooks

- **Body** `{ subscription, event }` (Twitch EventSub shape) with `eventsub-*` headers from
  `WEBHOOK_HEADERS`; signature `sha256=HMAC(secret, id + timestamp + body)` with the secret
  decrypted from `secret_ciphertext` (`decryptSecret(AUTH_SECRET, "webhook", …)`).
- **Message id** is derived from (subscription, event), so it is identical across retries and
  duplicate fan-outs; `eventsub-message-retry` counts previous attempts.
- **Retries**: 5 attempts in total, waiting 1 min, 5 min, 30 min and 2 h (±10 % jitter). Any 2xx
  is success. After 3 consecutive events that exhausted every attempt the subscription becomes
  `failed` and a `revocation` (`notification_failures_exceeded`) is attempted; a success resets
  the streak.
- **Conditions**: every condition key must equal the payload field of the same name; `user_id`
  absent from the payload (chat events) must equal the subscription's user.
- **Authorization** (checked at fan-out and again before every attempt, test events and
  redeliveries included; the API checks the same at subscribe time):
  - the condition must contain every field `EVENTS[type].condition` lists, non-empty;
  - for events with scopes, the subscription's user must hold an unrevoked token with those
    scopes, for the subscription's app, or a personal token when it has no app (an expired access
    token with a refresh token counts);
  - and the user must be bound to the channel: the broadcaster named in the condition, or for
    `moderator:*` scopes the broadcaster or one of the channel's moderators (`channel_roles`); for
    `chat:read`-only events (public chat) the reading user, i.e. the condition's `user_id`.

  Otherwise the subscription is `revoked` and a `revocation` (`authorization_revoked`) is sent.

- **Job retries**: `fanout` and `deliver` jobs also retry infrastructure errors (database or
  Valkey down) 10 times with exponential backoff from 30 s (~8.5 h), separately from the HTTP
  retry schedule, so an outage does not drop events.
- **HTTP**: 10 s deadline, redirects never followed, at most 64 KiB of response read and 2 KiB kept
  in the delivery log.
- **SSRF**: callbacks must be `https://`; the host is resolved once and every answer must be a
  public unicast address (loopback, RFC 1918, CGNAT, link-local, cloud metadata, ULA, multicast,
  documentation, reserved, IPv4-mapped/compatible/NAT64/6to4 forms of those, Teredo are refused).
  The connection is pinned to the validated address (TLS still verifies the hostname), so DNS
  rebinding between check and connect has no effect. Decimal/octal/hex host spellings are
  normalized by URL parsing before classification. `EVENTSUB_ALLOW_INSECURE_CALLBACKS=true`
  (development and harness only) allows `http://` and private addresses.

## Adding a job

1. Create `src/jobs/<name>.ts`:

   ```ts
   import { QUEUES } from "@commonair/contracts/internal";
   import { z } from "zod";
   import { defineJob } from "../runtime/registry.ts";

   export const job = defineJob({
     queue: QUEUES.retention,
     name: "my-job", // kebab-case, unique per queue
     description: "What it does",
     data: z.object({}), // payload schema, checked before the handler runs (and on enqueue)
     schedule: { pattern: "0 4 * * *" }, // or { every: ms }; omit for on-demand jobs
     attempts: 3, // BullMQ retries for infrastructure errors (default 3)
     handler: async (data, ctx) => {
       /* ctx: db, sql, valkey, logger, enqueue, storage, now() */
     },
   });
   ```

2. Add it to the `JOBS` list in `src/jobs/index.ts`.
3. Test the handler's logic directly against `createTestDatabase()` (see `tests/housekeeping.int.test.ts`).

## Configuration

`DATABASE_URL`, `VALKEY_URL`, `AUTH_SECRET`, `WORKER_PORT`, `EVENTSUB_ALLOW_INSECURE_CALLBACKS`,
`S3_*` (VOD retention is skipped with a warning when S3 is not configured), plus two optional
worker-local variables: `WORKER_CONCURRENCY` (`queue=n,…`; defaults: webhooks 32, retention 1,
others 4) and `WORKER_BULL_PREFIX` (default `bull`). Shutdown stops the loops, lets in-flight
jobs finish for up to 25 s, then force-closes.

## Metrics

`worker.job.duration`, `worker.job.failures`, `worker.queue.depth`, `worker.outbox.lag`,
`worker.outbox.published`, `worker.outbox.invalid`, `worker.webhook.attempts` (by message type
and outcome: the success rate), `worker.segments.entries`, `worker.segments.evidence` (by outcome:
`recorded`, `failed`), `worker.integrity.runs` (by job and outcome: `ran`, `skipped`,
`lock_lapsed`), `worker.integrity.sessions` (by verdict), `worker.integrity.actions` (by kind),
`worker.integrity.evidence` (by source and outcome: `p2p` `evidenced` / `error`) and
`worker.integrity.stream_hours` (by eligibility).
