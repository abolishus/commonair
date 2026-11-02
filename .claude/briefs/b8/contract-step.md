<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Batch 8 contract step (R0, S1 stage 1, M1, L1, follow-ups)

The orchestrator lands this on `main` before wave 1: implement, then an independent review, then a
fix pass. It is one commit or a short series. Push it and wait for CI green. The decisions are in
[`batch8/README.md`](../batch8/README.md): U1–U6 (answered by the user on 2026-11-02) and (a)–(r).
Line numbers are from `4e92eefe`; recheck them. For the database, follow
`.claude/skills/schema-change/SKILL.md`.

Nothing here implements a feature. This step creates the roles, tables, rules, seams, stubs and
scaffolding the twelve units build on, so that no two units ever write the same file. Split it
into four parallel parts with disjoint files, then integrate and review it whole, as in batch 7:
(A) S1-d, (B) the M1 schema and money seams, (C) the B8 contracts and seams, (D) docs, ADRs and
the harness.

**U4 changes this step.** Our instance launches at stage 1, on DigitalOcean Managed PostgreSQL and
managed Valkey. Part (A) is therefore launch-critical: it must prove the whole database path on a
Postgres with no superuser, including the restore and the monitor role, not only migrations. If
(A) finds that anything needs a superuser, stop and re-plan S1-b and S1-h with the user before
wave 1 (decision (a)).

## 0. Where the code differs from the plan

Found while writing this file. The README's units table is corrected to match.

- **"Outcome unknown" is not a column.** Treasurer refund requests are append-only `audit_log`
  markers (`services/api/src/money/stripe-refunds.ts:4-20`, `:32-36`): `payment.refund_requested`,
  `payment.refund_submitted` and `payment.refund_request_failed`. A request stops blocking after
  `REFUND_REQUEST_TTL_MS` (24 h, `:36`). So ADR 0007 decision 3 needs a fourth marker,
  `payment.refund_outcome_unknown`, and no `0048` column. `outstandingRefundRequests` (`:55`) is
  the pure rule to extend.
- **The gift window needs no new job.** `money-expire-pending` already runs every 5 minutes
  (`services/worker/src/jobs/money-expire-pending.ts:8-14`) and fails pending payments past
  `payments.expires_at` (`packages/db/src/schema/money.ts:118-119`). The checkout sets that column
  from `PAYMENT_PENDING_DAYS` (`services/api/src/money/checkout.ts:316`, `:369`, `:522`). Gift
  checkouts set it from `GIFT_PAYMENT_HOURS` instead. The README's `gift-expire` stub is dropped.
- **No column marks a gift payment.** A gift is a `subscription` payment (`PAYMENT_KINDS`,
  `packages/contracts/src/enums.ts:59`) that subscriptions point to through `gift_payment_id`
  (`checkout.ts:236`). The partial unique index needs `payments.gift` (below).
- **Most coop ledger rules exist.** `share_purchase` and `shareRefund` (`packages/ledger/src/rules.ts:992`,
  `:1008`) and `patronagePayout` (`:1095-1112`, Dr patronage payable, Cr cash) are written and
  unit-tested, but nothing outside the ledger calls `patronagePayout`. `buyShare` refuses any
  provider other than manual (`services/api/src/coop/membership.ts:238`). The new rules are only
  the Connect transfer reversals.
- **Payout sending already posts clearing to cash** (`payoutSent`, `rules.ts:874`), and the payout
  batch reserves in the ledger (`packages/ledger/src/payouts.ts:4-9`). A Connect transfer reuses
  `payoutSent` at transfer time. Only a reversal needs a new rule.
- **The heartbeat already has `switchTo`** (`packages/contracts/src/api/router.ts:863-878`) for the
  live source. `dvrSwitchTo` sits beside it.
- **`RoomSyncReport`** is in `packages/contracts/src/internal.ts:360-365`, and the server frame
  `room.sync {target}` is in `chat.ts:223`.
- **Export sections** spread per-feature arrays into `EXPORT_FILES`
  (`services/worker/src/exports/collectors.ts:1127-1128`). The giveaway section follows that
  pattern from its own file, so B8-server never writes `collectors.ts`.
- **Tofu already has stage 1.** `infra/tofu/digitalocean/modules/instance/managed_state.tf:20-75`
  creates both clusters with `node_count = 2`, `noeviction` and `rdb`, behind
  `enable_managed_state`. The production env still says "stage 0 at launch"
  (`envs/production/main.tf:4-5`).
