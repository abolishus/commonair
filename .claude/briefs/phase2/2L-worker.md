<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Unit 2L: Background worker (`services/worker`)

## You own

- `services/worker/**` (new package `@commonair/worker`)

## Contracts (read-only)

- `packages/contracts/src/internal.ts` (QUEUES, STREAMS.segments + SegmentFetch, KEYS), `events.ts` (EVENTS catalog, BUS, BusEvent, WEBHOOK_HEADERS, WEBHOOK_MESSAGE_TYPES, `signWebhook`, SubscriptionEnvelope), DB tables `events` (outbox), `event_subscriptions`, `webhook_deliveries`, `oauth_tokens`/`oauth_apps` (scopes for subscription authorization), `playback_sessions`, `egress_samples`, `relay_issuance`, `broadcasts`.
- `@commonair/tokens` (`decryptSecret(AUTH_SECRET, "webhook", …)` — the API stores webhook secrets with purpose "webhook"), `@commonair/service`, env: databaseEnv, valkeyEnv, authEnv.AUTH_SECRET, developerEnv, servicePorts.WORKER_PORT.

## Build

1. **Runtime**: BullMQ (`bullmq` 6.3.16, MIT) workers + a scheduler (BullMQ job schedulers / repeatable jobs) in one service, health on `WORKER_PORT` via `runService` (readiness: Postgres, Valkey, queue connection). Graceful shutdown closes workers after in-flight jobs (with a deadline). Concurrency per queue configurable. A small **job registry** pattern (`src/jobs/<name>.ts` each exporting `{ queue, name, schedule?, handler }`, loaded from `src/jobs/index.ts`) so later units add jobs by adding files plus one registry line.
2. **Outbox relay** (continuous loop, not a BullMQ job): claim unpublished `events` rows in batches with `FOR UPDATE SKIP LOCKED` (safe with multiple worker replicas), validate payload against `EVENTS[type].payload`, publish a `BusEvent` JSON to Valkey `BUS.events`, set `published_at`, and enqueue webhook fan-out. Latency target < 500 ms (use `LISTEN/NOTIFY` on insert if you add a trigger? — you cannot change migrations; poll with adaptive backoff 50 ms → 1 s instead).
3. **Webhook delivery** (`QUEUES.webhooks`): for each event, match enabled webhook `event_subscriptions` by type+version and condition (every condition key must equal the payload field, e.g. `broadcaster_user_id`); check the subscription's user/app still holds the event's required `scopes` (from the catalog) via an active token for that app+user — otherwise revoke the subscription (`status = revoked`, send a `revocation` message); POST the Twitch-shaped body `{ subscription: SubscriptionEnvelope, event }` with headers from WEBHOOK_HEADERS (message id stable across retries, timestamp, HMAC signature via `signWebhook` with the decrypted secret, type `notification`); 2xx = success; retries with exponential backoff + jitter (e.g. 1 min, 5 min, 30 min, 2 h, 6 h; max 5 attempts) ; every attempt logged in `webhook_deliveries` (status, response code, truncated body ≤ 2 KB, latency, next attempt); after N consecutive failed events set `status = failed` and stop. 10 s timeout per request, no redirects followed, response body size cap. **SSRF protection**: resolve the callback host and refuse private/loopback/link-local/metadata ranges and non-https unless `EVENTSUB_ALLOW_INSECURE_CALLBACKS=true`; re-check at connect time (DNS rebinding) by pinning the resolved address.
4. **Callback verification**: a job the API enqueues on subscription create (`{subscriptionId}`): POST `webhook_callback_verification` with `challenge`; the callback must echo the challenge as plain text with 200 within 10 s; then `status = enabled`, else `failed`.
5. **Test events / redelivery** jobs (`{subscriptionId}` → synthesize a sample payload valid against the catalog schema; `{deliveryId}` → re-send).
6. **Segment stream consumer**: consumer group on `STREAMS.segments` (XREADGROUP, ack after processing, claim stale pending entries); aggregate per minute: `egress_samples` (bytes/requests by source for the session's broadcast — look up broadcast by session, cached), `playback_sessions.segmentsFetched` and `bytesHttp` increments; trim the stream (`XTRIM MINID` older than 1 h). Must keep up with 200 viewers × 1 req/s comfortably (batch DB writes).
7. **Live counters**: every 10 s compute per-live-channel verified viewer counts from `KEYS.viewers` ZSETs + session verdicts (pruning stale members), update `KEYS.viewerCount`, and `broadcasts.peakVerifiedViewers`, `verifiedViewerSeconds`/`excludedViewerSeconds` accumulation.
8. **Housekeeping jobs**: expire old `verifications`/`sessions` rows, prune `webhook_deliveries` older than 30 days, close `playback_sessions` with no heartbeat for 2 minutes (`endedAt`), mark `relay_nodes` offline after missed heartbeats (with audit_log), VOD retention: delete expired VODs' objects (via `@commonair/storage` `deletePrefix`) and set status `deleted`.
9. Metrics: queue depth, job durations, failures, outbox lag, webhook success rate.

## Tests

- Unit: condition matching, backoff schedule, signature headers (verify with `verifyWebhook`), SSRF address classification (IPv4/IPv6, mapped addresses, decimal/octal host tricks), per-minute aggregation math, registry loading.
- Integration (real Postgres via `createTestDatabase()`, Valkey with unique key prefixes AND unique BullMQ `prefix`): outbox → BUS.events publish (subscribe and assert) → webhook to a local Bun HTTP receiver that verifies the signature; retries after 500s with delivery log rows; callback verification success/failure; revocation when the token is revoked; segment stream → egress_samples rows; stale session closing. Use `EVENTSUB_ALLOW_INSECURE_CALLBACKS=true` for local receivers.

## Done means

Common rules; `services/worker/README.md` listing every queue/job, its schedule, and how to add one.
