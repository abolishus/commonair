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

**Status: draft.** The rows marked **OPEN** in [Decisions](#decisions) are the user's. The
contract step and the unit briefs are written only after the user answers them (see
[Briefs to write](#briefs-to-write)).

## What is done, and what is left (checked on `main` at `43ae60dc`)

| Milestone | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R0        | **Code done, release not cut.** R0-a to R0-g are merged (PROGRESS "Batch 1": waves 1–3). The table there still says "brief ready" for R0-c to R0-f, but the wave 2 and 3 sections record their merges. Only `v0.1.0-rc.1` and `v0.1.0-rc.2` are tagged (`git tag`). Left: the real-server checks of `R0-release.md` §3, rc.3 and `v0.1.0`. `ROADMAP.md:13` still says Phase 1 is "in progress".                                                                                                                                                                          |
| S1        | **Stage 0 tooling done; stage 1 not built.** S1-a, S1-c and S1-g are merged, and ADR 0032 was accepted on 2026-10-27. `selfhost.sh` has no external Postgres or Valkey option: its option parser (`scripts/selfhost.sh:1632-1684`) has only `--s3-*` for external services. `docs/self-hosting/managed-services.md` does not exist. S1-d, S1-b and S1-h are open. S1-f is for stage 2 and S1-e for stage 3, and neither is due yet.                                                                                                                                      |
| M1        | **Not started.** The gift window is still `PAYMENT_PENDING_DAYS`, default 7 (`packages/config/src/env.ts:234`), and there is no one-open-gift rule (ADR 0007:22-29). The repository has no "outcome unknown" refund state. `StripeClient` has refunds and Express onboarding but no transfer (`packages/payments/src/stripe-client.ts:57-71`). `buyShare` refuses with `manual_shares` (`services/api/src/coop/membership.ts:238`). There is no receipt email: `packages/email/src/templates/payments.tsx` has only `payoutSent` (`:16`) and `chargebackNotice` (`:49`). |
| P1        | **Done in batch 2** (P1-tracker, P1-turn, P1-player). Left: P2P bytes in attestations, which first need an ADR 0014 amendment (see below). `P2P_DEFAULT` stays `off` (`packages/config/src/env.ts:418`).                                                                                                                                                                                                                                                                                                                                                                 |
| L1        | **The user's, with engineering gaps.** The collector receives OTLP only (`infra/otel-collector/config.yaml:15-21`), so there are no host, Postgres or Valkey metrics (ADR 0032 §6, `:166-176`). `infra/grafana/dashboards/` holds only its README, which says it is "intentionally empty". `infra/prometheus/prometheus.yml` has no `rule_files`. No status page exists (`L1-public-instance.md:37-38`). E7 is done: the only `notImplemented` left in `services/api/src` is its definition in `lib/errors.ts`.                                                          |

## Units and gates (checked against `main` at `43ae60dc`)

Twelve units in two waves, after one contract step. The briefs are not written yet. The paths are
the planned ownership, and the briefs fix them.

| Unit                 | Wave | Gated on                                              | State on main (evidence)                                                                                                                                                                                                                                                                                                                         | Builds                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | ---- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1-d (contract step) | 0    | R0-b (merged)                                         | ADR 0032 §3 says no superuser or extension is needed, and that S1-d proves this before S1-b ships (`docs/decisions/0032-scaling-and-availability.md:120-128`). The app role is applied "as the database owner" (`infra/postgres/app-role.sql:4-5`). No test runs migrations as a non-superuser.                                                  | An integration test: migrations, `0001`–`0047` triggers and the app role, all applied by a CREATEROLE owner on a Postgres with no superuser and `sslmode=verify-full`. A `commonair_monitor` role (`pg_monitor`) for L1-observability. The restore role that ADR 0032 §4 needs (`SET` on `session_replication_role`).                                                                                                                                              |
| S1-b external        | 1    | S1-d                                                  | No `--database-url` or `--valkey-url` (`scripts/selfhost.sh:1632-1684`). The secrets exist (`:1266-1272`), but only for the bundled services.                                                                                                                                                                                                    | `selfhost.sh --database-url/--valkey-url` with TLS (`verify-full`, `rediss://`). The bundled Postgres or Valkey units are not installed when external. `status` checks the remote. `upgrade` keeps the choice and runs `migrate` once. A self-host e2e external-services variant: Postgres with no superuser and TLS, and Valkey with an ACL user and TLS, each outside the instance's network. It also checks that BullMQ issues no `CONFIG`/`ACL` (ADR 0032 §3). |
| S1-h backups-ext     | 2    | S1-b                                                  | `docs/self-hosting/backups.md:349` restores WAL-G only. ADR 0032 §4 (`:142-157`) asks for a logical dump and a drill.                                                                                                                                                                                                                            | `selfhost.sh backup` with an external Postgres: a nightly `pg_dump` to the operator's bucket, keeping 30. A drill restores into a scratch database with triggers disabled, then checks counts (`follower_count` against `follows`). The WAL-G drill also runs on a timer. Writes `docs/self-hosting/managed-services.md`, with DigitalOcean as the worked example.                                                                                                 |
| L1-observability     | 1    | the contract step's monitor role                      | Receivers are OTLP only (`infra/otel-collector/config.yaml:15-21`). No dashboards. No alert rules.                                                                                                                                                                                                                                               | Host, Postgres and Valkey metrics (the collector's `hostmetrics`, `postgresql` and `redis` receivers, or exporters vetted by ADR 0002/0022). Grafana dashboards for every ADR 0032 trigger and the availability target. Prometheus alert rules at 80% of each trigger, plus an SLO burn rule, checked with `promtool` in a test. Writes `docs/operators/monitoring.md`.                                                                                            |
| L1-status            | 2    | L1-observability                                      | No status page (`L1-public-instance.md:37-38`). No alert route.                                                                                                                                                                                                                                                                                  | A public status page on the monitoring droplet: blackbox probes from the second region, rendered to a static page (decision (k)). Grafana alert contact points (SMTP through the instance relay, plus a webhook). The tofu monitoring droplet's cloud-init. Runbooks: `docs/operators/{incidents,on-call,status-page}.md`.                                                                                                                                         |
| M1-gifts-refunds     | 1    | ADR 0007 decisions 1–3; the contract step's schema    | The window is 7 days (`env.ts:234`). There is no one-open-gift constraint and no `outcome_unknown` state. No receipt template (`payments.tsx`).                                                                                                                                                                                                  | ADR 0007 decision 1: one open unpaid gift per gifter per channel (`CONFLICT`), and gift payments expire after 24 h. Decision 2: auto-refund money collected for an ended subscription, with a ledger reversal. Decision 3: "outcome unknown" for refund calls, with a reconciliation job and a treasurer view. The payment receipt email with the `PaymentBreakdown` lines (batch 4 decision).                                                                     |
| M1-connect           | 1    | ADR 0007:52-54; W2-splits (merged)                    | Payout runs record `provider: stripe` and move nothing (ADR 0007:52-54). There is no transfer call (`stripe-client.ts:57-71`, `adapter.ts:70-86`). Express onboarding exists (`services/api/src/money/stripe-connect.ts`).                                                                                                                       | Connect transfers per recipient at payout, with ledger postings, and failure and reversal (`transfer.reversed`) handling, on stripe-mock. The manual adapter stays the default.                                                                                                                                                                                                                                                                                    |
| M1-coop-money        | 2    | M1-connect; ADR 0020                                  | `buyShare` answers `manual_shares` (`membership.ts:238`). Patronage payables have no payout path.                                                                                                                                                                                                                                                | Stripe Checkout for co-op shares, with ledger postings and refunds per the bylaws. Paying patronage payables out: the manual adapter first, then Connect through M1-connect's transfer service.                                                                                                                                                                                                                                                                    |
| R0-release-prep      | 2    | S1-b merged (it owns the e2e in wave 1)               | The e2e upgrades between two builds of the same tree (`scripts/selfhost/e2e.ts:25-30`). It never starts from a published release. `CHANGELOG.md` and the self-hosting docs predate batches 2–7 (whisper, coturn, web push, federation, captions).                                                                                                | An e2e `--from-release <tag>` mode: pull a published, signed release from ghcr, install it, then upgrade to the candidate. Run first from `v0.1.0-rc.2`, then from every release. The `v0.1.0` changelog. A reading pass over `docs/self-hosting/**` for everything added since rc.2. The flake log for R0's "ten green main runs" rule.                                                                                                                           |
| B8-server            | 1    | the contract step's events and fields                 | See [Follow-ups](#batch-6-and-batch-7-follow-ups) for the evidence of each item.                                                                                                                                                                                                                                                                 | The lapsed-ban event at sign-in. Giveaway entries and wins in the data export. A raid surge keeps `raid` when a moderator restarts it. `federation.actor.disabled` and `channel.federation`. The B7 CR6 staff-action variant of statements of reasons. Cleanup of failed and abandoned `incoming/portability/` archives. Expiry of Twitch import data. Per-field Twitch import choices, worker and web.                                                            |
| B8-web               | 1    | the contract step's CR9 field                         | `$channel.tsx` renders neither panels nor the banner (no match for `panels` or `banner` in its 167 lines). `ModQueue` keeps its selection in local state (`mod-queue.tsx:55-57`). The prediction card bets only while `active` (`prediction-card.tsx:142,204`). The replay model's deep seek starts a fresh span (`chat/replay/model.ts:10-13`). | Panels and the banner on the channel page. A link from a jury flag to its case (`/admin/moderation` search parameters). Web betting during the 30 s grace. The replay deep seek keeps its loaded span. Giveaway CR9: the verify page marks your entry on any giveaway.                                                                                                                                                                                             |
| B8-player            | 2    | the contract step's `edgeWallclock` and `dvrSwitchTo` | `edgeWallclock` does not appear in `packages/contracts/src` or `apps/web/src`. After a relay leaves the active set, the player's DVR URL stays on the relay and answers 403 until the next start (W3-dvr-relay review, request 8).                                                                                                               | Room sync uses `max(edgeWallclock)` as the edge (W3-watch-rooms review MEDIUM 1). A heartbeat `dvrSwitchTo` moves a DVR session from a departed relay to the origin.                                                                                                                                                                                                                                                                                               |
| B8-harness           | 2    | none                                                  | `relay` is 13m60s and `clock` 12m49s, both single scenarios over the ~12 min cap (`harness/src/shards.ts:11-15`). `RATE_LIMITED_FORM_ERROR` is English only (`harness/src/web/flows.ts:36`). The jury rerun cleanup covers only panels whose seats are all harness members.                                                                      | Split `e2e-relay` into two scenarios (the relay base, then DVR, purge and `.vtt`), and trim `clock-skew` under the cap. Match the rate-limit message through the catalog, not English. Clean up the jury on same-stack reruns.                                                                                                                                                                                                                                     |

**Not in batch 8:**

- S1-f (stage 2) and S1-e (stage 3): their triggers are not near (S1 "Order" 3).
- N2's Arabic (ADR 0029 decision 5, "next").
- The ADR 0033 SeaweedFS spike.
- P2P bytes in attestations v2: the contract step writes only the ADR 0014 amendment (decision (m)), and the build waits for it to be accepted.
- Anything that needs live money, a legal entity or real users.

## Decisions

Rows marked **OPEN** are the user's to answer before the contract step. "Orchestrator" rows are
defaults recorded as decided, and the user may reopen any of them. **There is no counsel**
(batch 7 decision (h)). Every counsel-like call below takes the conservative default and is
listed under [Post-launch review](#post-launch-review).

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Who          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| U1  | **OPEN: what leads batch 8?** Proposed: launch readiness leads. That means S1 stage 1 (S1-d, S1-b, S1-h), L1's engineering (observability, status page) and R0's release prep, with M1 on stripe-mock and the follow-ups beside them. The alternative is to drop M1 (three units) to a later batch and keep this batch on launch only.                                                                                                                                                                                                              | user         |
| U2  | **OPEN: where is `v0.1.0` cut from?** (a) Proposed: rc.3 from `main` once batch 8's dispatch run is green, installed fresh on the staging droplet and through R0 §3, then `v0.1.0` from the same commit. (b) `v0.1.0` from `v0.1.0-rc.2` (`8b8a0a2`), which is already verified on the droplet, then `v0.2.0` from `main`. (b) ships a release without batches 2–7. The 2026-10-26 note "E7 ships in `v0.2.0`" predates those batches merging.                                                                                                      | user         |
| U3  | **OPEN: release cadence after `v0.1.0`.** The plan says "one minor per milestone batch, patch releases for R0-class fixes" (`next/README.md`, "Shared decisions"). Batches now land about daily. Proposed: a minor per batch only after its dispatch run is green **and** the user has done the batch's visual checks. Patches as before.                                                                                                                                                                                                           | user         |
| U4  | **OPEN: the launch stage of our own instance.** Proposed: launch at stage 0 (one dedicated-vCPU droplet, ADR 0032), with S1-b and S1-h built and tested so stage 1 is ready before its trigger fires. The alternative is to launch at stage 1, on managed Postgres and Valkey, from day one (more cost, a failover in minutes).                                                                                                                                                                                                                     | user         |
| U5  | **OPEN: who drives the real servers.** R0 §3 needs real droplets: the restore onto a second droplet (timed), a forced ACME renewal, Fedora 42 with SELinux enforcing, arm64 and a rollback. So do S1-a's capacity sweep on dedicated droplets and S1's `failover`. Proposed: the user runs them, or grants an agent a `doctl` token scoped to staging (ADR 0025 decision 5). Then the production region (NYC3 or FRA1) and the droplet size come from S1-a's numbers.                                                                               | user         |
| U6  | **OPEN: accept ADRs 0037–0039.** They are still "proposed" (`docs/decisions/0037-portability.md:8`, `0038-advisory-jury.md:8`, `0039-fair-draws-predictions-raids.md:8`). That includes ADR 0039 §3's wording: bettor standing only where the instance measures verified watching. B8-web's grace betting and B8-server's export rows build on them.                                                                                                                                                                                                | user         |
| a   | **The contract step does S1-d itself.** S1's plan makes it the orchestrator's (`packages/db/**`, `infra/postgres/**`). If a trigger needs a superuser after all, S1-b is re-planned before wave 1 rather than shipped around it.                                                                                                                                                                                                                                                                                                                    | orchestrator |
| b   | **M1 runs on stripe-mock only. No live keys, ever, in this batch** (`M1-money-follow-ups.md`, "Hard gate"; counsel-like). stripe-mock is stateless, so failure paths (a transfer reversal, a refund timeout) are driven by signed local webhook events and injected adapter faults, as E4b did (ADR 0003 D1).                                                                                                                                                                                                                                       | orchestrator |
| c   | **The ledger rule changes go through the contract step**: transfer postings, the refund reversal and share purchases. A database security review of the new triggers follows, as `0002_protections_hardening.sql` had. Migrations `0048_b8.sql` and `0049_b8_protections.sql`.                                                                                                                                                                                                                                                                      | orchestrator |
| d   | **Gift window:** a new `GIFT_PAYMENT_HOURS` (default 24) applies to gift payments only. `PAYMENT_PENDING_DAYS` keeps the rest. One open unpaid gift per gifter per channel is a partial unique index, with an application `CONFLICT` in addition (rule 9).                                                                                                                                                                                                                                                                                          | orchestrator |
| e   | **Refunds on a portability move stay unbuilt** (batch 7 decision (m)). The move notice keeps saying subscriptions continue until the streamer ends them. It needs finance rules and live money, so it stays on the review list.                                                                                                                                                                                                                                                                                                                     | orchestrator |
| f   | **Connect:** transfers to Express accounts, one per split recipient (W2-splits), at payout-run time. A failed or reversed transfer returns the amount to the payable through a ledger reversal, and the treasurer sees it. No tax-form collection is built (counsel-like).                                                                                                                                                                                                                                                                          | orchestrator |
| g   | **A lapsed ban cleared at sign-in writes `channel.suspension {suspended:false}`.** The admin plugin clears it through a user update, so the API writes the event from `databaseHooks.user.update` when `banned` goes false (`services/api/src/auth/index.ts:252-286`). The brief first checks that the plugin's clear goes through that hook, and falls back to a session-create `after` hook if it does not. That hook is not transactional (`:268-270`), so the 5-minute `ban-expiry` sweep stays the backstop, and the two must not double-emit. | orchestrator |
| h   | **New internal events** `federation.actor.disabled {channel_id}` and `channel.federation {channel_id, enabled}` (N4-api request, N4-delivery review #3), routed by `b7JobsFor`. A toggle never emits the public `channel.update`. The API stops queueing `deliver` jobs and deleting follower rows itself.                                                                                                                                                                                                                                          | orchestrator |
| i   | **Failed and abandoned import archives** under `incoming/portability/` are deleted by a daily job once their import is `failed`, or `previewed` and older than 24 h. Today they are deleted only after a successful apply (`services/worker/src/portability/import/index.ts:93-96`).                                                                                                                                                                                                                                                                | orchestrator |
| j   | **Twitch import data expires** (counsel-like). The public Twitch data in `portability_imports.preview` and `.result` (`packages/db/src/schema/b7.ts:153-155`), including the Twitch user name, is cleared 30 days after the import finishes. The row keeps its status, source and times for the audit trail.                                                                                                                                                                                                                                        | orchestrator |
| k   | **The status page is in-house, with no new dependency.** The monitoring droplet's Prometheus probes the instance with `blackbox_exporter` (Apache-2.0, vetted per ADR 0022). A small script renders a static page that Caddy serves there. No third-party status service and no new image beyond the exporter.                                                                                                                                                                                                                                      | orchestrator |
| l   | **Alerts go to email through the instance's SMTP relay** (Resend on 2587, as on staging), plus an optional generic webhook. No proprietary paging service is required (rule 3). The human on the route is the user's L1 item.                                                                                                                                                                                                                                                                                                                       | orchestrator |
| m   | **P2P bytes in attestations:** the contract step writes ADR 0014 Amendment 1 (proposed). It recommends a separate `p2pBytesReported` figure, labelled client-reported, never summed into attested bytes and never paying. Statement `v: 2` (tokens, vectors, worker, SDK) is built in batch 9, after acceptance.                                                                                                                                                                                                                                    | orchestrator |
| n   | **Giveaway CR10 stays declined.** Winners stay pseudonym-only to streamers (batch 7 wave 1). CR9 (marking your entry on any giveaway) is built.                                                                                                                                                                                                                                                                                                                                                                                                     | orchestrator |
| o   | **Shard cap:** every harness shard stays under about 12 minutes. A single scenario over the cap is split (e2e-relay) or trimmed (clock-skew). It is not left as an exception.                                                                                                                                                                                                                                                                                                                                                                       | orchestrator |
| p   | **Seeds stay with the seed-full session.** Publishing `interact.giveawayId` and `social.moveLinkNonce` belongs to `.claude/briefs/seed-full/` (`harness/src/seed/**`). No batch 8 unit writes there. The orchestrator coordinates through `harness/src/seed/routes.ts` only.                                                                                                                                                                                                                                                                        | orchestrator |
| q   | **No new third-party npm, Go or image dependency** except `blackbox_exporter` and the metrics receivers or exporters L1-observability picks. Each goes through `vet-package` or `pin-images`, `infra/image-licenses.json` and an orchestrator OK.                                                                                                                                                                                                                                                                                                   | orchestrator |
| r   | **Each UI unit writes `en` and `es` in the same change** (`REQUIRED_LOCALES = ["es"]`). It uses the namespace of the component it changes (`w3-jury`, `w3-giveaways`, `w3-predictions`, `n3-import`), or `m1-money` and `m1-coop`, which the contract step creates empty.                                                                                                                                                                                                                                                                           | orchestrator |

## Contract step

Orchestrator, on `main`. Pushed, with CI green before wave 1. It is written up as
`.claude/briefs/b8/contract-step.md` after the user answers U1–U6. Planned parts, which touch
disjoint files and can run as a Workflow:

- **(A) S1-d:**
  - an integration test with a no-superuser Postgres under TLS;
  - fixes to `packages/db/src/migrate.ts` and `infra/postgres/**` if the test finds any;
  - the `commonair_monitor` and restore roles.
- **(B) M1 schema:**
  - `0048_b8.sql` and `0049_b8_protections.sql`: the gift index and expiry, the refund
    `outcome_unknown` state, `payout_transfers`, share purchases, patronage payouts;
  - the ledger posting rules (`packages/ledger/src/rules.ts`);
  - the adapter seams: `transfer?()` on `PaymentAdapter`, and `createTransfer`/`retrieveTransfer`
    on `StripeClient`;
  - `stripe-events.ts` split into per-unit handler files;
  - then the database security review.
- **(C) B8 contracts and seams:**
  - the two federation events and their `b7JobsFor` routes;
  - `edgeWallclock` on `room.sync` and `RoomSyncReport`;
  - `dvrSwitchTo` on the heartbeat answer;
  - `twitchImport.start.fields`;
  - the giveaway CR9 field;
  - the staff-action variant of statements of reasons;
  - a `giveaways` export section, registered in `collectors.ts`;
  - job stubs (`portability-incoming-cleanup`, `import-record-expiry`, `gift-expire`,
    `refund-reconcile`, `payout-transfers`, `patronage-payout`) in `services/worker/src/jobs/index.ts`;
  - the `channel` prop that `chat-panel.tsx` passes to the prediction card;
  - the `paymentReceipt` template key;
  - `GIFT_PAYMENT_HOURS` in config and `.env.example`;
  - the empty `m1-money` and `m1-coop` namespaces.
- **(D) Docs and harness:**
  - ADR 0014 Amendment 1 (decision (m));
  - ADR 0007 Amendment 1, for Connect and outcome-unknown details (decisions (b), (d), (f));
  - `harness/src/b8/steps.ts`, with `B8_EXTENSIONS` and `PENDING_B8_*` wired into `e4b-money`,
    `e5-coop`, `interact`, `watch-room`, `twitch-import` and `federation`;
  - `docs/testing/b8-selectors.md` with `PENDING_B8_IDS`.

## Waves

At most six units at a time. Two agents never write the same file at the same time.

| Wave | Units (parallel)                                                                       | Starts from                | Why this order                                                                                                                                                                                                                                                   |
| ---- | -------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | S1-b external, L1-observability, M1-gifts-refunds, M1-connect, B8-server, B8-web (6)   | the contract step's sha    | S1-b needs only S1-d. The two M1 units split by file once (B) has split the adapter and the webhook handlers. B8-server and B8-web need only (C).                                                                                                                |
| 2    | S1-h backups-ext, M1-coop-money, R0-release-prep, L1-status, B8-player, B8-harness (6) | `main` after wave 1 merged | S1-h and R0-release-prep edit `selfhost.sh` and the e2e after S1-b has merged. Coop payouts use M1-connect's transfers. L1-status builds on L1-observability's Grafana. B8-player and B8-harness touch the W3 player and harness files that wave 1 leaves alone. |

User track, beside both waves: R0 §3 on real droplets, S1-a's sweep, and `failover` (U5).

## Path ownership (planned; the briefs fix it)

| Unit             | Owns (write only these)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1-b external    | `scripts/selfhost.sh` (the option parser, install, upgrade and status; **not** the backup section); `scripts/selfhost/**` except `e2e-backup*`, `selfhost-backup.test.ts` and S1-h's new files; `infra/selfhost/**`; `infra/quadlet/commonair-{postgres,valkey,migrate}*`; `docs/self-hosting/{configuration,requirements,scaling}.md`; `infra/tests/selfhost-external*`                                                                                                                                                                                                                                                                                |
| L1-observability | `infra/otel-collector/**`, `infra/prometheus/**`, `infra/grafana/**`, `infra/quadlet/commonair-{otel-collector,prometheus,grafana}*`, `docs/operators/monitoring.md`, `infra/tests/observability*`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| M1-gifts-refunds | `services/api/src/money/checkout.ts` (the gift lines), `services/api/src/money/refunds*.ts`, the refunds handler file from (B), `services/worker/src/money/{ends,expire,reconcile}.ts` and `refund-reconcile.ts`, `packages/email/src/templates/receipt.tsx` and the `paymentReceipt` keys in the email catalogs (`en`, `es`), `apps/web/src/components/treasury/refund*`, `apps/web/src/i18n/locales/{en,es}/m1-money.json`, `harness/src/b8/money-refunds.ts`                                                                                                                                                                                         |
| M1-connect       | `packages/payments/src/stripe-transfers.ts`, `packages/ledger/src/payouts.ts`, `services/api/src/money/stripe-connect.ts`, the transfers handler file from (B), `services/worker/src/money/transfers*.ts`, `apps/web/src/components/treasury/payout*`, `harness/src/b8/money-connect.ts`                                                                                                                                                                                                                                                                                                                                                                |
| B8-server        | `services/api/src/auth/index.ts` (the user-update hook), `services/api/src/chat/surge.ts`, `services/api/src/federation/settings.ts`, `services/worker/src/federation/**`, `services/worker/src/exports/{collectors,giveaways}.ts` (the giveaway section only), `services/worker/src/moderation/sor-{build,schemas,deliver}.ts`, the statement lines of `packages/email/src/templates/trust.tsx`, `services/worker/src/jobs/{portability-incoming-cleanup,import-record-expiry}.ts`, `services/worker/src/twitch-import/**`, `apps/web/src/components/twitch-import/**`, `apps/web/src/i18n/locales/{en,es}/n3-import.json`, `harness/src/b8/server.ts` |
| B8-web           | `apps/web/src/routes/_app/$channel.tsx`, `apps/web/src/components/channel/panels*` and `banner*` (new), `apps/web/src/chat/interact/prediction-card.tsx`, `apps/web/src/routes/_admin/admin.moderation.tsx`, `apps/web/src/components/safety/mod-queue.tsx`, `apps/web/src/components/jury/**`, `apps/web/src/chat/replay/**`, `apps/web/src/components/giveaways/**` and the CR9 lines of `services/api/src/interact/giveaways/**`, their `{en,es}` namespaces, `harness/src/b8/web.ts`                                                                                                                                                                |
| S1-h backups-ext | `scripts/selfhost.sh` (the backup section), `scripts/selfhost/{e2e-backup,e2e-dump}*.ts`, `scripts/selfhost/selfhost-backup.test.ts`, `infra/postgres/{dump,dump-restore}.sh` (new), `infra/quadlet/commonair-{dump,drill}*` (new timers), `docs/self-hosting/{backups,managed-services}.md`                                                                                                                                                                                                                                                                                                                                                            |
| M1-coop-money    | `services/api/src/coop/{membership,shares}.ts`, `services/worker/src/coop/patronage-payout*.ts`, `apps/web/src/routes/_app/coop.membership.tsx`, `apps/web/src/components/coop/shares*`, `apps/web/src/i18n/locales/{en,es}/m1-coop.json`, `harness/src/b8/coop-money.ts`                                                                                                                                                                                                                                                                                                                                                                               |
| R0-release-prep  | `scripts/selfhost/e2e.ts` and `scripts/selfhost/e2e-from-release.ts` (new), `docs/self-hosting/**` except S1-h's two pages, `CHANGELOG.md`, `scripts/release/changelog.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| L1-status        | `infra/status/**` (new), the monitoring droplet module in `infra/tofu/**`, `infra/grafana/provisioning/alerting/**`, `docs/operators/{incidents,on-call,status-page}.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| B8-player        | `apps/web/src/player/room-sync*`, `apps/web/src/player/dvr*`, `services/chat/src/watch-rooms/**`, the DVR lines of `services/api/src/routes/playback.ts`, `harness/src/w3/{watch-rooms,dvr-relay}/**`                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| B8-harness       | `harness/scenarios/{e2e-relay,clock-skew}.ts`, `harness/scenarios/relay-dvr.ts` (new), `harness/src/web/flows.ts`, `harness/src/w3/jury.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Every unit also owns the new test files named after its own files. Each unit regenerates its own
`apps/web/src/i18n/keys/<ns>.gen.ts`.

**Orchestrator only:**

- `packages/{contracts,db,config,tokens}/**`, `packages/ledger/src/rules.ts`,
  `packages/payments/src/{adapter,stripe-client,stripe}.ts`.
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
  `e2e-dump.ts`, and the orchestrator wires it in at merge.
- **Money:** contract part (B) splits the adapter, the client and the webhook dispatch first, so
  M1-gifts-refunds and M1-connect each fill their own files.
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

- **S1 stage 1:**
  - S1-d's no-superuser integration test passes in CI.
  - The self-host e2e gains an external-services variant (no-superuser Postgres with TLS, Valkey
    with an ACL user and TLS, Garage as the external S3). It runs as a CI job: install, upgrade,
    backup (logical dump) and the dump drill pass.
  - `docs/self-hosting/managed-services.md` exists.
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
  - Host, Postgres and Valkey metrics appear in Prometheus on the harness stack.
  - Dashboards are provisioned, with a test that every panel's query names a metric that exists.
  - Alert rules pass `promtool check rules` in a test.
  - The status page renders from probes.
  - The runbooks are in `docs/operators/`.
- **R0:**
  - The e2e `--from-release v0.1.0-rc.2` passes, or what blocks it is recorded with a decision.
  - The `v0.1.0` changelog is written.
  - The self-hosting docs are current.
  - Then, per U2: rc.3 cut from a green `ci-ok`, R0 §3 run by the user (U5), and `v0.1.0` tagged.
    `ROADMAP.md` says Phase 1 shipped.
- **Follow-ups:**
  - Every B8 step passes with `PENDING_B8_*` empty, and `docs/testing/b8-selectors.md` is checked
    by `apps/web/tests/selectors.test.ts`.
  - Every new route is in `SEED_ROUTES`. `es` is at 100%, and the `en-XA` scan is clean on the
    pages it visits.
- **Shards:** every shard is under ~12 min, `relay` and `clock` included (decision (o)).
- **Docs:**
  - the ADR 0014 and ADR 0007 amendments are written;
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

## Briefs to write (after the user answers U1–U6)

Do not write these yet. The list follows the [Waves](#waves) above. Drop the three M1 briefs if U1
drops M1.

- `.claude/briefs/b8/contract-step.md`: parts (A)–(D).
- `.claude/briefs/s1/S1-b-external.md`.
- `.claude/briefs/s1/S1-h-backups-ext.md`.
- `.claude/briefs/l1/L1-observability.md`.
- `.claude/briefs/l1/L1-status.md`.
- `.claude/briefs/m1/M1-gifts-refunds.md`.
- `.claude/briefs/m1/M1-connect.md`.
- `.claude/briefs/m1/M1-coop-money.md`.
- `.claude/briefs/r0/R0-release-prep.md`.
- `.claude/briefs/b8/B8-server.md`.
- `.claude/briefs/b8/B8-web.md`.
- `.claude/briefs/b8/B8-player.md`.
- `.claude/briefs/b8/B8-harness.md`.

After the briefs, update this README's decision rows from "OPEN" to the answers, then write
`batch8/HANDOFF.md`'s per-unit reviewer focus.

## Open items

For the user (only U1–U6 block the contract step):

- The visual checks of batch 7's pages under `en`, `es` and `en-XA`, at 320 px, in dark and light,
  keyboard only. They carry over from the batch 7 README "Open items".
- A real-Helix smoke test before the Twitch import is turned on.
- A real Mastodon follow against staging before federation is turned on.
- The real-server track (U5).
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