- **The email catalogs** are JSON per namespace under `packages/email/src/messages/locales/{en,es}/`
  (for example `payments.json`), not a single `en.ts`.
- **No `apps/web/src/components/treasury/` exists.** The treasurer pages are
  `apps/web/src/components/coop/treasury.tsx` and `treasury-tabs.tsx`.
- **The latest migration** is `0047_b7_jury_backstop.sql`.

## 1. Part (A): S1-d, external Postgres without a superuser

Owner: orchestrator. Files: `packages/db/**` (tests, `client.ts` and `migrate.ts` only),
`packages/service/src/valkey.ts`, `packages/config/**` and `.env.example` (the two CA keys),
`infra/postgres/**`, `docs/decisions/0032-scaling-and-availability.md`.

ADR 0032 §3 (`:118-128`) says no superuser, extension or event trigger is needed, and that S1-d
proves it before S1-b ships. The app role is applied "as the database owner"
(`infra/postgres/app-role.sql:4-5`). Nothing tests that today.

### 1.1 The integration test (`packages/db/tests/external-owner.int.test.ts`)

Start a throwaway Postgres 17 container (the tag the stack pins) with TLS on and
`ssl_min_protocol_version = TLSv1.2`, with a CA and server certificate generated by the test. In
it, create a `commonair_owner` role with `CREATEROLE` and `LOGIN` only (no superuser, no
`BYPASSRLS`), and a database it owns. Then, connecting as that owner with
`sslmode=verify-full&sslrootcert=<ca>`:

1. Run `migrate.ts` (all of `0000`–`0049`) and `apply-app-role.ts`.
2. Check every protection trigger exists and fires as the app role. Reuse one append-only probe
   per trigger family (ledger, audit, governance, the batch 6 and batch 7 protections, the new
   `0049`).
3. Check the app role cannot `CREATE` in `public`, cannot create temporary tables, and has no
   rights outside the grants (ADR 0004).
4. Check a connection with `sslmode=disable` is refused (`hostssl` only in `pg_hba`).
5. Run the monitor-role and restore-role checks below.

Mirror DigitalOcean's limits where they matter: the owner role is not a superuser, has
`CREATEROLE`, and is not a member of `pg_monitor` with admin option. Each of those is one test.

### 1.2 The monitor role (`infra/postgres/monitor-role.sql`, new)

`commonair_monitor`: `LOGIN`, no other rights, a member of `pg_monitor` **where the owner can grant
it**. On Postgres 16 and later, a `CREATEROLE` role can grant only roles it holds with admin
option. So the script tries the grant and, if it is refused, still creates the role. The
collector's `postgresql` receiver then reads `pg_stat_database`, `pg_stat_user_tables`,
`pg_stat_bgwriter` and `pg_database_size`, which any role can read. Record which metrics are
missing without `pg_monitor`. L1-observability builds its dashboards to work either way.

`apply-app-role.ts` applies it after the app role, with the password from the transaction-local
setting `commonair.monitor_password`, as it does for the app role. The selfhost secret names are
in §3.7.

### 1.3 The restore path (ADR 0032 §4, `:142-157`)

The dump restore must not fire the protection triggers. ADR 0032 names two ways, and **both need a
superuser or a grant that DigitalOcean's `doadmin` cannot give**:

- `pg_restore --disable-triggers` needs a superuser;
- `SET session_replication_role` is a superuser parameter, and only a superuser can grant `SET`
  on it.

Test the owner-only way instead. The tables are created by the restoring role, which owns them, so
that role may run `ALTER TABLE … DISABLE TRIGGER USER`. That disables the protection triggers but
not the internal foreign-key triggers. So:

1. `pg_restore --section=pre-data`;
2. `ALTER TABLE … DISABLE TRIGGER USER` on every table in the `commonair` schemas;
3. `pg_restore --section=data`;
4. `ENABLE TRIGGER USER` on every table;
5. `pg_restore --section=post-data` (indexes, constraints; foreign keys are checked here).

The test restores a dump of a seeded database this way, as the no-superuser owner, into a fresh
database. It then checks the counts the drill uses: `channels.follower_count` against `follows`,
ledger balance per currency, and row counts per table. Write the procedure as
`infra/postgres/restore-owner.sql` plus the order above in the test's comment. S1-h scripts it.

