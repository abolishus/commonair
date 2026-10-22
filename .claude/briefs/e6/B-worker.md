<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Unit B: worker (export build and cleanup, deletion additions, VOD/clip purge)

You are implementing unit B of slice E6 for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md, PLAN.md, docs/architecture.md, `.claude/briefs/e6/_common.md` and
`docs/testing/e6-selectors.md` first. Do not look outside the repository.

## You own (write only these)

- `services/worker/src/**` (including `src/env.ts`: add `mailEnv`, `opsEnv` and the exports
  bucket as the worker needs them)
- `services/worker/tests/**`

## Contracts you must honor (read-only for you)

Everything in `_common.md`, especially `EXPORT_JOBS`, `ExportBuildJob`, `exportObjectKey`,
`EXPORT_TTL_SECONDS`, `EXPORT_FORMAT_VERSION`, `OPS_TICK_JOBS`, `OpsJobResult`, the export
archive table in the spec, the spec's "Account deletion (additions)", and the VOD/clip removal
flows (`removed_reason = 'owner' | 'creator'`, `expires_at = now()` set by the API).

## Build

1. **Export build** (`EXPORT_JOBS.build` on `QUEUES.exports`): `queued` → `running`
   (compare-and-set; a job for a row not `queued` is a no-op) → collect every file in the spec's
   archive table for the kind, in one read-only repeatable-read transaction, selecting strictly by
   the requester's user id / their channel id → zip with `fflate` → upload to
   `S3_BUCKET_EXPORTS` at `exportObjectKey(userId, exportId)` → one transaction `ready`,
   `storage_key`, `size_bytes`, `completed_at`, `expires_at = completed_at + EXPORT_TTL_SECONDS`
   → after commit email `dataExportReady` to the user's current address with a presigned GET
   (public endpoint, expiry = `expires_at`). Failure: `failed` with a stable code, no email;
   BullMQ attempts 3 with backoff. Write each collector as a separate, unit-testable function
   with an explicit column allow-list (never `select *`), so a reviewer can check every column.
   Other people appear only as public channel slugs where the spec says so. No secrets (spec list).
   A user deleted between request and build: skip, mark `failed`.
2. **Export cleanup** (`EXPORT_JOBS.cleanup`, hourly, run lock): `ready` exports past
   `expires_at` → delete the object, set `expired`, null `storage_key`. Returns counts.
3. **Account deletion additions** (`src/deletion/`): in the completion transaction delete
   `events` rows whose payload references the user's id (any jsonb value equal to the id; add a
   test with every event shape that carries a user id: `channel.tip`, `channel.follow`,
   `channel.subscribe`, chat events, mod events), delete `webhook_deliveries` rows referencing it,
   null `tips.message` (and any other non-append-only free text the user wrote that is retained:
   check `payments`, `subscriptions`, `reports`, `appeals` and list what you clear), delete the
   user's `data_exports` rows and, after commit, their objects. Read the email in the transaction
   and send `accountDeletionCompleted` after commit; never store or log it. Make the job's result
   (counts only) usable by the ops tick, and return `{ skipped: 1 }` when the run lock is busy.
4. **VOD/clip purge** (`housekeeping.ts` `enforceVodRetention` and its job): owner/creator-removed
   VODs (expired by the API) and removed clips get their objects deleted (VOD prefix, thumbnails,
   clip `storage_key`/thumbnail) and `status = deleted`, **except** when the channel owner has an
   active legal hold: skip and count `held`. Keep the existing prefix safety checks. Result counts
   include `held`. Make sure the existing T0/retention paths still behave.
5. Worker start-up: warn while `OPS_TEST_HOOKS` is on (as coop does); the ops tick itself is
   served by the API, which enqueues your jobs (`account-deletion` on `QUEUES.deletions`,
   `export-cleanup` on `QUEUES.exports`, `vod-retention` on `QUEUES.retention`): make sure each
   accepts an on-demand job with that name and empty data.

## Tests you must add

- Unit: each export collector's column list (snapshot of allowed keys), the zip/manifest builder
  (files and row counts), the user-id reference matcher for events.
- Integration (`*.int.test.ts`, real Postgres/Valkey/Garage at the `.env.example` defaults):
  export build for both kinds with two users who interact (follows, chat both ways, tips both
  ways, a report): the archive has every file, the requester's rows, and **no** id, email,
  username, display name or chat text of the other user anywhere in the zip bytes; no secret
  (seed a stream key, simulcast key, bot token, webhook secret and assert their values and hashes
  are absent); email in Mailpit with the link; link downloads; cleanup expires it and deletes the
  object. Deletion: events/webhook deliveries scrubbed, `tips.message` nulled, exports deleted,
  ledger/payments/audit/history kept and balanced, held data untouched, completed email sent.
  Purge: owner-removed VOD/clips deleted; held owner's kept and counted.

## Done means

As in `_common.md`. Run only `services/worker` tests you added or touched plus `bunx tsc -p
services/worker --noEmit`.
