<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Batch 6: W2

Batch 6 of [`.claude/briefs/next/README.md`](../next/README.md): W2, feature-wins wave 2
([`next/W2-feature-wave.md`](../next/W2-feature-wave.md); spec `docs/product/feature-wins.md` §4.5,
§4.7–4.12 and §5 "Wave 2"). Ledger splits, open captions, creator analytics, the open enforcement
report, free live DVR, rehearsal mode, signed audience attestations and group exclusion appeals,
plus the chat replay UI W1 deferred (batch 4 decision, `next/W2-feature-wave.md` "W2-dvr / chat
replay"), which needs public VOD and clip watch pages first. Briefs: [`w2/`](../w2/). Planned at
`8fc2c974` (2026-11-01), after batch 5 closed green on `63ccab01`.

## Gates

| Unit                  | Gated on                                                                        | State (2026-11-01)                                                             |
| --------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| W2-splits             | ADR 0013; W1-fraud-floor merged (`payouts.ts` hand-over); `PaymentMeta` v2      | accepted; merged (`f73aa3b5`); v2 landed in W1 (`packages/ledger/src/meta.ts`) |
| W2-captions           | ADR 0011; W1-spine (media clock, PDT on every rendition)                        | accepted; merged                                                               |
| W2-rollup-analytics   | ADR 0014 decisions 1, 3 (settle constant)                                       | accepted                                                                       |
| W2-enforcement-report | ADR 0019 (statements of reasons; decision 1 rejects a `policy_rules` table)     | accepted; W0 SoR merged                                                        |
| W2-dvr                | ADR 0016; W0-media-exposure (`e4ba1a5`); W1-spine; W1-data-mode (`dm` claim)    | accepted; all merged                                                           |
| W2-rehearsal          | feature-wins §4.11; E8 (goals, raids) for the full flow                         | E8 merged; alert checks still deferred (decision (j))                          |
| W2b-attestations      | ADR 0014; rollup merged (`routes/integrity.ts` hand-over); W0-integrity closure | wave 2; closure recorded (`PROGRESS.md`, W0)                                   |
| W2b-group-appeals     | ADR 0014 decision 4 (re-score past finalize); rollup merged                     | wave 2                                                                         |
| W2-vod-watch          | W1-spine `vods.chat` / `clips.chat` and `ChatReplayPage`; W1-player seam        | merged; no public VOD or clip watch page exists yet                            |

## Decisions (2026-11-01)

"User" rows are the user's answers of 2026-11-01; "orchestrator" rows are defaults recorded as
decided (the user may reopen any of them).

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Where                                | By           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------ |
| a   | **Splits ship enabled.** Counsel on payee/contractor status for split recipients is not a blocker for W2-splits; no feature flag. Live money is still gated by M1 (no live keys before counsel and a legal entity), so on our instance splits move test money only until then. The counsel question stays open (Open items)                                                                                                                                                                                                                               | W2-splits                            | user         |
| b   | **DVR window: 30 min default per channel, 2 h instance cap.** `channels.dvr_window_seconds` default 1800, `DVR_MAX_WINDOW_SECONDS` default 7200 (ADR 0016's cap); `channels.dvr_enabled` default true. DVR is origin-only egress, so the default is low until P1 and relays absorb more                                                                                                                                                                                                                                                                   | contract step, W2-dvr                | user         |
| c   | **Captions in CI: path-filtered plus nightly.** A `captions` harness shard runs on `main` pushes whose changes reach captions, media or origin code, and in the nightly full run; not on every push                                                                                                                                                                                                                                                                                                                                                       | contract step, W2-captions           | user         |
| d   | **Enforcement report on `rule_ref`, no `policy_rules` table** (ADR 0019 decision 1). `rule_ref text` (`<clause id>@<version>`, CHECK on the format) on `moderation_cases`, `appeals` and `mod_actions` (CHECK `rule_ref is null or scope = 'platform'`), filled from `currentClause` at action time; the catalog stays `CLAUSES` in `packages/moderation/src/reasons.ts`. Cells below **k = 10** are suppressed. Window: rolling 30 days plus calendar months. The DSA Transparency Database adapter stays off                                            | contract step, W2-enforcement-report | orchestrator |
| e   | **The chat replay UI is its own unit, W2-vod-watch** (wave 2): public VOD and clip watch pages (`/$channel/vods/$vodId`, `/$channel/clips/$clipId`) with the replay panel beside the player, ordered by `at`, labelling `catchingUp`, saying so when `retained` is false, hiding blocked authors. The contract step adds the routes as placeholders, their nav entries and `SEED_ROUTES` rows                                                                                                                                                             | contract step, W2-vod-watch          | orchestrator |
| f   | **A rehearsal is not a broadcast to anyone but its invitees.** `broadcasts.kind` (`live` / `rehearsal`). For a rehearsal, `mediaReady` sets no `channels.liveBroadcastId` and emits no `stream.online` / `stream.offline` (so directory, N1 go-live, EventSub, webhooks, Discord, raids and goals never see it), and DB triggers refuse rehearsal rows in `stream_hours`, ledger postings, patronage inputs and attestations. Ingest, transcode, health and moderation sampling run as live; a T0 hit suspends as live. The contract step lands this gate | contract step, W2-rehearsal          | orchestrator |
| g   | Rehearsal limits: arm TTL 10 min, duration cap 30 min, at most 5 invitees, who must follow the channel; invitees watch through an invitee-gated playback path, never `liveBroadcastId`; the VOD is kept 24 h; no captions, no DVR, no simulcast for a rehearsal. Alert checks (goals, raids) stay deferred                                                                                                                                                                                                                                                | W2-rehearsal, W2-captions, W2-dvr    | orchestrator |
| h   | `packages/sim` (new, AGPL) holds the simulated chat and viewers rehearsal drives; it is written for rehearsal, and the harness keeps its own bots this batch (dedupe later)                                                                                                                                                                                                                                                                                                                                                                               | W2-rehearsal                         | orchestrator |
| i   | Splits defaults: hold memo `hold:<paymentId>:<userId>`; holds release per recipient; a new split recipient adds 7 days to the payment hold and needs a 30-day-old account; a crew member's first payout goes through the fraud floor's `new_payee` four-eyes check; a recipient needs a payout profile (the manual adapter counts); the split-graph fraud signal is deferred; one user-id comparator (lowercase, `<`) shared by `lockCreators` and `runPayoutBatch`                                                                                       | W2-splits                            | orchestrator |
| j   | Captions: whisper.cpp built from source at a pinned tag on a pinned base image (our own sidecar image, `infra/image-licenses.json`), weights `ggml-base-q5_1` pinned by digest in a second `fetch-model` entry; 2 threads and 3 s chunks per stream; `CAPTIONS_MAX_STREAMS` default 2 per media host; `captions.defaultEnabled` seeded false; transcripts are dropped at broadcast end when the channel keeps no VODs (ADR 0011 decision 6)                                                                                                               | contract step, W2-captions           | orchestrator |
| k   | Analytics: groups smaller than 5 sessions are not shown; the rollup runs `AUDIENCE_SETTLE_SECONDS` (7200) after `stream.offline` through a delayed job; owner views and share links show a broadcast 24 h after it ends; the cost model is the instance env `INFRA_COST_MODEL` (JSON, cents per GB by source, worker and api); `IntegritySummary` becomes integer seconds and a category enum (no deployments, no back-compat); no `analytics:read` third-party scope yet                                                                                 | contract step, W2-rollup-analytics   | orchestrator |
| l   | Attestations: `INTEGRITY_SIGNING_KEY` (Ed25519, generated by `init-env`) lives on the worker only, never the api; `packages/tokens/src/attestation.ts` and its `vectors.json` section are written by the contract step; `packages/sdk` depends on `@commonair/tokens` (workspace) and re-exports the verifier                                                                                                                                                                                                                                             | contract step, W2b-attestations      | orchestrator |
| m   | Group appeals: subject `exclusion_group` = one exclusion category within one broadcast; at most 1 per broadcast and 3 per channel per 7 days; an overturn re-scores the ended sessions it covers and enqueues the attestation re-check                                                                                                                                                                                                                                                                                                                    | contract step, W2b-group-appeals     | orchestrator |
| n   | Shared seams land in the contract step so no unit edits them: the origin route registry (`services/origin/src/origin.ts`, with `vtt` and `dvr` request kinds in `paths.ts`), a media session hook registry (`services/media`), `packages/integrity/src/constants.ts`, and the rehearsal gate in `services/api/src/media/hooks.ts`                                                                                                                                                                                                                         | contract step                        | orchestrator |
| o   | No new third-party npm dependency. The only new third-party code is whisper.cpp (MIT) and its weights (MIT) in our own sidecar image, vetted and pinned per AGENTS.md rule 7                                                                                                                                                                                                                                                                                                                                                                              | all                                  | orchestrator |
| p   | Every unit with UI owns its namespace (created empty by the contract step) and writes `en` **and** `es` in the same change (`REQUIRED_LOCALES = ["es"]`); the `en-XA` scan (`e2e-basic-en-xa`) keeps catching literals                                                                                                                                                                                                                                                                                                                                    | all web units                        | orchestrator |
| q   | The attestation verifier ships in the Apache-2.0 SDK, so `packages/tokens/src/attestation.ts` is dual-licensed `AGPL-3.0-or-later OR Apache-2.0` (ADR 0035: "a new contract file the SDK starts inlining needs the dual licence first"), self-contained (WebCrypto only), exported as `@commonair/tokens/attestation` and copied and licence-checked by `packages/sdk/scripts/build.ts`. The maintainer confirms the dual licence before the SDK's next publish, as for the contract files                                                                | contract step, W2b-attestations      | orchestrator |
| r   | Attestation kinds `broadcast`, `supersede`, `reissue` (ADR 0014 decisions 1, 4); key compromise is an audited admin procedure (`integrity.keys.compromise`) that marks the key and enqueues reissues                                                                                                                                                                                                                                                                                                                                                      | contract step, W2b-attestations      | orchestrator |

## Contract step

One commit on `main`, pushed, CI green before wave 1: [`w2/contract-step.md`](../w2/contract-step.md).
Migrations `0042_w2.sql` and `0043_w2_protections.sql`; contracts (`money.splits.*`,
`stream.rehearsal.*`, `analytics.*`, `integrity.attestations.*`, `transparency.enforcement`,
`vods.captions.update`, `PlaybackStart.dvrWindowSeconds` / `dvrPlaylistUrl`, `SegmentFetch.mode`,
`APPEAL_SUBJECTS` `exclusion_group`, `IntegritySummary` integers); config (`CAPTIONS_MAX_STREAMS`,
`DVR_MAX_WINDOW_SECONDS`, `INFRA_COST_MODEL`, `INTEGRITY_SIGNING_KEY`); the seams of decision (n);
`packages/chat-filter`; `packages/tokens/src/attestation.ts` + vectors; route files and job stubs;
empty namespaces; web route placeholders; harness scaffolding and `docs/testing/w2-selectors.md`.

## Waves

At most six units at a time; two agents never write the same file at the same time.

| Wave | Units (parallel)                                                                             | Starts from                | Why this order                                                                                                                                           |
| ---- | -------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | W2-splits, W2-captions, W2-rollup-analytics, W2-enforcement-report, W2-dvr, W2-rehearsal (6) | the contract step's sha    | disjoint paths once the seams exist                                                                                                                      |
| 2    | W2b-attestations, W2b-group-appeals, W2-vod-watch (3)                                        | `main` after wave 1 merged | both 2b units build on the rollup tables and take `routes/integrity.ts` / `analytics/**` after it; vod-watch builds on the DVR player files and captions |

Between waves the orchestrator merges each unit, applies contract requests and pushes `main`.

## Path ownership

| Unit                  | Owns (write only these)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W2-splits             | `packages/ledger/src/{rules,reversals,math,holds,queries,locks,payouts,breakdown}.ts` and their tests, `services/api/src/money/{stripe-events,checkout-treasurer,splits,reports-lib}.ts` and tests, `services/worker/src/money/holds.ts` and tests, `apps/web/src/routes/_studio/crew.tsx` (content), `apps/web/src/components/money/{crew*,transparency}.tsx`, `apps/web/src/i18n/locales/{en,es}/w2-splits.json`, `harness/src/w2/splits.ts`                                                                                                                                      |
| W2-captions           | `services/media/src/captions/**`, `services/api/src/captions/**`, `services/origin/src/{captions,playlist}.ts`, `scripts/fetch-model.ts`, `packages/captions/**` (model entry), `infra/containers/whisper.Containerfile`, the `whisper` compose service and `harness/compose.w2-captions.yaml`, `infra/image-licenses.json` (its entry), `apps/web/src/player/captions*`, `apps/web/src/routes/_studio/captions.tsx` (content), `apps/web/src/i18n/locales/{en,es}/w2-captions.json`, `harness/scenarios/captions.ts`, `harness/src/w2/captions/**`, `harness/fixtures/captions/**` |
| W2-rollup-analytics   | `services/worker/src/jobs/broadcast-rollup.ts`, `services/api/src/routes/{integrity,analytics}.ts` (`routes/integrity.ts` until wave 2), `services/api/src/analytics/**` except `appeals.ts`, `apps/web/src/routes/_studio/analytics.tsx` (content), `apps/web/src/components/analytics/**`, `apps/web/src/i18n/locales/{en,es}/w2-analytics.json`, `harness/src/w2/rollup.ts`                                                                                                                                                                                                      |
| W2-enforcement-report | `packages/moderation/src/clauses.ts`, `services/api/src/transparency/**`, `services/api/src/routes/transparency.ts`, `apps/web/src/components/transparency/**`, the `rule_ref` lines in `services/api/src/routes/{moderation,appeals,safety}.ts`, `services/api/src/moderation/uploads.ts` and `services/worker/src/moderation/{scan,t0}.ts` (only the lines that set `rule_ref`), `apps/web/src/i18n/locales/{en,es}/w2-enforcement.json`, `harness/src/w2/enforcement.ts`                                                                                                         |
| W2-dvr                | `services/origin/src/dvr.ts`, `apps/web/src/player/dvr*`, `packages/integrity/src/{concurrency,store,types,signals/fetch}.ts`, the DVR fields in `services/api/src/routes/playback.ts` (`playback.start` DVR token and URL; heartbeat `playbackMode` / DVR seconds recording), `apps/web/src/routes/_studio/` DVR section via `components/dvr-settings*`, `apps/web/src/i18n/locales/{en,es}/w2-dvr.json`, `harness/scenarios/live-dvr.ts`, `harness/src/w2/dvr/**`                                                                                                                 |
| W2-rehearsal          | `packages/sim/**`, `services/worker/src/jobs/rehearsal-driver.ts`, `services/api/src/stream/rehearsal.ts`, `services/api/src/routes/rehearsal.ts`, `apps/web/src/routes/_studio/rehearse.tsx` (content), `apps/web/src/components/rehearsal/**`, `apps/web/src/i18n/locales/{en,es}/w2-rehearsal.json`, `harness/scenarios/rehearsal.ts`, `harness/src/w2/rehearsal/**`                                                                                                                                                                                                             |
| W2b-attestations      | `services/worker/src/jobs/integrity-attestation.ts`, `services/api/src/routes/integrity.ts` (handed over from rollup), `services/api/src/routes/attestation-verify.ts`, `packages/sdk/src/attestation.ts`, `docs/governance/integrity-ruleset-changelog.md`, `apps/web/src/components/attestations/**`, `apps/web/src/i18n/locales/{en,es}/w2-attestations.json`, `harness/src/w2/attestations.ts`                                                                                                                                                                                  |
| W2b-group-appeals     | `services/api/src/analytics/appeals.ts`, `packages/integrity/src/rescore.ts`, `apps/web/src/components/analytics/group-appeal*`, `harness/src/w2/group-appeals.ts`; its strings go in `w2-analytics` (handed over from rollup)                                                                                                                                                                                                                                                                                                                                                      |
| W2-vod-watch          | `apps/web/src/routes/_app/$channel.vods.$vodId.tsx`, `apps/web/src/routes/_app/$channel.clips.$clipId.tsx` (content), `apps/web/src/chat/replay/**`, `apps/web/src/components/vod-watch/**`, `apps/web/src/i18n/locales/{en,es}/w2-replay.json`, `harness/src/w2/replay.ts`                                                                                                                                                                                                                                                                                                         |

Every unit also owns the new test files named after its own files (unit, integration, `apps/web/tests/<unit>*`, `harness/tests/w2/<unit>*`) and regenerates its own `apps/web/src/i18n/keys/w2-<ns>.gen.ts`. Binary fixtures carry `<file>.license` sidecars (REUSE).

Orchestrator only: `packages/contracts/**`, `packages/db/**`, `packages/config/**`, `packages/tokens/**`,
`packages/chat-filter/**` (extracted in the contract step), `services/chat/src/dry-run.ts`, `services/media/src/{lifecycle.ts,vod/finalize.ts}`, `services/api/src/moderation/live.ts`, `services/worker/src/moderation/records.ts`, `packages/integrity/src/{constants,jobs}.ts`,
`services/origin/src/{origin,handler,paths}.ts`, `services/media/src/{service,session,hooks}.ts`,
`services/api/src/media/hooks.ts`, `services/worker/src/{outbox.ts,jobs/index.ts}`, `.env.example`,
`scripts/init-env.ts`, `scripts/selfhost/**`, `scripts/ci-changes.ts`, `.github/**`,
`infra/caddy/Caddyfile`, `compose.yaml` (except the `whisper` service), `keys/index.gen.ts`, `core.json`
(en), `nav.ts`, the route tree, `package.json` files and `bun.lock`, `REUSE.toml`, `docs/testing/*`,
`docs/README.md`, `harness/src/{shards,registry,kit,platform,seed/routes}.ts`, PROGRESS, ADRs, READMEs.

Conflicts checked:

- `services/origin`: captions owns `playlist.ts` and `captions.ts`; DVR owns `dvr.ts` and registers
  through the route registry, importing `rewritePlaylist` read-only. Neither edits `origin.ts`,
  `handler.ts` or `paths.ts`.
- `services/media`: captions starts and stops its worker through the session hook registry; no
  unit edits `service.ts`, `session.ts` or `controller.ts` (the player's `controller.ts` stays
  frozen as in W1).
- `packages/integrity`: DVR owns `concurrency.ts` and `signals/fetch.ts`; the settle and finalize
  constants are in `constants.ts` (contract step); group appeals adds `rescore.ts` in wave 2.
- `routes/integrity.ts` and `w2-analytics`: rollup in wave 1, handed to attestations (route) and
  group appeals (strings, `analytics/appeals.ts`) in wave 2.
- Transparency: the money page is W2-splits' (`components/money/transparency.tsx`, the write-off
  and suspense lines); the enforcement report is a separate component W2-enforcement-report owns,
  mounted on `routes/_app/transparency.tsx` by the contract step.
- Rehearsal's consumer gate (decision (f)) is the contract step's, so `outbox.ts`, `go-live.ts`
  and the directory are untouched by any unit.
- `harness/scenarios/{e4b-money,integrity-basic,trust-safety}.ts` are not edited by units: each
  unit's steps live in `harness/src/w2/<unit>.ts` and the scenarios call them through the
  `W2_EXTENSIONS` / `PENDING_W2_*` pattern (W1's `harness/src/w1/steps.ts`), wired by the contract
  step.

## Shared rules

- Units are told "read and implement `<brief>`", one git worktree each, branch `w2/<unit>`
  (`w2/splits`, `w2/captions`, `w2/rollup`, `w2/enforcement`, `w2/dvr`, `w2/rehearsal`,
  `w2/attestations`, `w2/group-appeals`, `w2/vod-watch`). `git commit -s`, Conventional Commits,
  the `Co-Authored-By` trailer. Copy `.env` into the worktree root (`bun scripts/init-env.ts
  --merge` there if keys are missing) and `bun install` if needed.
- Pipeline per unit: implement → independent reviewer (diff vs AGENTS.md, this README, the brief
  and the ADRs it cites; money and crypto units get a reviewer told to check the ledger invariants
  and the signature format against the vectors) → the implementer's fix pass.
- Targeted checks only (`.claude/briefs/_done-means.md` and each brief): package tests and
  `test:int`, `tsc`, `vp lint --deny-warnings` and `vp fmt` on every changed file, `vp build` for
  web units, `reuse lint`, and for catalog changes `cd apps/web && bun run i18n:check && bun --bun
  vp test run tests/i18n.test.ts`. Never `bun run verify`, `verify:full`, `podman compose`,
  `scripts/infra.ts`, an image build or a harness scenario. **CI on `main` is the gate.** The user
  runs every browser and visual check.
- Contract requests (exact diffs) go to the orchestrator. No unit creates a namespace, edits
  `keys/index.gen.ts`, an English catalog it does not own, a migration or a shared contract file.
- Money is integer cents; every write with a side effect writes its outbox event in the same
  transaction; every moderator, admin, integrity and treasury action writes `audit_log`; no
  personal data in append-only columns (AGENTS.md).

## Milestone checks (W2 done means)

- `captions` (WER, cue timing, VOD), `live-dvr` and `rehearsal` pass with no pending steps,
  `inFull` true, in `FULL_REQUIRED`; `captions` in its own path-filtered shard (decision (c)),
  `live-dvr` and `rehearsal` in a shard that keeps every shard under ~12 minutes.
- `e4b-money` per-recipient release, clawback and won-chargeback steps; `integrity-basic` group,
  signed-attestation, tamper and group-appeal steps; `trust-safety` report assertions; the
  `timeline-sync` replay-panel step — all with no `PENDING_W2_*` left.
- `docs/testing/w2-selectors.md` checked by `apps/web/tests/selectors.test.ts`; every new route in
  `SEED_ROUTES`; `es` at 100%; the `en-XA` scan clean on the new pages it visits.
- `docs/governance/integrity-ruleset-changelog.md` exists; privacy text for captions transcripts,
  analytics and rehearsal invitees (draft, counsel not reviewed).
- **End of batch**: CI green on `main` with every job, including the full harness shards and the
  nightly run.

## Open items

For the user (none blocks the waves):

- Counsel: payee/contractor status of split recipients (decision (a): not a blocker; record the
  answer when it comes); captions and analytics privacy text; whether attestations need a
  published key-custody statement.
- Visual checks of the crew, captions, analytics, rehearsal, DVR and VOD watch pages under `en`,
  `es` and `en-XA`, at 320 px, dark and light.
- After W2: W3 + N3 + N4 as batch 7 (`next/README.md` order).