If DigitalOcean refuses step 2 (it should not: the restoring role owns the tables), that is the
re-plan point of decision (a).

### 1.4 Client TLS, fixes, and the ADR

- **Neither client can verify a private CA today.** `createDb` (`packages/db/src/client.ts:44-62`)
  passes the URL straight to `postgres()` with no `ssl` option. postgres.js reads `sslmode` from
  the URL but ignores `sslrootcert`. The Valkey factory (`packages/service/src/valkey.ts:13`)
  passes no `tls` option. DigitalOcean's Standard edition hands out its own CA (ADR 0032 `:59`).
  So add two optional env vars, in `packages/config/src/env.ts` and `.env.example`, on every
  service that opens a pool:
  - `DATABASE_CA_FILE`: when set, `createDb` and `migrate.ts` connect with
    `ssl: {ca, rejectUnauthorized: true}`, and refuse a URL whose `sslmode` is weaker than
    `verify-full`;
  - `VALKEY_CA_FILE`: when set, the Valkey client uses `tls: {ca}` for `rediss://`.
    Unset keeps today's behaviour, so the bundled stack is unchanged. §1.1's test connects through
    `createDb` with `DATABASE_CA_FILE`, and a Valkey integration test does the same with a TLS
    Valkey container. S1-b mounts the CA at the path these name.
- Fix `packages/db/src/migrate.ts` and `infra/postgres/**` for anything the test finds.
- Amend ADR 0032 §4 with the owner-only restore and the `pg_monitor` finding. Add a "Decisions at
  acceptance" entry dated 2026-11-02 for U4 (§4 of this file).

### 1.5 The DigitalOcean check (agent track, after the staging token exists)

S1's plan asks for "one check against DigitalOcean's managed cluster". With U5's staging token,
an agent creates the smallest Managed PostgreSQL cluster in the staging project, runs §1.1's
steps against it with `doadmin` and its downloaded CA, records the results in ADR 0032, and
destroys the cluster. It runs beside wave 1. It does not block the contract step, because the CI
test above is the gate. It does block calling stage 1 launch-ready (README milestone checks).

## 2. Part (B): the M1 schema and the money seams

Owner: orchestrator. Files: `packages/db/**` (schema and the two migrations),
`packages/contracts/**` (money parts), `packages/config/**`, `.env.example`,
`packages/ledger/src/rules.ts`, `packages/payments/src/{adapter,stripe-client,stripe,stripe-events,factory}.ts`,
`services/api/src/money/stripe-events.ts` (the split only), the stub files named below.

### 2.1 `0048_b8.sql` (generated from schema changes)

- `payments.gift boolean not null default false`. Backfill it from
  `subscriptions.gift_payment_id`, and set it in `checkout.ts` on gift checkouts (the one line,
  in this step, so the index below can land).
