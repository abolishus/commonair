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

| Loop             | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbox relay     | Claims unpublished `events` rows (`FOR UPDATE SKIP LOCKED`, batches of 200, oldest first), validates each against `EVENTS[type]`, publishes a `BusEvent` to `BUS.events`, enqueues `webhooks/fanout` when an enabled webhook subscription of that type exists, sets `published_at`. Polls with adaptive backoff 50 ms → 1 s and no sleep while a backlog remains. Invalid rows are logged and marked published so they cannot block the outbox. At-least-once: consumers dedupe by event id.                                                                                                                                                                                                                                                                         |
| Segment consumer | Consumer group `worker` on `STREAMS.segments`: `XREADGROUP` batches of 2000, per-minute aggregation into `egress_samples` (bytes and requests by source, for the session's broadcast; session → broadcast is cached) and `playback_sessions.segments_fetched` / `bytes_http` increments, one transaction per batch, then `XACK`; a failing batch is retried entry by entry. Every 30 s it first trims entries older than an hour (`XTRIM MINID ~`, independent of anything else failing), then reclaims entries pending for over a minute (`XAUTOCLAIM`); entries delivered 5 times without success are acknowledged and logged. Entries with `at` more than a day old or 5 min in the future are dropped. Sessions without a broadcast are re-looked-up after 60 s. |

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
| `retention` | `expire-auth-rows`         | hourly (`7 * * * *`)  | `{}`                                   | Deletes expired `verifications` and `sessions`.                                                                                                                                                          |
| `retention` | `prune-webhook-deliveries` | daily (`17 3 * * *`)  | `{}`                                   | Deletes `webhook_deliveries` older than 30 days.                                                                                                                                                         |
| `retention` | `vod-retention`            | hourly (`27 * * * *`) | `{}`                                   | Deletes expired VODs' objects (`deletePrefix` of exactly `vods/<vod id>/` on the media bucket; any other stored prefix is refused and logged), then marks them `deleted`; failures are retried next run. |

Producers in other services import the job names and payload schemas from
`@commonair/worker` (`WEBHOOK_JOBS`, `VerifyCallbackJob`, …) until they move into
`@commonair/contracts/internal`.

Scheduled jobs are BullMQ job schedulers, so each tick runs once across all replicas.
Schedulers that are no longer in the registry are removed at startup.

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
and outcome: the success rate), `worker.segments.entries`.
