<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Batch 8: toward `v0.1.0` and launch (R0, S1 stage 1, M1, L1 prep, follow-ups)

Batch 8 of [`.claude/briefs/next/README.md`](../next/README.md). Items 1–6 of that file's "Order"
are done (as batches 1–7 of the work). E7, W0, P1, E8, E9, N1, N2 (Spanish), W1, W2, W3, N3 and
N4 are merged. What is left in the milestone table:

- **R0**: from the release candidates to `v0.1.0`
  ([`next/R0-release.md`](../next/R0-release.md)).
- **The rest of S1**: S1-b, S1-d, S1-e, S1-f and S1-h
  ([`next/S1-scaling.md`](../next/S1-scaling.md)).
- **M1**: money follow-ups, on stripe-mock only
  ([`next/M1-money-follow-ups.md`](../next/M1-money-follow-ups.md)).
- **L1**: the first public instance, mostly the user's work
  ([`next/L1-public-instance.md`](../next/L1-public-instance.md)).

The batch builds what engineering can do for those four, plus the batch 6 and batch 7 follow-ups
that are still open. It was planned at `43ae60dc` (2026-11-01). Batch 7 is merged there, and CI
is green on the push run. Its full `workflow_dispatch` run was still in progress.

**Status: final (2026-11-02).** The user answered U1–U6 on 2026-11-02. The contract step and the
twelve unit briefs are written (see [Briefs](#briefs)), and every gate was re-checked on `main` at
`4e92eefe`. The next orchestrator session starts the contract step from
[`HANDOFF.md`](HANDOFF.md).

## What is done, and what is left (checked on `main` at `43ae60dc`, re-checked at `4e92eefe`)

| Milestone | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R0        | **Code done, release not cut.** R0-a to R0-g are merged (PROGRESS "Batch 1": waves 1–3). The table there still says "brief ready" for R0-c to R0-f, but the wave 2 and 3 sections record their merges. Only `v0.1.0-rc.1` and `v0.1.0-rc.2` are tagged (`git tag`). Left: the real-server checks of `R0-release.md` §3, rc.3 and `v0.1.0`. `ROADMAP.md:13` still says Phase 1 is "in progress".                                                                                                                                                                                                                                                                                                                                         |
| S1        | **Stage 0 tooling done; stage 1 not built, and launch-critical under U4.** S1-a, S1-c and S1-g are merged, and ADR 0032 was accepted on 2026-10-27. S1-g's tofu already creates both managed clusters behind `enable_managed_state` (`infra/tofu/digitalocean/modules/instance/managed_state.tf:20-75`). Neither client can verify a private CA (`packages/db/src/client.ts:44-62`, `packages/service/src/valkey.ts:13`). `selfhost.sh` has no external Postgres or Valkey option: its option parser (`scripts/selfhost.sh:1632-1684`) has only `--s3-*` for external services. `docs/self-hosting/managed-services.md` does not exist. S1-d, S1-b and S1-h are open. S1-f is for stage 2 and S1-e for stage 3, and neither is due yet. |
| M1        | **Not started.** The gift window is still `PAYMENT_PENDING_DAYS`, default 7 (`packages/config/src/env.ts:234`), and there is no one-open-gift rule (ADR 0007:22-29). The repository has no "outcome unknown" refund state: refund requests are audit markers, not a column (`services/api/src/money/stripe-refunds.ts:4-36`). `StripeClient` has refunds and Express onboarding but no transfer (`packages/payments/src/stripe-client.ts:57-71`). `buyShare` refuses with `manual_shares` (`services/api/src/coop/membership.ts:238`). There is no receipt email: `packages/email/src/templates/payments.tsx` has only `payoutSent` (`:16`) and `chargebackNotice` (`:49`).                                                             |
| P1        | **Done in batch 2** (P1-tracker, P1-turn, P1-player). Left: P2P bytes in attestations, which first need an ADR 0014 amendment (see below). `P2P_DEFAULT` stays `off` (`packages/config/src/env.ts:418`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| L1        | **The user's, with engineering gaps.** The collector receives OTLP only (`infra/otel-collector/config.yaml:15-21`), so there are no host, Postgres or Valkey metrics (ADR 0032 §6, `:166-176`). `infra/grafana/dashboards/` holds only its README, which says it is "intentionally empty". `infra/prometheus/prometheus.yml` has no `rule_files`. No status page exists (`L1-public-instance.md:37-38`). E7 is done: the only `notImplemented` left in `services/api/src` is its definition in `lib/errors.ts`.                                                                                                                                                                                                                         |

## Units and gates (checked against `main` at `43ae60dc`, re-checked at `4e92eefe`)

Twelve units in two waves, after one contract step. The briefs are written, and
[Path ownership](#path-ownership) is final. Where the code differs from the plan at `43ae60dc`, the
row says so and the contract step's §0 has the detail.

| Unit                 | Wave | Gated on                                              | State on main (evidence)                                                                                                                                                                                                                                                                                                                         | Builds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ---- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1-d (contract step) | 0    | R0-b (merged); **launch-critical (U4)**               | ADR 0032 §3 says no superuser or extension is needed, and that S1-d proves this before S1-b ships (`docs/decisions/0032-scaling-and-availability.md:120-128`). The app role is applied "as the database owner" (`infra/postgres/app-role.sql:4-5`). No test runs migrations as a non-superuser.                                                  | An integration test: migrations, `0001`–`0047` triggers and the app role, all applied by a CREATEROLE owner on a Postgres with no superuser and `sslmode=verify-full`. A `commonair_monitor` role (`pg_monitor` where the owner can grant it) for L1-observability. **Changed:** ADR 0032 §4's restore needs a superuser or `SET` on `session_replication_role`, which DigitalOcean's `doadmin` cannot give, so S1-d proves an owner-only restore (`DISABLE TRIGGER USER` on owned tables) instead. Client TLS with a private CA (`DATABASE_CA_FILE`, `VALKEY_CA_FILE`). One check against a real managed cluster on the staging project (U5). |
| S1-b external        | 1    | S1-d; **launch-critical (U4)**                        | No `--database-url` or `--valkey-url` (`scripts/selfhost.sh:1632-1684`). The secrets exist (`:1266-1272`), but only for the bundled services.                                                                                                                                                                                                    | `selfhost.sh --database-url/--valkey-url` with TLS (`verify-full`, `rediss://`). The bundled Postgres or Valkey units are not installed when external. `status` checks the remote. `upgrade` keeps the choice and runs `migrate` once. A self-host e2e external-services variant: Postgres with no superuser and TLS, and Valkey with an ACL user and TLS, each outside the instance's network. It also checks that BullMQ issues no `CONFIG`/`ACL` (ADR 0032 §3).                                                                                                                                                                             |
| S1-h backups-ext     | 2    | S1-b; **launch-critical (U4)**                        | `docs/self-hosting/backups.md:349` restores WAL-G only. ADR 0032 §4 (`:142-157`) asks for a logical dump and a drill.                                                                                                                                                                                                                            | `selfhost.sh backup` with an external Postgres: a nightly `pg_dump` to the operator's bucket, keeping 30. A drill restores into a scratch database with triggers disabled, then checks counts (`follower_count` against `follows`). The WAL-G drill also runs on a timer. Writes `docs/self-hosting/managed-services.md`, with DigitalOcean as the worked example: under U4 it is the procedure our production follows.                                                                                                                                                                                                                        |
| L1-observability     | 1    | the contract step's monitor role and §3.7 names       | Receivers are OTLP only (`infra/otel-collector/config.yaml:15-21`). No dashboards. No alert rules.                                                                                                                                                                                                                                               | Host, Postgres and Valkey metrics (the collector's `hostmetrics`, `postgresql` and `redis` receivers, or exporters vetted by ADR 0002/0022). Under U4 Postgres and Valkey are collected **remotely**, over verified TLS with the monitor role, because nothing of ours runs on the managed hosts; DigitalOcean's database metrics endpoint is an optional scrape, off by default. Grafana dashboards for every ADR 0032 trigger and the availability target (99.9% for our instance). Prometheus alert rules at 80% of each trigger, plus an SLO burn rule, checked with `promtool` in a test. Writes `docs/operators/monitoring.md`.          |
| L1-status            | 2    | L1-observability                                      | No status page (`L1-public-instance.md:37-38`). No alert route.                                                                                                                                                                                                                                                                                  | A public status page on the monitoring droplet: blackbox probes from the second region, rendered to a static page (decision (k)). Grafana alert contact points (SMTP through the instance relay, plus a webhook). The tofu monitoring droplet's cloud-init. Runbooks: `docs/operators/{incidents,on-call,status-page}.md`.                                                                                                                                                                                                                                                                                                                     |
| M1-gifts-refunds     | 1    | ADR 0007 decisions 1–3; the contract step's schema    | The window is 7 days (`env.ts:234`). There is no one-open-gift constraint and no `outcome_unknown` state. No receipt template (`payments.tsx`).                                                                                                                                                                                                  | ADR 0007 decision 1: one open unpaid gift per gifter per channel (`CONFLICT`, plus a new `payments.gift` column for the index), and gift payments expire after 24 h through `payments.expires_at`; the 5-minute `money-expire-pending` job already fails them, so no new job. Decision 2: auto-refund money collected for an ended subscription, with a ledger reversal. Decision 3: "outcome unknown" for refund calls as a fourth audit marker, with a reconciliation job and a treasurer view. The payment receipt email with the `PaymentBreakdown` lines (batch 4 decision).                                                              |
| M1-connect           | 1    | ADR 0007:52-54; W2-splits (merged)                    | Payout runs record `provider: stripe` and move nothing (ADR 0007:52-54). There is no transfer call (`stripe-client.ts:57-71`, `adapter.ts:70-86`). Express onboarding exists (`services/api/src/money/stripe-connect.ts`).                                                                                                                       | Connect transfers per recipient at payout, with ledger postings, and failure and reversal (`transfer.reversed`) handling, on stripe-mock. The manual adapter stays the default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| M1-coop-money        | 2    | M1-connect; ADR 0020                                  | `buyShare` answers `manual_shares` (`membership.ts:238`). Patronage payables have no payout path. The ledger rules exist but are unused: `share_purchase` and `shareRefund` (`packages/ledger/src/rules.ts:992`, `:1008`) and `patronagePayout` (`:1095-1112`).                                                                                  | Stripe Checkout for co-op shares, with ledger postings and refunds per the bylaws. Paying patronage payables out: the manual adapter first, then Connect through M1-connect's transfer service.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| R0-release-prep      | 2    | S1-b merged (it owns the e2e in wave 1)               | The e2e upgrades between two builds of the same tree (`scripts/selfhost/e2e.ts:25-30`). It never starts from a published release. `CHANGELOG.md` and the self-hosting docs predate batches 2–7 (whisper, coturn, web push, federation, captions).                                                                                                | An e2e `--from-release <tag>` mode: pull a published, signed release from ghcr, install it, then upgrade to the candidate. Run first from `v0.1.0-rc.2`, then from every release. The `v0.1.0` changelog. A reading pass over `docs/self-hosting/**` for everything added since rc.2. The flake log for R0's "ten green main runs" rule.                                                                                                                                                                                                                                                                                                       |
| B8-server            | 1    | the contract step's events and fields                 | See [Follow-ups](#batch-6-and-batch-7-follow-ups) for the evidence of each item. Per-field choices are applied in `services/worker/src/portability/import/apply.ts` (the bundle importer the Twitch job calls), so B8-server owns that file's channel section.                                                                                   | The lapsed-ban event at sign-in. Giveaway entries and wins in the data export. A raid surge keeps `raid` when a moderator restarts it. `federation.actor.disabled` and `channel.federation`. The B7 CR6 staff-action variant of statements of reasons. Cleanup of failed and abandoned `incoming/portability/` archives. Expiry of Twitch import data. Per-field Twitch import choices, worker and web.                                                                                                                                                                                                                                        |
| B8-web               | 1    | the contract step's CR9 field                         | `$channel.tsx` renders neither panels nor the banner (no match for `panels` or `banner` in its 167 lines). `ModQueue` keeps its selection in local state (`mod-queue.tsx:55-57`). The prediction card bets only while `active` (`prediction-card.tsx:142,204`). The replay model's deep seek starts a fresh span (`chat/replay/model.ts:10-13`). | Panels and the banner on the channel page. A link from a jury flag to its case (`/admin/moderation` search parameters). Web betting during the 30 s grace. The replay deep seek keeps its loaded span. Giveaway CR9: the verify page marks your entry on any giveaway.                                                                                                                                                                                                                                                                                                                                                                         |
| B8-player            | 2    | the contract step's `edgeWallclock` and `dvrSwitchTo` | `edgeWallclock` does not appear in `packages/contracts/src` or `apps/web/src`. After a relay leaves the active set, the player's DVR URL stays on the relay and answers 403 until the next start (W3-dvr-relay review, request 8).                                                                                                               | Room sync uses `max(edgeWallclock)` as the edge (W3-watch-rooms review MEDIUM 1). A heartbeat `dvrSwitchTo` moves a DVR session from a departed relay to the origin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| B8-harness           | 2    | none                                                  | `relay` is 12m18s and `clock` 13m02s on the batch 7 dispatch run, both single scenarios over the ~12 min cap (`harness/src/shards.ts:18-20`). `RATE_LIMITED_FORM_ERROR` is English only (`harness/src/web/flows.ts:36`). The jury rerun cleanup covers only panels whose seats are all harness members.                                          | Split `e2e-relay` into two scenarios (the relay base, then DVR, purge and `.vtt`), and trim `clock-skew` under the cap. Match the rate-limit message through the catalog, not English. Clean up the jury on same-stack reruns.                                                                                                                                                                                                                                                                                                                                                                                                                 |

**Not in batch 8:**

- S1-f (stage 2) and S1-e (stage 3): their triggers are not near (S1 "Order" 3).
- N2's Arabic (ADR 0029 decision 5, "next").
- The ADR 0033 SeaweedFS spike.
- P2P bytes in attestations v2: the contract step writes only the ADR 0014 amendment (decision (m)), and the build waits for it to be accepted.
- Anything that needs live money, a legal entity or real users.

## Decisions

Rows U1–U6 were the user's, answered on 2026-11-02. "Orchestrator" rows are defaults recorded as
decided, and the user may reopen any of them. **There is no counsel**
(batch 7 decision (h)). Every counsel-like call below takes the conservative default and is
listed under [Post-launch review](#post-launch-review).

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Who          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| U1  | **Answered 2026-11-02: launch readiness leads, and M1 runs beside it on stripe-mock** (the proposal). S1 stage 1 (S1-d, S1-b, S1-h), L1's engineering and R0's release prep lead; the three M1 units and the follow-ups run beside them.                                                                                                                                                                                                                                                                                                                                                                                                               | by user      |
| U2  | **Answered 2026-11-02: option (a).** Cut rc.3 from `main` once batch 8's full `workflow_dispatch` run is green, install it fresh on the staging droplet and run R0 §3, then tag `v0.1.0` from the same commit. Option (b) is dropped.                                                                                                                                                                                                                                                                                                                                                                                                                  | by user      |
| U3  | **Answered 2026-11-02, changed from the proposal.** A minor release every two weeks, cut from the newest commit with a green full `workflow_dispatch` run, not one per batch. The user does the visual checks on that release candidate, not on every batch. Patch releases go out as needed for R0-class fixes. `next/README.md` "Shared decisions" says the same.                                                                                                                                                                                                                                                                                    | by user      |
| U4  | **Answered 2026-11-02, changed from the proposal: our instance launches at stage 1** (DigitalOcean Managed PostgreSQL and managed Valkey, each with one standby; objects in Spaces), not stage 0. S1-d, S1-b and S1-h become launch-critical. Availability target from launch: 99.9% a month (about 43 min), not 99.5%. **Clarified by the user the same day:** this is how we deploy our own instance, not a change to `selfhost.sh`. The bundled Postgres and Valkey stay the self-host default with full support, and external managed services are an added option, as `--s3-*` is beside bundled Garage. See [What U4 changes](#what-u4-changes). | by user      |
| U5  | **Answered 2026-11-02: an agent runs the real-server checks** with a `doctl` token scoped to a **staging-only** DigitalOcean project: a spending cap, every droplet and cluster tagged and destroyed at the end of each run, nothing touching production. The user creates the project and the token (pending, [Open items](#open-items)). The production region and droplet size come from S1-a's numbers.                                                                                                                                                                                                                                            | by user      |
| U6  | **Answered 2026-11-02: ADRs 0037, 0038 and 0039 are accepted**, including ADR 0039 §2 (giveaways make the worker measure verified watching) and §3 (bettor standing only where measured). Their status lines say "accepted 2026-11-02" and their "Decisions at acceptance" are filled.                                                                                                                                                                                                                                                                                                                                                                 | by user      |
| a   | **The contract step does S1-d itself.** S1's plan makes it the orchestrator's (`packages/db/**`, `infra/postgres/**`). If a trigger needs a superuser after all, S1-b is re-planned before wave 1 rather than shipped around it.                                                                                                                                                                                                                                                                                                                                                                                                                       | orchestrator |
| b   | **M1 runs on stripe-mock only. No live keys, ever, in this batch** (`M1-money-follow-ups.md`, "Hard gate"; counsel-like). stripe-mock is stateless, so failure paths (a transfer reversal, a refund timeout) are driven by signed local webhook events and injected adapter faults, as E4b did (ADR 0003 D1).                                                                                                                                                                                                                                                                                                                                          | orchestrator |
| c   | **The ledger rule changes go through the contract step**: transfer postings, the refund reversal and share purchases. A database security review of the new triggers follows, as `0002_protections_hardening.sql` had. Migrations `0048_b8.sql` and `0049_b8_protections.sql`.                                                                                                                                                                                                                                                                                                                                                                         | orchestrator |
| d   | **Gift window:** a new `GIFT_PAYMENT_HOURS` (default 24) applies to gift payments only. `PAYMENT_PENDING_DAYS` keeps the rest. One open unpaid gift per gifter per channel is a partial unique index, with an application `CONFLICT` in addition (rule 9).                                                                                                                                                                                                                                                                                                                                                                                             | orchestrator |
| e   | **Refunds on a portability move stay unbuilt** (batch 7 decision (m)). The move notice keeps saying subscriptions continue until the streamer ends them. It needs finance rules and live money, so it stays on the review list.                                                                                                                                                                                                                                                                                                                                                                                                                        | orchestrator |
| f   | **Connect:** transfers to Express accounts, one per split recipient (W2-splits), at payout-run time. A failed or reversed transfer returns the amount to the payable through a ledger reversal, and the treasurer sees it. No tax-form collection is built (counsel-like).                                                                                                                                                                                                                                                                                                                                                                             | orchestrator |
| g   | **A lapsed ban cleared at sign-in writes `channel.suspension {suspended:false}`.** The admin plugin clears it through a user update, so the API writes the event from `databaseHooks.user.update` when `banned` goes false (`services/api/src/auth/index.ts:252-286`). The brief first checks that the plugin's clear goes through that hook, and falls back to a session-create `after` hook if it does not. That hook is not transactional (`:268-270`), so the 5-minute `ban-expiry` sweep stays the backstop, and the two must not double-emit.                                                                                                    | orchestrator |
| h   | **New internal events** `federation.actor.disabled {channel_id}` and `channel.federation {channel_id, enabled}` (N4-api request, N4-delivery review #3), routed by `b7JobsFor`. A toggle never emits the public `channel.update`. The API stops queueing `deliver` jobs and deleting follower rows itself.                                                                                                                                                                                                                                                                                                                                             | orchestrator |
| i   | **Failed and abandoned import archives** under `incoming/portability/` are deleted by a daily job once their import is `failed`, or `previewed` and older than 24 h. Today they are deleted only after a successful apply (`services/worker/src/portability/import/index.ts:93-96`).                                                                                                                                                                                                                                                                                                                                                                   | orchestrator |
| j   | **Twitch import data expires** (counsel-like). The public Twitch data in `portability_imports.preview` and `.result` (`packages/db/src/schema/b7.ts:153-155`), including the Twitch user name, is cleared 30 days after the import finishes. The row keeps its status, source and times for the audit trail.                                                                                                                                                                                                                                                                                                                                           | orchestrator |
| k   | **The status page is in-house, with no new dependency.** The monitoring droplet's Prometheus probes the instance with `blackbox_exporter` (Apache-2.0, vetted per ADR 0022). A small script renders a static page that Caddy serves there. No third-party status service and no new image beyond the exporter.                                                                                                                                                                                                                                                                                                                                         | orchestrator |
| l   | **Alerts go to email through the instance's SMTP relay** (Resend on 2587, as on staging), plus an optional generic webhook. No proprietary paging service is required (rule 3). The human on the route is the user's L1 item.                                                                                                                                                                                                                                                                                                                                                                                                                          | orchestrator |
| m   | **P2P bytes in attestations:** the contract step writes ADR 0014 Amendment 1 (proposed). It recommends a separate `p2pBytesReported` figure, labelled client-reported, never summed into attested bytes and never paying. Statement `v: 2` (tokens, vectors, worker, SDK) is built in batch 9, after acceptance.                                                                                                                                                                                                                                                                                                                                       | orchestrator |
| n   | **Giveaway CR10 stays declined.** Winners stay pseudonym-only to streamers (batch 7 wave 1). CR9 (marking your entry on any giveaway) is built.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | orchestrator |
| o   | **Shard cap:** every harness shard stays under about 12 minutes. A single scenario over the cap is split (e2e-relay) or trimmed (clock-skew). It is not left as an exception.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | orchestrator |
| p   | **Seeds stay with the seed-full session.** Publishing `interact.giveawayId` and `social.moveLinkNonce` belongs to `.claude/briefs/seed-full/` (`harness/src/seed/**`). No batch 8 unit writes there. The orchestrator coordinates through `harness/src/seed/routes.ts` only.                                                                                                                                                                                                                                                                                                                                                                           | orchestrator |
| q   | **No new third-party npm, Go or image dependency** except `blackbox_exporter` and the metrics receivers or exporters L1-observability picks. Each goes through `vet-package` or `pin-images`, `infra/image-licenses.json` and an orchestrator OK.                                                                                                                                                                                                                                                                                                                                                                                                      | orchestrator |
| r   | **Each UI unit writes `en` and `es` in the same change** (`REQUIRED_LOCALES = ["es"]`). It uses the namespace of the component it changes (`w3-jury`, `w3-giveaways`, `w3-predictions`, `n3-import`), or `m1-money` and `m1-coop`, which the contract step creates empty.                                                                                                                                                                                                                                                                                                                                                                              | orchestrator |

## What U4 changes

Our instance launches at stage 1, so stage 1 is no longer "ready before its trigger" but on the
launch path. Every unit and milestone check was re-read for it.

**The self-host default does not change** (the user, 2026-11-02): "the self host solution should
still support non-external postgres and valkey".

- `selfhost.sh` installs bundled Postgres and Valkey by default, with WAL-G, exactly as today.
- `--database-url` and `--valkey-url` are an option beside it, as `--s3-*` is beside Garage.
- Both modes are fully supported, tested in CI and documented, with bundled presented first:
  - install, upgrade, `status`, backups, restore drills and metrics all work in each mode;
  - the self-host e2e runs the bundled default, as today, and the external variant, both in CI;
  - backups keep WAL-G for bundled Postgres and add `pg_dump` for external;
  - metrics come from local receivers for bundled state and remotely, with the monitor role, for
    managed state.
- Switching an existing instance between modes is **refused** with a clear message. The move is a
  data migration, documented as a manual dump-and-restore procedure in `managed-services.md`.

What changes for our own deployment:

- **S1-d** (contract part (A)) must prove the whole database path without a superuser:
  - migrations, triggers and the app role;
  - the monitor role;
  - an owner-only restore, because `pg_restore --disable-triggers` and `SET session_replication_role`
    both need a superuser that DigitalOcean does not give;
  - client TLS with a private CA, which neither client supports today.
    One run against a real managed cluster on the staging project (U5) is needed before stage 1 is
    called launch-ready.
- **S1-b:**
  - our production installs through `--database-url` and `--valkey-url`;
  - a preflight checks TLS, the owner's rights, the server version, and the connection budget
    against DigitalOcean's small `max_connections`;
  - the e2e covers the password-only default Valkey user, DigitalOcean's model, beside an ACL user.
- **S1-h:**
  - WAL-G does not run for our instance;
  - our backups are DigitalOcean's 7-day point-in-time recovery plus a nightly dump to Spaces in
    another region, with 30 kept;
  - a weekly drill into a throwaway container on the host, and one timed restore into a fresh
    managed cluster on the staging project. That time becomes our restore time in ADR 0032 §1.
  - `managed-services.md` is the procedure our production follows, matching the tofu module.
- **L1-observability:**
  - Postgres and Valkey metrics are collected remotely, over verified TLS, with the monitor role,
    because nothing of ours runs on the managed hosts;
  - managed node CPU and disk come only from DigitalOcean's metrics endpoint, an optional scrape
    that is off by default;
  - the burn-rate rules take the target as a label: 0.995 is the self-host default, and our
    production sets 0.999.
- **L1-status:** paging must reach a human within minutes against a 43-minute monthly budget. So
  the monitoring droplet alerts on its own probes, independent of the app droplet.
- **The `failover` test** runs against managed clusters on the staging project. Force a standby
  promotion if DigitalOcean allows one, or measure the next maintenance event, and record the time
  and any lost writes.
- **The R0 restore drill to a second droplet** stays a release gate for the self-host default
  (WAL-G). For our instance, an app-droplet loss is a rebuild from tofu against the managed
  clusters, timed on the staging project.
- **Tofu:** production's `enable_managed_state` defaults to true (contract step §4.2).
- **The L1 launch checklist** changed (`next/L1-public-instance.md`):
  - item 6 is the provider's recovery plus dumps and drills;
  - item 7 agrees the stage 2 triggers, not stage 1's;
  - item 8 includes the managed clusters.
- **Uptime:**
  - 99.9% a month from launch, about 43 minutes, instead of 99.5% (about 3.6 h). DigitalOcean's
    SLA for a cluster with a standby is 99.95% (ADR 0032 `:64`), so the target is within what the
    provider commits to.
  - The app droplet is still a single host until stage 2, so planned upgrades count against 43
    minutes. With a minor every two weeks (U3) plus patches, each upgrade must take well under 10
    minutes of downtime.
  - ADR 0032's stage 1 → 2 trigger, "upgrade downtime over half the monthly budget", is about
    21 minutes a month. L1-observability alerts at 80% of it.
- **Cost:**
  - Two managed clusters with one standby each are billed from day one: four database nodes, on top
    of the app droplet, the monitoring droplet and Spaces. Each standby node is billed like a
    primary, so the database line is about double a single-node cluster. Check the exact prices at
    provisioning.
  - The connection limit on the smallest nodes may force a larger Postgres node than the data
    needs. S1-b's preflight reports this.
  - In exchange: a database failover in seconds instead of a restore measured in hours, and no
    WAL-G to run.
  - This is recorded in ADR 0032 at the contract step.

## Contract step

Orchestrator, on `main`. It is pushed, with CI green, before wave 1. The full spec is
[`b8/contract-step.md`](../b8/contract-step.md). Its four parts touch disjoint files and can run as
a Workflow:

- **(A) S1-d** (launch-critical under U4):
  - the no-superuser integration test under verified TLS;
  - the `commonair_monitor` role;
  - the owner-only restore;
  - `DATABASE_CA_FILE` and `VALKEY_CA_FILE`;
  - fixes to `migrate.ts` and `infra/postgres/**`;
  - the ADR 0032 amendment.
  - One real managed-cluster check follows on the agent track.
- **(B) M1 schema and money seams:**
  - `0048_b8.sql` (`payments.gift`, `payout_transfers`, `patronage_payouts`) and
    `0049_b8_protections.sql` (the gift index, the transfer and patronage guards);
  - the reversal rules;
  - `createTransfer`/`retrieveTransfer`/`retrieveRefund`/`listRefunds` on `StripeClient`;
  - `transfer?`/`refundStatus?` on `PaymentAdapter`, and `StripeOutcomeUnknown`;
  - the webhook dispatch split into `stripe-events/{refunds,transfers,shares}.ts`;
  - the after-commit hooks: auto-refund and receipt;
  - the treasurer procedures, `GIFT_PAYMENT_HOURS`, the `shares.cardPayments` setting and the
    `paymentReceipt` template;
  - then the database security review.
- **(C) B8 contracts and seams:**
  - the two federation events and their routes;
  - `edgeWallclock`, `dvrSwitchTo`, `ImportChoices.fields` and `verify.me`;
  - the `staff_action` statement facts;
  - the giveaway export stub;
  - the job stubs: `portability-incoming-cleanup`, `import-record-expiry`, `refund-reconcile`,
    `payout-transfers`, `patronage-payout`;
  - the selfhost and collector names (§3.7);
  - the `channel` prop, the treasury tab stubs, and the empty `m1-money`, `m1-connect`, `m1-coop`
    and `b8-channel` namespaces.
- **(D) Docs, tofu and harness:**
  - ADR 0014 Amendment 1, ADR 0007 Amendment 1, and ADR 0032's U4 entry;
  - production `enable_managed_state = true`;
  - `harness/src/b8/steps.ts` with `B8_EXTENSIONS`/`PENDING_B8_*`;
  - `docs/testing/b8-selectors.md` with `PENDING_B8_IDS`.

## Contract step as landed (read before your brief)

The contract step merged on 2026-11-03. Where it differs from `b8/contract-step.md` or a brief,
this list wins:

- **Patronage payouts:** the `(period_id, user_id)` unique index is partial (`pending` or
  `paid`), so a failed or reversed payout is retried with a new row. `patronagePayout` and
  `patronagePayoutReversed` take `payoutId` and are keyed by the payout row. The job id is still
  `patronage-payout-<period>-<user>`; M1-coop-money may ask to key it by the row id.
- **Transfers:** `payouts_transfer_guard` freezes a payout's user, provider, amount and currency
  once a transfer exists, and ties its status to the transfer's (`→ paid` needs `created`,
  `→ failed` needs `failed`). M1-connect updates the transfer first, then the payout, in one
  transaction.
- **Gifts:** `subscriptions.gift_payment_id` must name a `gift = true` payment. Gift checkouts
  lock the gifter's open pending gift (`FOR UPDATE`) before calling Stripe. They still expire after
  `PAYMENT_PENDING_DAYS`; switching gift payments to `GIFT_PAYMENT_HOURS` is M1-gifts-refunds'.
- **Auto-refund durability (M1-gifts-refunds):** the after-commit hook is best effort. Add a
  durable trigger: a `refund-reconcile` sweep of ended subscriptions' booked payments, or an
  outbox event written in the `invoice.paid` transaction.
- **Refund requests** are `money.treasurer.refundRequests.{list,resolve}`. `money.treasurer.transfers`
  filters by `periodStart`, not a payout-run id. The statement-facts variant is
  `code: "staff_action"`.
- **Stripe errors:** 4xx is `StripeRequestError`; network, timeout, 5xx, 409, 429 and
  `idempotency_error` after retries are `StripeOutcomeUnknown`.
- **stripe-mock** now runs in `scripts/infra.ts test`, so the stripe-mock integration tests run in
  CI.
- **Client TLS:** `createDb` reads `DATABASE_CA_FILE` and `createValkey` reads `VALKEY_CA_FILE`;
  every raw BullMQ connection spreads `valkeyTls(url)`. Harness Bun `RedisClient` connections do
  not (the harness targets the bundled stack). `pg_monitor` is **not** grantable by a
  CREATEROLE owner on Postgres 17: the monitor role exists without it (no WAL size, no other
  roles' `pg_stat_activity` state). The bundled stack gets the monitor role only once compose's
  migrate service passes `POSTGRES_MONITOR_PASSWORD` (S1-b / L1-observability contract request).
- **Federation:** `channel.federation {enabled:false}` queues the actor `Delete` plus
  `FEDERATION_JOBS.followerCleanup`. A `federation.actor.disabled` written for a deleted account
  finds no actor row and queues nothing; B8-server must not double-send on suspension, which
  already sends a `Delete` through the fan-out.
- **Web:** the prediction card receives `channel` from `$channel.tsx` (`stream` prop on
  `ChatPanel`). The treasury page has `refunds` and `transfers` tabs; `refund-requests` and
  `payout-transfers` are rendered (no longer pending ids).
- **Page titles (design batch D4, on `main`):** `apps/web/tests/source-policy.test.ts` requires a
  `head()` with an i18n title on every route file under `apps/web/src/routes/**`, except its
  `PENDING_HEAD` list (B8-web's and B8-server's files only). Every route a batch 8 unit adds or
  edits keeps or adds one. Where D4 already added a `head()` to a file you edit, keep it.
- **Tofu:** production now requires `instance_origin` (no default) at stage 1.

## Waves

At most six units at a time. Two agents never write the same file at the same time.

| Wave | Units (parallel)                                                                       | Starts from                | Why this order                                                                                                                                                                                                                                                   |
| ---- | -------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | S1-b external, L1-observability, M1-gifts-refunds, M1-connect, B8-server, B8-web (6)   | the contract step's sha    | S1-b needs only S1-d. The two M1 units split by file once (B) has split the adapter and the webhook handlers. B8-server and B8-web need only (C).                                                                                                                |
| 2    | S1-h backups-ext, M1-coop-money, R0-release-prep, L1-status, B8-player, B8-harness (6) | `main` after wave 1 merged | S1-h and R0-release-prep edit `selfhost.sh` and the e2e after S1-b has merged. Coop payouts use M1-connect's transfers. L1-status builds on L1-observability's Grafana. B8-player and B8-harness touch the W3 player and harness files that wave 1 leaves alone. |

Agent track, beside both waves, once the user has created the staging project and token (U5):

- S1-d's managed-cluster check;
- S1-a's capacity sweep on dedicated droplets, for the production size;
- `failover` against managed clusters;
- S1-h's timed managed restore;
- the app-droplet rebuild time;
- after the milestone, R0 §3 on rc.3.
  Every droplet and cluster is tagged and destroyed at the end of each run.

## Path ownership

Final, as fixed by the briefs. Each brief also lists its read-only paths.

| Unit             | Owns (write only these)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1-b external    | `scripts/selfhost.sh` except the backup section (`parse_backup_flags`…`cmd_backup`); `scripts/selfhost/**` except `e2e-backup*`, `e2e-dump*`, `selfhost-backup.test.ts`, `e2e-metrics.ts`; `infra/selfhost/**`; `infra/quadlet/commonair-{postgres,valkey,migrate}*`; `infra/tests/selfhost-external*`, `infra/tests/selfhost-e2e-variants.test.ts`; `docs/self-hosting/{configuration,requirements,scaling}.md`                                                                                                                                                                                                                                                                                                                                                                                            |
| L1-observability | `infra/otel-collector/**`; `infra/prometheus/**`; `infra/grafana/dashboards/**`, `infra/grafana/provisioning/{dashboards,datasources}/**`; `infra/quadlet/commonair-{otel-collector,prometheus,grafana}*`; `docs/operators/monitoring.md`; `infra/tests/observability*`; `scripts/selfhost/e2e-metrics.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| M1-gifts-refunds | `services/api/src/money/checkout.ts`; `services/api/src/money/{stripe-refunds,auto-refund,receipt,refund-requests}.ts`; `services/api/src/money/stripe-events/refunds.ts`; `services/worker/src/money/{refund-reconcile,expire}.ts`; `services/worker/src/jobs/refund-reconcile.ts`; `packages/email/src/templates/receipt.tsx`, `packages/email/src/messages/locales/{en,es}/receipt.json`; `apps/web/src/components/treasury/refund-requests*`; `apps/web/src/i18n/locales/{en,es}/m1-money.json`; `harness/src/b8/money-refunds.ts`                                                                                                                                                                                                                                                                      |
| M1-connect       | `packages/payments/src/stripe-transfers.ts`; `packages/ledger/src/payouts.ts`; `services/api/src/money/{stripe-connect,transfers}.ts`; `services/api/src/money/stripe-events/transfers.ts`; `services/worker/src/money/transfers*.ts`; `services/worker/src/jobs/payout-transfers.ts`; `apps/web/src/components/treasury/payout-transfers*`; `apps/web/src/i18n/locales/{en,es}/m1-connect.json`; `harness/src/b8/money-connect.ts`                                                                                                                                                                                                                                                                                                                                                                         |
| B8-server        | `services/api/src/auth/index.ts` (the user-update hooks); `services/api/src/chat/surge.ts`; `services/api/src/federation/settings.ts`; `services/worker/src/federation/**`; `services/worker/src/exports/giveaways.ts`; `services/worker/src/moderation/sor-{build,schemas,deliver}.ts`; the `enforcementStatement` template in `packages/email/src/templates/trust.tsx` and its `staffAction` keys; `services/worker/src/jobs/{portability-incoming-cleanup,import-record-expiry}.ts`, `services/worker/src/portability/{incoming-cleanup,record-expiry}.ts`; `services/worker/src/twitch-import/**`; the channel section of `services/worker/src/portability/import/apply.ts`; `apps/web/src/components/twitch-import/**`; `apps/web/src/i18n/locales/{en,es}/n3-import.json`; `harness/src/b8/server.ts` |
| B8-web           | `apps/web/src/routes/_app/$channel.tsx`; `apps/web/src/components/channel/{panels,banner}*`; `apps/web/src/chat/interact/prediction-card.tsx`; `apps/web/src/routes/_admin/admin.moderation.tsx`, `apps/web/src/components/safety/mod-queue.tsx`; `apps/web/src/components/jury/**`; `apps/web/src/chat/replay/**`; `apps/web/src/components/giveaways/**` and the `verify.me` lines of `services/api/src/interact/giveaways/service.ts`; the `w3-jury`, `w3-giveaways`, `w3-predictions`, `w2-replay` and `b8-channel` namespaces; `harness/src/b8/web.ts`                                                                                                                                                                                                                                                 |
| S1-h backups-ext | `scripts/selfhost.sh` (the backup section); `scripts/selfhost/{e2e-backup,e2e-dump}*.ts`, `scripts/selfhost/selfhost-backup.test.ts`; `infra/postgres/{dump,dump-restore,dump-drill}.sh`; `infra/quadlet/commonair-{dump,drill}*`; `docs/self-hosting/{backups,managed-services}.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| M1-coop-money    | `services/api/src/coop/{membership,shares,patronage-payouts}.ts`; `services/api/src/money/stripe-events/shares.ts`; `services/worker/src/coop/patronage-payout*.ts`, `services/worker/src/jobs/patronage-payout.ts`; `apps/web/src/routes/_app/coop.membership.tsx`, `apps/web/src/routes/_app/coop.patronage.$periodId.tsx`, `apps/web/src/components/coop/{shares,patronage-payouts}*`; `apps/web/src/i18n/locales/{en,es}/m1-coop.json`; `harness/src/b8/coop-money.ts`                                                                                                                                                                                                                                                                                                                                  |
| R0-release-prep  | `scripts/selfhost/e2e.ts`, `scripts/selfhost/e2e-from-release.ts`; `docs/self-hosting/**` except S1-h's two pages; `CHANGELOG.md`; `scripts/release/changelog.ts`; `docs/operators/flakes.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| L1-status        | `infra/status/**`; `infra/tofu/digitalocean/modules/instance/monitoring.tf`, `monitoring-cloud-init*` and the monitoring variables in `variables.tf`; `infra/grafana/provisioning/alerting/**`; `docs/operators/{incidents,on-call,status-page}.md`; `infra/tests/status*`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| B8-player        | `apps/web/src/player/room-sync*`, `apps/web/src/player/dvr*`, the switch handling in `apps/web/src/player/heartbeat.ts`; `services/chat/src/watch-rooms/**`, `services/chat/src/watch-rooms.ts`; the DVR lines of `services/api/src/routes/playback.ts`; `harness/src/w3/{watch-rooms,dvr-relay}/**`; `harness/src/b8/player.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| B8-harness       | `harness/scenarios/{e2e-relay,clock-skew,relay-dvr}.ts`; `harness/src/web/flows.ts`; `harness/src/w3/jury.ts`; `harness/tests/b8-harness*`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Every unit also owns the new test files named after its own files. Each unit regenerates its own
`apps/web/src/i18n/keys/<ns>.gen.ts`.

**Orchestrator only:**

- `packages/{contracts,db,config,tokens}/**`, `packages/ledger/src/rules.ts`,
  `packages/payments/src/{adapter,stripe-client,stripe,stripe-events,factory}.ts`,
  `packages/service/src/valkey.ts`, `packages/email/src/registry.ts`.
- `services/api/src/money/{stripe-events,stripe-webhook}.ts` (the dispatch), and
  `services/worker/src/b7/outbox-jobs.ts`.
- `apps/web/src/components/coop/treasury-tabs.tsx`.
- `infra/tofu/digitalocean/envs/**`, `infra/postgres/**` (part (A)).
- `services/worker/src/jobs/index.ts` and `services/worker/src/outbox.ts`.
- `apps/web/src/chat/chat-panel.tsx`, `keys/index.gen.ts`, `core.json`.
- `.env.example`, `compose.yaml`, `infra/image-licenses.json`, `.github/**`, `scripts/release/**`
  (apart from `changelog.ts`), `REUSE.toml`, the `package.json` files and `bun.lock`.
- `harness/src/{shards,registry,kit,platform}.ts`, `harness/src/b8/steps.ts`,
  `harness/src/w3/steps.ts`, and `harness/src/seed/routes.ts` (decision (p)).
- ADRs, PROGRESS, READMEs, and the legal drafts in `packages/db/src/legal/**`.

Conflicts checked:

- **`selfhost.sh`:** S1-b has it in wave 1 and S1-h in wave 2, on different sections, as R0-b and
  R0-c did in batch 1.
- **The e2e:** S1-b owns `e2e.ts` in wave 1 and R0-release-prep in wave 2. S1-h writes
  `e2e-dump.ts` and L1-observability writes `e2e-metrics.ts`. The orchestrator wires both in at
  merge.
- **Money:** contract part (B) splits the adapter, the client and the webhook dispatch first, so
  M1-gifts-refunds and M1-connect each fill their own files. They write separate namespaces
  (`m1-money`, `m1-connect`) and separate treasury tabs.
- **`selfhost.sh`'s timers:** S1-h's timer install calls inside `install_units` (S1-b's section,
  merged) are a contract request applied at merge.
- **`docs/self-hosting/configuration.md`:** S1-b in wave 1, R0-release-prep in wave 2.
- **The B8 harness steps:** each unit writes its own `harness/src/b8/<unit>.ts`. Only the
  orchestrator writes `steps.ts`, and only B8-harness writes the scenario files it splits.
- **The email catalogs:** M1-gifts-refunds writes `receipt.json`, and B8-server writes the
  `enforcementStatement` keys. These are different files.
- **Grafana:** L1-observability owns `infra/grafana/**` in wave 1. L1-status takes only
  `provisioning/alerting/**` in wave 2.
- **The W3 harness steps:** B8-player owns `harness/src/w3/{watch-rooms,dvr-relay}/**`.
  B8-harness owns the scenario files that run them, and `harness/src/w3/jury.ts`.

## Shared rules

The same as batch 7 (`batch7/README.md` "Shared rules"):

- one worktree and branch per unit;
- implement, then an independent review, then a fix pass;
- targeted checks only (`_done-means.md`), and never `bun run verify`, `verify:full`, harness
  scenarios, `podman compose` or image builds locally;
- contract requests as exact diffs;
- AGENTS.md's data rules.

Branches: `s1/b-external`, `l1/observability`, `m1/gifts-refunds`, `m1/connect`, `b8/server`,
`b8/web`, `s1/h-backups-ext`, `m1/coop-money`, `r0/release-prep`, `l1/status`, `b8/player`,
`b8/harness`.

Batch 6 and 7 lessons bind every unit:

- merge by commit sha, and check each merge landed;
- raw-SQL timestamps go through `harness/src/w2/sql-time.ts`, and arrays through `sql.array`;
- read env through `loadEnv`;
- harness expectations follow the seeded defaults (the batch 7 flags are all off);
- `vp fmt` every touched file, and write `es` with every `en` key.

Money:

- integer cents;
- every ledger write balances under the triggers;
- every treasurer action writes `audit_log`;
- every side effect writes its outbox event in the same transaction;
- no personal data in ledger memos.

## Milestone checks (batch 8 done means)

- **S1 stage 1 (launch-critical, U4):**
  - S1-d's no-superuser integration test passes in CI, with the monitor role, the owner-only
    restore and private-CA TLS.
  - The self-host e2e keeps its bundled default runs (install, upgrade, WAL-G backup, rollback)
    green in CI, unchanged.
  - It also gains an external-services variant: no-superuser Postgres with TLS, Valkey with an ACL
    user and with the password-only default user over TLS, and Garage as the external S3. It runs
    as a CI job, and install, upgrade, backup (a logical dump) and the dump drill pass.
  - `status`, backups, drills and metrics are checked in both modes. Switching modes is refused
    with a clear message.
  - The self-hosting docs present bundled as the default and managed services as the option.
  - `docs/self-hosting/managed-services.md` exists and matches the tofu module.
  - The agent track (U5) has run, and the results are recorded in ADR 0032:
    - S1-d's check against a real managed cluster;
    - a timed restore into a fresh managed cluster;
    - `failover` against managed clusters;
    - a timed app-droplet rebuild.
- **M1:**
  - `e4b-money` gains these steps:
    - a second gift inside the window is refused;
    - an ended subscription's late charge refunds;
    - a refund that times out shows "outcome unknown" and reconciles;
    - a payout run creates Connect transfers on stripe-mock;
    - a reversed transfer returns to the payable;
    - the receipt email lands in Mailpit.
  - `e5-coop` gains a Stripe share purchase and a patronage payout.
  - The ledger balances in every step, and the database security review of `0049` is done.
- **L1 engineering:**
  - Host, Postgres and Valkey metrics appear in Prometheus on the harness stack, and remotely in
    the external-state e2e (`e2e-metrics.ts`).
  - Dashboards are provisioned, with a test that every panel's query names a metric that exists.
  - Alert rules pass `promtool check rules` in a test.
  - The status page renders from probes, and an outside-in outage mail goes out with the app
    droplet down.
  - The runbooks are in `docs/operators/`.
- **R0:**
  - The e2e `--from-release v0.1.0-rc.2` passes, or what blocks it is recorded with a decision.
  - The flake log (`docs/operators/flakes.md`) shows ten green `main` runs.
  - The `v0.1.0` changelog is written.
  - The self-hosting docs are current.
  - Then, per U2: rc.3 is cut from the commit with a green full dispatch run, the agent track runs
    R0 §3 on the staging project (U5), the user does the visual checks on rc.3 (U3), and `v0.1.0`
    is tagged from the same commit. `ROADMAP.md` says Phase 1 shipped.
- **Follow-ups:**
  - Every B8 step passes with `PENDING_B8_*` empty, and `docs/testing/b8-selectors.md` is checked
    by `apps/web/tests/selectors.test.ts`.
  - Every new route is in `SEED_ROUTES`. `es` is at 100%, and the `en-XA` scan is clean on the
    pages it visits.
- **Shards:** every shard is under ~12 min, `relay` and `clock` included (decision (o)).
- **Docs:**
  - the ADR 0014, ADR 0007 and ADR 0032 amendments are written;
  - privacy and terms drafts cover the receipt email, Connect payouts and share purchases, marked
    "not reviewed by counsel (none retained)";
  - `PRIVACY_SEED_VERSION` and `TERMS_SEED_VERSION` are bumped.
- **End of batch:** CI green on `main` with every job, on a push run and a full
  `workflow_dispatch` run, and PROGRESS written.

## Batch 6 and batch 7 follow-ups

| Follow-up                                                                                   | Evidence                                                                                                                                                                           | Owner / outcome                                                            |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Better Auth clears a lapsed ban at sign-in with no `channel.suspension` event               | no auth hook writes an event when the admin plugin clears a lapsed ban (`services/api/src/auth/index.ts:203-209`, `:252-286`); PROGRESS "Batch 7 contract step merged", open items | B8-server (decision (g))                                                   |
| Giveaway entries and wins missing from the data export                                      | `services/worker/src/exports/collectors.ts:909-912` (`interact.json` has no giveaway section)                                                                                      | Contract step registers the section; B8-server fills it                    |
| A moderator restarting a raid surge drops `raid` from the banner                            | `services/api/src/chat/surge.ts:111-116` rewrites the override without `raid`                                                                                                      | B8-server                                                                  |
| Jury flag → case link                                                                       | `mod-queue.tsx:55-57` keeps the selection in local state; W3-jury review MEDIUM 4                                                                                                  | B8-web                                                                     |
| Giveaway CR9 (the verify page marks your entry on any giveaway) and CR10 (winner usernames) | W3-giveaways fix report, CR9 and CR10                                                                                                                                              | CR9: B8-web. CR10: declined (decision (n))                                 |
| Prediction betting in the grace window from the web                                         | `prediction-card.tsx:142,204` (bets only while `active`); W3-fair-predictions request 3                                                                                            | B8-web; contract step passes `channel`                                     |
| Watch-room `edgeWallclock`                                                                  | not in contracts; W3-watch-rooms review MEDIUM 1                                                                                                                                   | B8-player                                                                  |
| Per-field Twitch import choices                                                             | `ImportChoices` has only `channel: boolean` (N3-import request 5)                                                                                                                  | B8-server; contract step adds `fields`                                     |
| Imported panels (and the banner) on the channel page                                        | `$channel.tsx` renders neither (N3-import request 6; web-gaps note "the channel page does not show the banner")                                                                    | B8-web                                                                     |
| `federation.actor.disabled` / `channel.federation` events                                   | `services/api/src/federation/settings.ts:85,216` (`sendActorDelete` from the API)                                                                                                  | B8-server (decision (h))                                                   |
| Relay DVR when a relay leaves mid-session                                                   | W3-dvr-relay review, request 8 (403 until the next start; fails safe)                                                                                                              | B8-player (`dvrSwitchTo`)                                                  |
| B7 CR6: the staff-action facts variant for statements of reasons                            | B7-followups finding 1: the email cites `MC-…`, a case that does not exist                                                                                                         | Contract step (schema); B8-server                                          |
| Failed or abandoned import archives in `incoming/portability/`                              | `portability/import/index.ts:93-96` deletes only after a successful apply                                                                                                          | B8-server (decision (i))                                                   |
| Should the Twitch import record expire?                                                     | `packages/db/src/schema/b7.ts:153-155` keeps the public Twitch data (user name included)                                                                                           | B8-server; yes, after 30 days (decision (j))                               |
| Jury cleanup on same-stack reruns                                                           | W3-jury fix report: cleanup only for panels whose seats are all harness members                                                                                                    | B8-harness                                                                 |
| Seeding `giveawayId` / `moveLinkNonce`                                                      | contract review, "Left for the orchestrator"                                                                                                                                       | The seed-full session (decision (p)); not a B8 unit                        |
| The harness host cannot resolve `host.containers.internal`                                  | contract review                                                                                                                                                                    | Handled by N3's `page.route`; nothing to do                                |
| Shard times: `relay` 13m60s and `clock` 12m49s, each a single scenario                      | `harness/src/shards.ts:11-15`                                                                                                                                                      | B8-harness; orchestrator updates `shards.ts` (decision (o))                |
| Replay deep seek starts a fresh span (batch 6)                                              | `apps/web/src/chat/replay/model.ts:10-13`                                                                                                                                          | B8-web                                                                     |
| P2P bytes in attestations v2 (batch 6)                                                      | `packages/tokens/src/attestation.ts:66` (`v` is a literal 1); P2P bytes are client-reported (`controller.ts:840`)                                                                  | ADR 0014 Amendment 1 in the contract step; build in batch 9 (decision (m)) |
| `RATE_LIMITED_FORM_ERROR` English only (batch 5)                                            | `harness/src/web/flows.ts:36`                                                                                                                                                      | B8-harness                                                                 |

**Carried, not scheduled** (older open items; pick up when a unit touches the file):

- R0-d's optional compose `depends_on` change.
- An `IRC_LISTEN=systemd` opt-in.
- S1-a's requests 1 and 3: the harness env move, and an `inconclusive` status.
- A `PREDICTION_RULES.maxBetPoints` constant.
- The OAuth token endpoint accepting query parameters.
- Signed-out OAuth `state` values that parse as JSON.
- `send-verification-email` answers 500 when SMTP fails.
- Reports to file upstream: p2p-media-loader `updatePlaylist` on LL-HLS URLs, and gortsplib
  dropping an early sender report.
- The DigitalOcean firewall's TURN relay range.

## Briefs

Written 2026-11-02, in the order of the [Waves](#waves):

- Contract step: [`b8/contract-step.md`](../b8/contract-step.md), parts (A)–(D).
- Wave 1:
  - [`s1/S1-b-external.md`](../s1/S1-b-external.md)
  - [`l1/L1-observability.md`](../l1/L1-observability.md)
  - [`m1/M1-gifts-refunds.md`](../m1/M1-gifts-refunds.md)
  - [`m1/M1-connect.md`](../m1/M1-connect.md)
  - [`b8/B8-server.md`](../b8/B8-server.md)
  - [`b8/B8-web.md`](../b8/B8-web.md)
- Wave 2:
  - [`s1/S1-h-backups-ext.md`](../s1/S1-h-backups-ext.md)
  - [`m1/M1-coop-money.md`](../m1/M1-coop-money.md)
  - [`r0/R0-release-prep.md`](../r0/R0-release-prep.md)
  - [`l1/L1-status.md`](../l1/L1-status.md)
  - [`b8/B8-player.md`](../b8/B8-player.md)
  - [`b8/B8-harness.md`](../b8/B8-harness.md)

Per-unit reviewer focus is in [`HANDOFF.md`](HANDOFF.md).

## Open items

For the user (nothing here blocks the contract step):

- **Create the staging-only DigitalOcean project and a `doctl` token scoped to it** (U5). The
  project has a spending cap, and the token must not reach production. Until it exists, the agent
  track waits. That track covers S1-d's managed check, the timed managed restore, `failover`,
  S1-a's sweep and R0 §3. Stage 1 cannot be called launch-ready without it.

- The visual checks of batch 7's pages under `en`, `es` and `en-XA`, at 320 px, in dark and light,
  keyboard only. They carry over from the batch 7 README "Open items".
- A real-Helix smoke test before the Twitch import is turned on.
- A real Mastodon follow against staging before federation is turned on.
- The visual checks on each release candidate (U3), starting with rc.3.
- The L1 items that are the user's own:
  - the legal entity, a DMCA designated agent and real contacts in `instanceSite()`;
  - CSAM hash lists and their agreements;
  - moderation staffing and on-call;
  - the egress budget that triggers stage 3 (ADR 0032, "Still open");
  - an external security review.

## Post-launch review

These were decided without counsel. Revisit them before L1 or soon after. Carried from batch 7:

- Sweepstakes rules for giveaways, and the official-rules draft.
- The Twitch Developer Agreement, the trademark naming on the import page, and re-hosting emote art
  on the streamer's assertion.
- Watch rooms for minors (ADR 0017: OSA children's duties, DSA Art. 28).
- The jury's exposure of members to moderated content, and its advisory status under DSA/OSA.
- Federation privacy: remote followers' handles, `Delete` limits, the follower count in exports.
- Portability: refunds on a move (still unbuilt, decision (e)); the standing statement's content.
- From batch 6: the payee or contractor status of split recipients; the draft privacy sections
  (W2 `2026-11-01-w2-draft`, N1 `2026-10-30-notifications-draft`, batch 7's drafts); DSA
  statements of reasons, and whether to submit them to the Commission's Transparency Database
  (ADR 0019:354).
- From batch 2:
  - the DMCA flow and its numbers (3 strikes in 365 days, restore after 12 weekdays, claimant
    name shown, counter-notice data kept, 395-day consent retention);
  - the EU lawful basis for default-on P2P (`P2P_DEFAULT=off` until then);
  - a suspended, signed-out user can appeal only by email.

New in batch 8:

- **Tax details for Connect payout recipients** (decision (f)) must be decided before any live
  payout: tax-form collection, reporting thresholds, and whether recipients are payees or
  contractors.
- **Launching at stage 1** (U4): DigitalOcean as the processor of the whole database, including its
  backups' region and retention in the privacy notice; and the cost of four database nodes against
  the co-op's budget.

- Connect transfers on stripe-mock only: payee status, tax forms and money transmission before
  any live key (decisions (b), (f)).
- Auto-refunds and "outcome unknown" (ADR 0007): the refund wording in the terms draft.
- Share purchases by card: whether bylaws and securities rules allow card payment for co-op shares.
  The manual default stays.
- The payment receipt email's content (a tax receipt or not, by jurisdiction).
- Twitch import data kept 30 days (decision (j)).
- P2P bytes shown as client-reported in attestations (decision (m)).
- Launching with no age-assurance adapter, on the default policy that prohibits explicit sexual
  content (ADR 0006:289-292).

Reported by the wave 1 units (merged 2026-11-03; conservative defaults, each revisitable):

- **S1-b external:** both database and Valkey URLs are required together; a Valkey repoint is
  allowed with a warning; a Valkey password is always required; `reset-staging` and seed mode are
  refused in external mode; the owner's and Valkey's passwords live only in Podman secrets; a pooler
  (PgBouncer) is documented as untested; only `sslmode=require` or `disable` are accepted as
  insecure modes (`verify-ca` refused, not mapped); weakening a URL silently drops its CA.
- **L1-observability:** scrape failures and no-data alerts are tickets, only the burn rates page;
  30-day egress and availability figures are projected from an average rate; one collector carries
  OTLP and state metrics, so a bad monitor setting stops all telemetry (selfhost.sh validation is
  the guard); the stage 0 budget alert watches one rolling 30-day window; dev compose falls back to
  a `not-configured` monitor password; the monitor password stays in a libpq URL (hex only);
  staging keeps `SLO_TARGET` 0.995, production 0.999.
- **M1-gifts-refunds:** 15 min resolve grace, 15 min before the sweep refunds a booking, 5 min
  after a timeout before asking Stripe; a refund failure with no known amount releases nothing; a
  listed automatic refund never sent stays outstanding (not blocking) until settled; one
  automatic attempt (a 4xx is not retried); at most one receipt, not retried after its claim; the
  receipt links `/settings/subscriptions`; the sweep's "booked after end" heuristic (10 s before
  the subscription's `updated_at`) until a durable mark exists.
- **M1-connect:** readiness from the stored `payouts_enabled` flag, not a live account check; a
  transfer that may have reached Stripe is never cancelled (it stays `outcome_unknown` for a
  person); no re-send after 20 h for such rows; orphaned transfers are audited only, with no
  automatic clawback; a payee held before a row opens keeps the payout held; the payout-sent mail
  is best effort.
- **B8-server:** a never-started Twitch preview is kept 30 days after `created_at`; the
  record-expiry audit row is written on every run; the incoming cleanup also fails abandoned
  previews as `archive_missing`; the staff-action email and `nothing_to_apply` wording (`en`,
  `es`).
- **B8-web:** a mature channel's banner stays hidden until the viewer confirms 18+, even offline;
  a report flag opens the reports tab with nothing selected; the prediction grace offer uses the
  client's clock (the server judges every bet).

Reported by the wave 2 units (merged 2026-11-03; conservative defaults, each revisitable):

- **S1-h backups-ext:** 30 dumps kept, never fewer (`BACKUP_DUMP_KEEP` may only raise it); dumps
  share the object backup bucket under `<prefix>/dumps`; a bucket listable or readable without a
  key is refused, and objects get no explicit private ACL (Garage's ACL handling is uncertain);
  the WAL-G drill timer is on for every bundled install (Saturdays, twice the data volume's disk);
  every reinstall and upgrade turns the drill timers back on, as `commonair-backup.timer`; on
  external state the dump timers are on from install, before a dump store exists (failures show
  in the journal and `status`); on bundled state the dump drill's timer turns on after its first
  pass; the moving procedure gets past S1-b's refusal by adding `STATE_MODE=external` by hand;
  its six units live in `infra/systemd/`, not `infra/quadlet/` (Quadlet does not process timers;
  accepted at merge).
- **M1-coop-money:** a card share refunds only in full and only once `refund_pending` (a partial or
  dashboard refund books nothing and is audited); chargebacks on card shares are not handled
  yet; the manual confirm is unchanged and "left during checkout" applies to card shares only;
  the two patronage approvals are audit markers with no expiry; any reversal ends the row, and a
  second partial reversal after the follow-up is paid stays in the payable; a Connect row whose
  outcome is unknown is never re-sent automatically, its follow-up is always manual, and one
  marked paid by hand is recorded even if the account was deleted since; manual references have
  no spaces (no names); no automatic `distributed` flip and no tax forms (decision (f)); a failed
  `instance.info` read hides "Pay by card"; the card share's processor fee is the co-op's expense
  (posted at merge).
- **R0-release-prep:** the from-release e2e seeds through the release's own db and ledger code,
  not the HTTP API (ALTCHA, no inbox, no treasurer session; the follower count is read back
  through the API); it runs only on `workflow_dispatch`, bundled only, from v0.1.0-rc.10 (rc.2 to
  rc.9 cannot upgrade to this tree with their own `selfhost.sh`: the collector's monitor secrets,
  and nothing runs them); a 600 s upgrade health timeout; `--check` refuses an undated release
  section, so the date is set by hand at tag time; verifying.md says a manual run on a tag ref
  would also match the signing identity.
- **L1-status:** the canaries are Quad9 and Cloudflare anycast DNS over TCP (connect only); video
  is probed through the origin's readiness, not a synthetic channel; the inside alert route is
  rendered from a template; maintenance mutes every outside alert, recoveries included; degraded
  to down waits for the same 10-minute window; "probes not reporting" after 5 minutes, also when
  the monitoring droplet's Prometheus fails (those runs use the droplet's clock); 10 s connect,
  20 s idle and 60 s total delivery budget (a mail accepted after it may be sent again); a failed
  note file is skipped, links in notes keep only their text; the site name defaults to the
  origin's host; the page is `en` or `es`, alert mails English only; the AAAA record only after a
  `curl -6` check; an expired certificate shows as website and certificate down; re-provisioning
  loses the 90-day history; a dead monitoring droplet is noticed only by a daily look at the page;
  `/readyz/api` and `/readyz/origin` are public and unauthenticated (pass or fail only, no rate
  limit yet).
- **B8-player:** `EDGE_SKEW_MS` = 1 s (a reported edge at most 1 s ahead of chat's clock; beyond
  that rooms fall back to the batch 7 estimate); a paused DVR viewer is swapped without playing
  and stays paused; a rewind still loading when `dvrSwitchTo` arrives falls back to live; the
  switch owed after data mode is cleared on the first beat with a plain origin token, and dropped
  if the DVR grant is no longer allowed; `edge-sync` models two sources by 3 s and 9 s hold-backs.
- **B8-harness:** the jury marker is a constant written only into harness-seeded rows'
  `resolution_note` and `details`; a panel is deleted only when it sampled a marked case and
  seated an `e5_jury_` member; a locale with no catalog entry matches the English rate-limit
  message, with a warning in the run's log.