- `payout_transfers`:
  - `id`, `payout_id` (FK `payouts`, unique), `provider`, `provider_ref` (the Stripe transfer id,
    unique when set), `destination_ref` (the connected account id), `amount_cents`, `currency`;
  - `status` (`pending`, `created`, `failed`, `reversed`), `reversed_cents`;
  - `idempotency_key` (unique), `failure_code` (an opaque short code, never Stripe's message);
  - `created_at`, `updated_at`.
- `patronage_payouts`:
  - `id`, `period_id`, `user_id`, `amount_cents`, `currency`, `provider`, `provider_ref`;
  - `status` (`pending`, `paid`, `failed`, `reversed`);
  - `idempotency_key`, `created_at`, `paid_at`;
  - unique (`period_id`, `user_id`).
- Shares need no new table: `membership_shares` and `payments.kind = membership_share` exist.
  `buyShare` writes the same rows for Stripe as for manual.

### 2.2 `0049_b8_protections.sql`

- **One open unpaid gift per gifter per channel** (decision (d)): a partial unique index on
  `payments (user_id, channel_id) where gift and status = 'pending'`. The API's `CONFLICT` is in
  addition to it (rule 9).
- **Transfers:** `payout_transfers` is append-mostly. A trigger allows only these updates:
  - status `pending → created | failed`, and `created → reversed`;
  - `reversed_cents` only upward, and never above `amount_cents`;
  - `provider_ref` set once.
    It also refuses a transfer for a payout whose provider is not `stripe`, or whose status is not
    `scheduled`.
- **Patronage payouts:** the same status rules. The sum of a user's `paid` payouts for a period
  never exceeds their `patronage_allocations` amount.
- **Ledger:** the new posting kinds below balance under the existing trigger and pass the
  idempotency-key uniqueness.
- Each trigger gets a direct-insert test as the app role.

### 2.3 Ledger rules (`packages/ledger/src/rules.ts`)

- `payoutTransferReversed({payoutId, transferId, userId, amountCents, currency, occurredAt})`:
  Dr `cash:stripe`, Cr the creator's earnings payable. Key `payout-transfer-reversed:<transferId>:<cumulative>`,
  so two partial reversals are two postings.
- `patronagePayoutReversed`: Dr `cash:<provider>`, Cr `patronagePayable(userId)`.
- Unit tests for each: balances, sign, idempotency key, and refusal of zero and negative amounts.
- A failed transfer (refused at create time) posts nothing new. The payout is cancelled through
  the existing `payoutCancel` (`rules.ts:905`), which returns the reservation to the payable.

### 2.4 Payments seams

- **`StripeClient`** (`packages/payments/src/stripe-client.ts:57-71`) gains, fully implemented and
  tested against stripe-mock:
  - `createTransfer(params, idempotencyKey) → {id, amount, currency, destination, reversed, amountReversed}`;
  - `retrieveTransfer(id)`;
  - `retrieveRefund(id)` and `listRefunds({paymentIntent})`, for the reconciliation job.
- **`PaymentAdapter`** (`adapter.ts:68-87`) gains optional `transfer?(request)` and
  `refundStatus?(providerRef)`. The manual adapter has neither, so nothing moves with it.
- **`packages/payments/src/stripe-transfers.ts`** (new, a stub that M1-connect fills):
  `stripeTransfer(client, request)`, called by the stripe adapter's `transfer`.
- **Error classes.** The client already throws on non-2xx. Add `StripeOutcomeUnknown` for a timeout,
  a network error, or a 5xx after the client's retries, as distinct from a definite 4xx
  `StripeRequestError`. ADR 0007 decision 3 turns on this difference.
- **Webhook parsing** (`packages/payments/src/stripe-events.ts:29`): new `StripeAction` kinds
  `transfer.reversed`, `transfer.updated` and `refund.updated`. Parse only the ids, amounts and
  metadata keys (`METADATA_KEYS`, `:250`) the handlers need.

### 2.5 Splitting the webhook handlers

`services/api/src/money/stripe-events.ts` is one 611-line switch (`applyStripeAction`, `:576-611`).
Split its dispatch so each unit fills its own file:

- `services/api/src/money/stripe-events/refunds.ts` (M1-gifts-refunds): `refund.updated`, and the
  after-commit follow-up for a `paid_after_end` booking (§2.6).
- `services/api/src/money/stripe-events/transfers.ts` (M1-connect): `transfer.reversed` and
  `transfer.updated`.
- `services/api/src/money/stripe-events/shares.ts` (M1-coop-money): the `membership_share` branch
  of `checkout.completed`. Today that branch goes through the generic path; keep that behaviour in
  the stub.

Each new file exports one function per action that answers `{ outcome: "ignored" }` until filled.
The existing cases stay where they are.

### 2.6 After-commit hooks (stubs)

- **`services/api/src/money/auto-refund.ts`**:
  - `autoRefundAfterEnd(deps, paymentId)` (M1-gifts-refunds).
  - `AppliedAction` (`stripe-events.ts:47`) gains `followUp?: {kind: "auto_refund", paymentId}`.
  - `stripe-webhook.ts` calls the hook after the transaction commits, outside the row lock, as
    ADR 0007 decision 2 asks.
- **`services/api/src/money/receipt.ts`**:
  - `sendPaymentReceipt(deps, paymentId)` (M1-gifts-refunds).
  - It is called after commit wherever a payment becomes `succeeded`: the Stripe
    `checkout.completed` and `invoice.paid` paths, and the treasurer's manual confirm in
    `checkout-treasurer.ts`.
  - The stub does nothing.
- **`services/api/src/money/refund-requests.ts`**: the handler file for
  `money.treasurer.refundRequests` (M1-gifts-refunds).
- **`services/api/src/money/transfers.ts`**: the handler file for `money.treasurer.transfers`
  (M1-connect).

### 2.7 Contracts and config

- **Router:**
  - `money.treasurer.refundRequests({state?, cursor})`: the requests with their markers, where
    state is `outstanding`, `unknown` or `all`.
  - `money.treasurer.refundRequests.resolve({requestId, outcome: "refunded" | "failed"})`, audited,
    for a request Stripe never answers.
  - `money.treasurer.transfers({payoutRunId?, cursor})`.
  - `coop.patronage.payouts({periodId})` (treasurer).
  - `coop.patronage.pay({periodId})` (treasurer, two approvers as for write-offs, audited).
  - All are `notImplemented` stubs.
- **Enums:**
  - `PAYOUT_TRANSFER_STATUSES` and `PATRONAGE_PAYOUT_STATUSES`;
  - the audit action `payment.refund_outcome_unknown`;
  - `money.payout_transfer.{created,failed,reversed}` and `coop.patronage_payout.{paid,reversed}`
    as internal events (never offered to apps).
- **Governance setting** `shares.cardPayments` (ordinary, seeded false) in the settings shape and
  the seed. M1-coop-money reads it, and card share purchases stay off until the co-op votes them on.
- **Config:** `GIFT_PAYMENT_HOURS` (int 1–168, default 24; api and worker) in
  `packages/config/src/env.ts` beside `PAYMENT_PENDING_DAYS` (`:234`), and in `.env.example`.
  Regenerate the self-host key lists (`bun scripts/selfhost/unit-env.ts`).
- **The email template key** `paymentReceipt` is registered in `packages/email/src/registry.ts`
  (beside `payoutSent`, `:9`, `:34`). The stub template is `templates/receipt.tsx`, and empty
  catalogs are `messages/locales/{en,es}/receipt.json`. The data shape is
  `{amountCents, currency, lines: PaymentBreakdown lines, paidAt, reference, channelName | null, kind}`.
  It carries no email address and no username.

### 2.8 Database security review

When (B) is integrated, an independent reviewer attacks `0049` and the new rules the way
`0002_protections_hardening.sql` was attacked:

- direct inserts and updates as the app role;
- status regressions;
- a second open gift raced across two connections;
- a transfer row for a manual payout;
- `reversed_cents` above the amount;
- a patronage overpay.

Every proven bypass gets a fix and a regression test before wave 1.

## 3. Part (C): B8 contracts and seams

Owner: orchestrator. Files: `packages/contracts/**`, `services/worker/src/jobs/index.ts`,
`services/worker/src/b7/outbox-jobs.ts`, `apps/web/src/chat/chat-panel.tsx`,
`apps/web/src/components/coop/treasury-tabs.tsx`, `apps/web/src/i18n/keys/index.gen.ts`, and the
stub files named below.

### 3.1 Federation events (decision (h))

- **The events.** Add `federation.actor.disabled {channel_id}` and `channel.federation {channel_id,
  enabled}` to `packages/contracts/src/events.ts` as internal events, beside `channel.moved`
  (`:904`).
- **Routing.** `b7JobsFor` (`services/worker/src/b7/outbox-jobs.ts`, called at `outbox.ts:169`)
  routes them:
  - `federation.actor.disabled` → `FEDERATION_JOBS.deliver` for the actor `Delete`, with a stable
    job id per channel and key generation;
  - `channel.federation {enabled:false}` → the same, plus the follower cleanup the API does today
    (`services/api/src/federation/settings.ts:85`, `:216`).
  - Unit-test the mapping.
- **The API side is B8-server's.** It stops calling `sendActorDelete` and writes the event instead.
  A toggle never emits the public `channel.update`.

### 3.2 Watch-room edge and DVR switch (B8-player)

- `RoomSyncReport` (`internal.ts:360-365`) gains `edgeWallclock: z.iso.datetime({offset:true}).nullable()`:
  the reporting player's live edge as a wall-clock instant, or null in `dvr` mode.
- The client frame `room.sync` (`chat.ts:72`) gains the same optional field.
- The heartbeat output (`router.ts:872-880`) gains `dvrSwitchTo: z.string().optional()`, a DVR
  playlist URL on the origin, sent only when the session's DVR source is a relay that left the
  active set.

### 3.3 Twitch per-field choices (B8-server)

- `ImportChoices` (`packages/contracts/src/api/entities.ts:2163-2164`) gains
  `fields: z.object({title, description, tags, language, mature, category}).partial()`, each a
  boolean. An absent `fields` means every field, as today.
- Update `twitchImport.start` (`router.ts:4396`) and the bundle import's `choices` (`:4280`).

### 3.4 Giveaway CR9 (B8-web)

- `interact.giveaways.verify` gains `me: {pseudonym} | null` for a signed-in caller who entered
  that giveaway, on any giveaway, not only the current one (W3-giveaways fix report, CR9). The
  salt is still never published.
- The API change is the one-field handler edit in `services/api/src/interact/giveaways/service.ts`,
  which B8-web owns for this field.

### 3.5 Statements of reasons for staff actions (B7 CR6, B8-server)

- `ENFORCEMENT_SOURCE_ACTIONS` (`enums.ts:396-410`) already has `report.resolve`, `user.suspend` and
  `channel.suspend`.
- Add a `facts.kind: "staff_action"` variant to the statement facts schema: the action, the clause,
  the time, and no case reference. Today's email cites a case id that does not exist
  (B7-followups finding 1).
- Add the email catalog keys `enforcementStatement.staffAction.*` (empty) in `en` and `es`.

### 3.6 Exports and jobs

- **Exports.** Add `services/worker/src/exports/giveaways.ts` (stub) exporting
  `GIVEAWAY_EXPORT_FILES` (one `interact-giveaways.json` collector returning `[]`), spread into
  `EXPORT_FILES` (`collectors.ts:1127`).
- **Jobs.** Register these stubs in `services/worker/src/jobs/index.ts` under `// Batch 8.`:
  - `portability-incoming-cleanup` (daily);
  - `import-record-expiry` (daily);
  - `refund-reconcile` (every 15 minutes);
  - `payout-transfers` (on demand, enqueued by a payout run);
  - `patronage-payout` (on demand).
    Each is a file under `services/worker/src/jobs/` that returns `{ skipped: "stub" }`.
- Job names go in `services/worker/src/jobs/names.ts` and payload schemas in
  `packages/contracts/src/internal.ts`.

### 3.7 Selfhost and collector names (S1-b and L1-observability)

These names are the contract between S1-b, which writes them, and L1-observability, which reads
them. Record them in `docs/self-hosting/configuration.md`'s key table (S1-b's file, in wave 1) and
here.

- **Podman secrets:**
  - `commonair-pg-monitor-password` and `commonair-valkey-monitor-password`;
  - for an external Postgres's or Valkey's CA, `commonair-pg-ca` and `commonair-valkey-ca`,
    mounted read-only at the paths `DATABASE_CA_FILE` and `VALKEY_CA_FILE` name (§1.4).
- **Collector environment, in `commonair.env`, never secrets:**
  - `PG_MONITOR_ENDPOINT` (host:port), `PG_MONITOR_USER` (default `commonair_monitor`),
    `PG_MONITOR_TLS` (`verify-full` or `disable`);
  - `VALKEY_MONITOR_ENDPOINT`, `VALKEY_MONITOR_USER` (empty for the default user),
    `VALKEY_MONITOR_TLS` (`on` or `off`);
  - `OBSERVABILITY_STATE_MODE` (`bundled` or `external`).
- **Bundled installs** set them to the bundled containers, so one collector config serves both.

### 3.8 Web seams

- `chat-panel.tsx` passes `channel` (the channel id and its live state) to the prediction card, so
  B8-web can show the grace window (W3-fair-predictions request 3).
- `treasury-tabs.tsx` mounts two stub tabs: `components/treasury/refund-requests.tsx`
  (M1-gifts-refunds) and `components/treasury/payout-transfers.tsx` (M1-connect). Both render
  `<EmptyState>` until filled.
- `coop.membership.tsx` keeps its page, and M1-coop-money owns it in wave 2.
- Empty namespaces `m1-money`, `m1-connect`, `m1-coop` and `b8-channel` (B8-web's panels and banner) in `en` and `es`, then `bun run i18n:gen`.
  Decision (r) named two. `m1-connect` is added so that M1-gifts-refunds and M1-connect never write
  one file in wave 1.

## 4. Part (D): docs, ADRs, tofu and the harness

Owner: orchestrator. Files: `docs/decisions/**`, `docs/testing/b8-selectors.md`,
`apps/web/tests/selectors.test.ts`, `harness/src/b8/**` (steps and stubs),
`harness/src/{registry,shards}.ts`, the scenario files that gain extension wiring, and
`infra/tofu/digitalocean/envs/production/**`.

### 4.1 ADRs

- **ADR 0014 Amendment 1** (decision (m), proposed): a separate `p2pBytesReported` figure, labelled
  client-reported, never summed into attested bytes and never paying. Statement `v: 2` is built in
  batch 9 after acceptance.
- **ADR 0007 Amendment 1** (decisions (b), (d), (f), accepted with this batch):
  - `GIFT_PAYMENT_HOURS` and the partial unique index;
  - the definite-versus-unknown refund split and the fourth marker;
  - Connect transfers per payout row;
  - failed and reversed transfers return to the payable;
  - no tax-form collection.
    Mark decisions 1–3 and item 6 "built in batch 8" when the units merge.
- **ADR 0032**, with part (A)'s amendment and a "Decisions at acceptance (2026-11-02)" entry for
  U4:
  - our instance launches at stage 1;
  - the 99.9% target applies from launch;
  - the stage 0 trigger row describes the self-host default only;
  - our backups are the provider's point-in-time recovery plus S1-h's nightly dump, and WAL-G does
    not run for our instance;
  - the cost and uptime notes in the README's "What U4 changes".

### 4.2 Tofu

`infra/tofu/digitalocean/envs/production/{main.tf,variables.tf,terraform.tfvars.example}`:

- `enable_managed_state` defaults to `true` for production, and the header comment says "stage 1
  at launch (U4)".
- Staging keeps it as a variable, default `false`, so the agent track creates managed clusters only
  when a run asks for them.
- `bash infra/tofu/check.sh` must pass.

### 4.3 Harness

- **`harness/src/b8/steps.ts`**, the same shape as `harness/src/w3/steps.ts:169-190`:
  - `B8_EXTENSIONS`:
    - `e4b-money: [gift-window, auto-refund, refund-unknown, connect-transfer, transfer-reversed, receipt-email]`
    - `e5-coop: [share-stripe, patronage-payout]`
    - `interact: [grace-bet-web, giveaway-verify-mine, raid-restart-keeps-raid]`
    - `watch-room: [edge-sync]`
    - `twitch-import: [field-choices, channel-panels-banner, import-expiry]`
    - `federation: [actor-disabled-event]`
    - `portability: [incoming-cleanup]`
    - `data-export: [giveaway-section]`
    - `trust-safety: [sor-staff-action, lapsed-ban-signin]`
  - `PENDING_B8_EXTENSIONS` (all of them at first);
  - `B8_EXTENSION_UNITS`, mapping each extension to its unit and file under `harness/src/b8/`.
- Wire `ctx.param("b8","")` into each named scenario.
- **The relay DVR switch** (`relay-dvr-switch`) is B8-player's. It runs inside the new
  `relay-dvr` scenario that B8-harness creates in wave 2. Add it to `PENDING_B8_EXTENSIONS` under
  `relay-dvr`. The orchestrator wires it when B8-harness merges.
- **The jury rerun cleanup** and the rate-limit message are B8-harness's, in existing files. They
  are not extensions.
- **The seed** (decision (p)) is untouched.

### 4.4 Selectors

`docs/testing/b8-selectors.md` lists the routes, the test ids and the scenario steps.
`apps/web/tests/selectors.test.ts` checks it, with a `PENDING_B8_IDS` list. The ids are:

- B8-web:
  - `channel-panels`, `channel-panel`, `channel-banner`;
  - `prediction-grace`;
  - `jury-flag-case-link`;
  - `giveaway-verify-mine`;
  - `replay-span-kept`.
- M1-gifts-refunds: `refund-requests`, `refund-request-unknown`, `refund-request-resolve`.
- M1-connect: `payout-transfers`, `payout-transfer-status`.
- M1-coop-money: `share-buy-stripe`, `patronage-payouts`, `patronage-pay`.
- B8-server: `twitch-import-field`.

## 5. Done means

- CI is green on `main` on the pushed commit. Every stub answers `notImplemented`, returns
  `{ skipped: "stub" }`, or is a pending harness step.
- §1.1's test passes in CI, with the monitor-role and owner-only-restore checks.
- The database security review of `0049` is done, and its findings are fixed with tests.
- `bash infra/tofu/check.sh` passes.
- PROGRESS "In flight" gets a "Batch 8 contract step merged" paragraph. It says:
  - what landed;
  - what differs from this file;
  - whether `pg_monitor` was grantable by the owner;
  - the owner-only restore result;
  - that the DigitalOcean check (§1.5) waits for the staging token.
