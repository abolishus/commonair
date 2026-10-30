<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Batch 4: W1 and N1

Batch 4 of [`.claude/briefs/next/README.md`](../next/README.md): W1 (feature-wins wave 1:
payment breakdown, Calm Chat, the media-time spine, the verified-watch gate, the payment fraud
floor, data mode) and N1 (go-live notifications in-app, by email and web push, the Discord
adapter, the installable PWA). Briefs: [`w1/`](../w1/), [`n1/`](../n1/). Each milestone has a
`contract-step.md` the orchestrator lands (one commit each, W1 first) before wave 1. The rest of
N2 (es catalog, N2-ui, N2-email, switcher, Weblate) is **not** in this batch; see the end.

## Gates

| Milestone | Gated on                                                                                                                      | State (2026-10-29)  |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| W1        | ADR 0012 part 2 (amendment 1: media clock, chat replay, blocks), ADR 0015 (verified-watch signal), ADR 0018 (data-mode claim) | accepted 2026-10-27 |
| W1        | read too: ADR 0013 decision 2 (`PaymentMeta` v2), ADR 0016 decision 6 (heartbeat mode), ADR 0017 (blocks; see decision (a))   | accepted 2026-10-27 |
| N1        | ADR 0028 (notifications)                                                                                                      | accepted 2026-10-27 |
| W1-fraud  | ADR 0036 (payment fraud floor: kinds, thresholds, four eyes, DB-enforced hold; decision (d))                                  | accepted 2026-10-30 |

The ADRs were accepted with the orchestrator's recommended answers (0036 on 2026-10-30, with the
user's answer on confirmed flags); the briefs and contract steps match them. N1's contract step
records its own corrections as ADR 0028 Amendment 1 (n1 §11).

## Decisions (2026-10-30)

All settled before wave 1 and applied in the briefs and contract steps named. "User" rows are the
user's answers of 2026-10-30; "orchestrator" rows are defaults recorded as decided (the user may
reopen any of them).

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Where                                                                                            | By           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------ |
| a   | User blocks ship in W1 (`user_blocks`, `me.blocks.*`, the block action, hiding blocked users in live chat and replay), not W3. ADR 0012 decision 8 already said so; ADR 0017 carries a dated note that its "W3" line is superseded                                                                                                                                                                                                                                                                                                                 | w1 §0, §1.3, §2, §13.1; W1-calm-chat; ADR 0017                                                   | orchestrator |
| b   | CDN fetch-judging (ADR 0015 GA criterion 1) belongs to S1 stage 4; the gate ships behind `CHAT_WATCH_GATE=off`; GA waits for S1 stage 4                                                                                                                                                                                                                                                                                                                                                                                                            | w1 §0, §7, §13.2; W1-watch-gate; `next/S1-scaling.md`                                            | user         |
| c   | Data mode: presets 50 / 800 / 1900 MB/h, overhead 1.15 (`DATA_MODE`, `dataModeCeilingBps`), no ladder change in W1; the audio-rung rule is not scheduled                                                                                                                                                                                                                                                                                                                                                                                           | w1 §1.1, §8.3, §13.3; W1-data-mode                                                               | user         |
| d   | Payment fraud floor recorded as ADR 0036 (accepted 2026-10-30): `PAYMENT_FRAUD_KINDS`, `PAYMENT_FRAUD_RULES`, four-eyes deciding enforced by the `payment_fraud_flags_guard` trigger, the DB-enforced payout hold, audit and outbox in the same transaction, no personal data in flags                                                                                                                                                                                                                                                             | `docs/decisions/0036-payment-fraud-floor.md`; w1 §1.1, §2.3, §13.4; W1-fraud-floor               | user         |
| e   | Support dialog fee estimate: Stripe 1.5–3.9 % + 30 ¢ (`PROCESSOR_FEE_ESTIMATE`), labelled an estimate; `manual` none                                                                                                                                                                                                                                                                                                                                                                                                                               | w1 §1.1, §3.2, §13.9; W1-breakdown                                                               | orchestrator |
| f   | A `confirmed` fraud flag keeps holding the payee's payouts (also in later batches); a cleared flag releases; only an admin's audited account action (`money.treasurer.fraudFlags.release`, `released_by_id`/`released_at`, trigger-checked, once) releases a confirmed one                                                                                                                                                                                                                                                                         | w1 §1.3, §1.5, §2.2, §2.3, §13.5; W1-fraud-floor; ADR 0036                                       | user         |
| g   | Legal: W1's privacy bump and N1's privacy and cookie bumps land as drafts counsel has not reviewed; the re-acceptance (consent) prompt the privacy bump causes is accepted; N1's privacy version is one more string on top of W1's                                                                                                                                                                                                                                                                                                                 | w1 §2.6; n1 §0 table, §10.3                                                                      | user         |
| h   | Chat replay UI deferred to W2 (W1 ships `vods.chat` / `clips.chat` and the harness steps); breakdown receipt email deferred to M1                                                                                                                                                                                                                                                                                                                                                                                                                  | w1 §0, §13.6–7; W1-spine, W1-breakdown; `next/W2-feature-wave.md`, `next/M1-money-follow-ups.md` | orchestrator |
| i   | Spine split into W1-spine and W1-player; no patronage estimate on the breakdown in W1                                                                                                                                                                                                                                                                                                                                                                                                                                                              | w1 §13.8–9; W1-player, W1-breakdown                                                              | orchestrator |
| j   | Mid-surge joiners: the chat `joined` frame carries `surge`, so the hint shows at once; W1-watch-gate fills `WatchGate.surge`, W1-calm-chat keeps the wiring                                                                                                                                                                                                                                                                                                                                                                                        | w1 §1.4, §5, §8.1, §13.10; W1-calm-chat, W1-watch-gate                                           | orchestrator |
| k   | `@axe-core/playwright` for the Calm Chat axe check only through a contract request with `bun scripts/vet-package.ts` output; if its license or vetting fails, the check uses the in-repo accessibility-tree approach                                                                                                                                                                                                                                                                                                                               | w1 §10, §13.11; W1-calm-chat                                                                     | orchestrator |
| l   | Fraud flags have no admin web path in W1: the harness clears with a second treasurer (`grantRole`); the admin release is API-only                                                                                                                                                                                                                                                                                                                                                                                                                  | w1 §10, §13.11; W1-fraud-floor                                                                   | orchestrator |
| m   | CI shard: the planned `w1` shard is named `features`; `notifications` joins it unless that pushes it past ~12 minutes, then its own `notify` shard (decided at the N1 milestone end)                                                                                                                                                                                                                                                                                                                                                               | w1 §9, §15; n1 §9.3, §15                                                                         | orchestrator |
| n   | N1 within ADR 0028: unsubscribe on the API at `/api/email/unsubscribe` (POST applies, GET redirects to the web confirm page); Discord covered by unit and integration tests only; harness push with its own keys, a stubbed `PushManager` and CDP; mature broadcasts notify unconfirmed followers without the title; go-live emails without counts; the bell is a popover; a 30 s digest sweep; a push subscription belongs to the last subscriber of that browser; enabling push enables go-live push; blocks do not affect go-live notifications | n1 §0 "Decided within ADR 0028"; N1 briefs                                                       | orchestrator |
| o   | `notifications` retention: N1-fanout's `notify-prune` job deletes rows older than 90 days and read `go_live` rows older than 30 days, batched, on `notifications_created_idx`; the N1 step adds the index, `NOTIFY_RULES` values and the job registration                                                                                                                                                                                                                                                                                          | n1 §1.3, §2.2, §6.1, §10.1; N1-fanout                                                            | orchestrator |

## Contract steps: the order the orchestrator lands them

One commit each on `main`, pushed, CI green before the next. **W1 first, then N1 written on top
of it** (same shared files: `router.ts`, `entities.ts`, `enums.ts`, `internal.ts`, `env.ts`,
`.env.example`, `services/api/src/{env,router}.ts`, `services/worker/src/{env.ts,jobs/index.ts}`,
`deletion/account-deletion.ts`, `exports/collectors.ts`, `ops/hooks.ts`, `seed.ts`,
`legal/index.ts` and `privacy.md`, the route tree, `nav.ts`, `core.json`, `tests/nav.test.ts`,
`HARNESS_OVERRIDES`, `compose.multi-instance.yaml`, the selfhost `.keys` files, the config
reference); re-find anchors by their quoted text, never by `a43aa6b` line numbers. Wave-1 units
branch from the N1 step's sha.

| #   | Step                         | Migration(s)                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | [W1](../w1/contract-step.md) | `0037_w1_quick_wins`, `0038_w1_protections`    | `PaymentMeta` v2 frozen in `packages/ledger` (§3.1), ADR 0036's fraud tables and triggers (confirmed flags hold until an admin release), the `joined` frame's `surge`, `message_set` reports, `chatEnv` and `INTERNAL_API_SECRET` for the worker, `harness/compose.w1.yaml`, `/chat` studio placeholder and nav, the replay disclosure in `chat-panel.tsx`, `dm` token claim in TS, Go and vectors, 15 API stubs, four job stubs, privacy draft (`2026-10-30-chat-replay-draft`)                                           |
| 2   | [N1](../n1/contract-step.md) | `0039_n1_notifications`, `0040_n1_protections` | on top of W1: `notifications` API namespace (nothing added to `me`), jobs registered after W1's `// Feature wins, wave 1 (W1).` block, `webPushEnv` beside W1's `chatEnv`, deletion beside W1's `user_blocks` delete, `collectors.ts` sections after W1's `blocks.json`, `compose.n1.yaml` after `compose.w1.yaml`, keys regenerated on top, privacy and cookies drafts bumped on top of W1's privacy bump (one more privacy version string), `notifications_created_idx` and the `notify-prune` job stub, PWA scaffolding |

Migration rule: each step takes one more than the highest file after the previous step; if W1
ends with one migration, N1 takes 0038 and 0039 and the orchestrator states the final numbers in
the base-sha message. Generate each on top of the previous snapshot, never in parallel.

After the N1 step, tell the user to run `bun scripts/init-env.ts --merge` before the harness
stack comes up with `compose.n1.yaml`: the existing `.env` has no VAPID pair, and with push on
and no keys the API and worker refuse to start (n1 §9.2). CI is unaffected.

## i18n namespaces

The contract steps create each of these nine empty (`apps/web/src/i18n/locales/en/<name>.json`
= `{}` and `keys/<name>.gen.ts` via `bun run i18n:gen`) and register it; no unit creates a
namespace. Units follow `apps/web/src/i18n/README.md` "How to add a namespace".

| Namespace       | Unit           | Wave | Key prefixes                        | Created by |
| --------------- | -------------- | ---- | ----------------------------------- | ---------- |
| `w1-breakdown`  | W1-breakdown   | 1    | `breakdown.`, `feeSchedule.`        | W1 step    |
| `w1-calm-chat`  | W1-calm-chat   | 1    | `calmChat.`, `blocks.`              | W1 step    |
| `w1-watch-gate` | W1-watch-gate  | 1    | `chatGate.`, `surge.`               | W1 step    |
| `w1-fraud`      | W1-fraud-floor | 1    | `fraud.`                            | W1 step    |
| `w1-data-mode`  | W1-data-mode   | 2    | `dataMode.`                         | W1 step    |
| `n1-email`      | N1-email       | 2    | `unsubscribe.`                      | N1 step    |
| `n1-inbox`      | N1-inbox       | 2    | `notifications.`, `notifySettings.` | N1 step    |
| `n1-pwa`        | N1-pwa         | 2    | `pwa.`, `push.`                     | N1 step    |
| `n1-discord`    | N1-discord     | 3    | `discord.`                          | N1 step    |

Checked against the 17 existing namespaces on `4fcebe2`: no name and no top-level key prefix
collides (existing prefixes include `chat`, `player`, `privacy`, `subscriptions`, `treasury`,
`transparency`, `revenue`; none of the above). W1-spine and W1-player write no web strings. The
contract steps' inline keys go into `core`: `studio.chat`, `chat.replayDisclosure`,
`chat.replayDisclosureLink` (W1) and `nav.notifications` (N1). Email strings are not a namespace:
N1-email writes `packages/email/src/messages/en.ts`. A changed `keys/index.gen.ts` is a contract
request. Logical CSS only (`tests/logical-css.test.ts`).

## Waves

At most six units at a time; two agents never write the same file at the same time.

| Wave | Units (parallel)                                                                   | Starts from                | Why this order                                                                                                                                                                                                                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | W1-breakdown, W1-calm-chat, W1-spine, W1-player, W1-watch-gate, W1-fraud-floor (6) | the N1 contract step's sha | all six need only the W1 step and are disjoint (w1 §4.1, §5, §6, §8.1, §11); calm-chat codes against the `presentation.ts` stub W1-player fills in the same wave; W1 goes first because data mode needs the player seam and Spine and the watch gate are the longest tails. No N1 unit: the six slots are taken and nothing in N1 must precede W1           |
| 2    | W1-data-mode, N1-fanout, N1-email, N1-push, N1-inbox, N1-pwa (6)                   | `main` after wave 1 merged | data mode takes `controller.ts`, `player.tsx`, `heartbeat.ts` over from W1-player and owns `routes/playback.ts` and the origin; the five N1 units are disjoint from it and each other (n1 §5.1, §6.1, §7, §12), coding against the N1 step's stubs (`harness/src/n1/ece.ts`, `PushToggle`, the bell) with fixtures where another unit's output is the input |
| 3    | N1-discord (1)                                                                     | `main` after wave 2 merged | ADR 0028 decision 5: the optional proprietary adapter comes last, after the FOSS path (in-app, email) and push are merged and green                                                                                                                                                                                                                         |

Between waves the orchestrator merges each unit, applies its contract requests, lifts the
harness steps whose units have all merged from the pending lists (`PENDING_TIMELINE_STEPS`,
`PENDING_SURGE_STEPS`, `PENDING_W1_EXTENSIONS`, `PENDING_N1_STEPS`), pushes `main` and waits for
CI. Cross-unit harness steps: `timeline-sync` 2 needs W1-spine and W1-player; `surge-guard` 5
needs W1-watch-gate and W1-player; `timeline-sync` 3 uses a seeded block row until W1-calm-chat
merges; `integrity-basic` `data-mode` needs W1-data-mode; `notifications` 1/3 need N1-fanout, 2
also N1-email, 4 also N1-push, 5 N1-fanout and N1-inbox, 6 N1-pwa, 7 N1-fanout, N1-push and
N1-pwa.

## Path conflicts and how they are resolved

- **`services/worker/src/jobs/{index,names}.ts`**: orchestrator only. W1 registers four stubs
  under `// Feature wins, wave 1 (W1).` after the E9 block; N1 registers five under
  `// Notifications (N1, ADR 0028).` after W1's block (fixed in n1 §6.1). `names.ts` gains
  nothing. Units own only their job files: W1 `chat-retention.ts` (spine), `chat-surge-guard.ts`
  (watch-gate), `money-fraud-scan.ts` (fraud), `money-reconcile.ts` (breakdown); N1
  `notify-go-live.ts` and `notify-prune.ts` (fanout), `notify-email-digest.ts` (email), `notify-push.ts` (push),
  `notify-discord.ts` (discord). Worker dirs are disjoint: `chat/**` (spine), `chat-gate/**`
  (watch-gate), `money/{reconcile,fraud}.ts`, `notify/{fanout,prune,email,push,discord}/**`;
  `integrity/{verified-watch,chat-latency}.ts` are stubs the W1 step already calls from
  `integrity/jobs.ts`. `outbox.ts`, `context.ts`, `env.ts`, `deletion/**`, `webhooks/**`,
  `notify/{outbox-jobs,settings}.ts`: orchestrator.
- **`services/worker/src/exports/collectors.ts`**: orchestrator only, both steps before wave 1
  (W1 §4.7 `blocks.json`, then N1 §6.7). The N1 step said W1-calm-chat owned it during wave 1;
  that contradicted W1 §11 and is corrected (no unit writes it).
- **`services/api/src/routes/me.ts`**: orchestrator. W1 adds `me.blocks` (handlers in
  `routes/me-blocks.ts`, W1-calm-chat); N1 adds nothing to `me` (new top-level `notifications`
  namespace, `routes/notifications/{inbox,preferences,push,unsubscribe,discord}.ts`, one unit
  each). N1-inbox calls the existing `me.notifications` and mark-read and never edits `me.ts`.
- **`services/api` otherwise**: `routes/playback.ts` is W1-data-mode's from wave 2 (the W1 step
  computes `avoidCdn` first; W1-watch-gate only reads it). Units own `money/{breakdown,fee-schedule,fraud}.ts`,
  `chat-replay/**`, `chat/surge.ts`, `blocks/**`, `notifications/{preferences,push,unsubscribe,discord}/**`
  and `notifications/email-unsubscribe.ts`. `router.ts`, `http.ts`, `main.ts`, `env.ts`,
  `index.ts`, `metrics.ts`, `ops/hooks.ts`, `lib/**`, `notifications/queue.ts`, `coop/shared.ts`
  and every composer: orchestrator.
- **`packages/email/**`**: N1-email alone (wave 2); no W1 unit sends mail (the breakdown receipt
  is deferred). N2-email waits for N1-email (see the end).
- **`packages/ledger`**: W1-breakdown `breakdown.ts`, W1-fraud-floor `payouts.ts` (handed to
  W2-splits after); `rules.ts`, `reversals.ts`, `meta.ts`, `settings.ts`, `index.ts`: the W1
  step only. `packages/integrity/src/payments/**`: W1-fraud-floor.
- **`services/chat`**: W1-spine `clamp.ts`, `chat-latency.ts`; W1-watch-gate `rules.ts`,
  `watch-gate.ts`; `core`, `server`, `types`, `directory`, `pipeline`, `persistence`, `cache`:
  the W1 step (nobody edits `persistence.ts` or `cache.ts`). No N1 unit edits chat.
- **Web chat**: `chat-panel.tsx`, `state.ts`, `view.ts`, `mod-menu.tsx` and the existing
  `chat-state`/`chat-events`/`chat`/`e7-chat` tests: W1-calm-chat (keeps the `<SurgeBanner/>`
  mount, its props and the replay disclosure). `connection.ts`, `presentation.ts` and new
  `chat-connection*` tests: W1-player. `surge-banner.tsx` and `chat-gate*`/`surge-banner*` tests:
  W1-watch-gate.
- **Heartbeat and playback**: `player/{controller,player,heartbeat,media-clock}.ts(x)` and
  `heartbeat.test.ts`: W1-player in wave 1, handed to W1-data-mode in wave 2 (with
  `player/{stats,source,budget}.ts`, `data-mode*.tsx`, `routes/playback.ts`,
  `services/origin/src/{auth,playlist,handler,refresh}.ts`). `player/p2p/**` and
  `media-clock.ts` read-only for data mode. No N1 unit touches the player or playback.
- **Settings pages and nav**: route files, `routeTree.gen.ts`, `nav.ts`, `_studio.tsx`,
  `site-chrome.tsx`, `__root.tsx`, `settings.privacy.tsx`, `_studio/dashboard.tsx`, `core.json`,
  `tests/nav.test.ts`: contract steps only (W1 adds `/chat` and the studio entry; N1 adds
  `/settings/notifications`, `/settings/notifications/unsubscribe`, the account entry, the bell
  and `PwaRoot` mounts, the Discord section mount). Units fill their placeholders: `_studio/chat.tsx`
  (watch-gate), `settings.subscriptions.tsx` and `_studio/revenue.tsx` (breakdown),
  `_admin/treasury.tsx` content (fraud), `settings.notifications.index.tsx` (inbox),
  `settings.notifications.unsubscribe.tsx` (email). Mounted stubs: `BlockedUsers` (calm-chat),
  `FeeSchedule` (breakdown), `NotificationBell` (inbox), `PushToggle`/`PwaRoot`/`push-client.ts`
  (pwa; inbox mounts `PushToggle`), `DiscordWebhookSection` (discord).
- **Web money components**: `money/{revenue,transparency (around the mount only),fee-schedule,breakdown-*}.tsx`
  and `support/support-dialog.tsx` (estimate only): W1-breakdown; `money/{treasury,fraud-*}.tsx`:
  W1-fraud-floor.
- **PWA**: `apps/web/public/**` (new), `src/sw/**`, `src/pwa/**` (values in `theme.ts` only),
  `src/server/pwa.ts`, `scripts/vite-pwa.ts`: N1-pwa. `source-policy.test.ts` allowlist,
  `server/http.ts`, `server.ts`, `vite.config.ts`, `tsconfig.json`, `package.json`:
  orchestrator.
- **Config, compose and selfhost**: `packages/config`, `.env.example`, `scripts/init-env.ts`,
  `scripts/selfhost.sh` (`--web-push`), `scripts/selfhost/unit-env.ts`, `infra/selfhost/env/*.keys`
  (regenerated by W1, then again by N1 on top), `harness/compose.{w1,n1}.yaml`,
  `HARNESS_OVERRIDES` (`compose.w1.yaml` after `compose.e9.yaml`, `compose.n1.yaml` after it),
  `compose.multi-instance.yaml`, `docs/self-hosting/{configuration,install}.md`: contract steps
  only. N1 §4.1 now names W1's `chatEnv` and worker spreads as its anchors.
- **Tests (glob ownership)**: api `breakdown*`, `fee-schedule*`, `money-fraud*`, `chat-replay*`,
  `chat-surge*`, `me-blocks*`, `playback-data-mode*`, `notification-prefs*`,
  `notification-unread*`, `push*`, `unsubscribe*`, `discord-webhook*`; the orchestrator's
  `email-unsubscribe-route.test.ts` and `notify-queue.test.ts` match none of them. Worker
  `chat-retention*`, `chat-latency*`, `verified-watch*`, `surge-guard*`, `money-reconcile*`,
  `money-fraud*`, `notify-go-live*`, `notify-fanout*`, `notify-prune*`, `notify-email*`, `notify-push*`, `ece*`,
  `vapid*`, `notify-discord*`; the orchestrator's `notify-outbox-jobs.test.ts` matches none.
  Nothing matches these globs on `4fcebe2` except `apps/web/tests/heartbeat.test.ts` (W1-player
  where its changes need it in wave 1, W1-data-mode in wave 2) and `player-source.test.ts`
  (W1-data-mode's `player*`, wave 2).
- **Harness**: units own `harness/src/w1/<step>.ts` / `harness/src/n1/<step>.ts` and their
  tests (N1-push also `n1/ece.ts`, which N1-pwa imports); `steps.ts`, `kit.ts`, `run.ts`,
  `selectors.ts`, `push-receiver.ts`, scenarios (`timeline-sync`, `surge-guard`, `notifications`,
  the three extended ones), `scenario.ts`, `platform.ts`, `mailpit.ts`, `registry.ts`,
  `shards.ts`, compose overrides and CI: orchestrator.
- **Docs**: one page per unit (`docs/viewers/{payment-breakdown,calm-chat,data-mode}.md`,
  `docs/streamers/{chat-replay,verified-watch-gate,discord}.md`,
  `docs/operators/payment-fraud-review.md`, `docs/self-hosting/web-push.md`); `docs/testing/*`,
  `docs/README.md` (new `docs/viewers/` folder), ADRs, PROGRESS, READMEs: orchestrator.

## Shared rules

- Units are told "read and implement `<brief>`", one git worktree each, branch per brief:
  `w1/breakdown`, `w1/calm-chat`, `w1/spine`, `w1/player`, `w1/watch-gate`, `w1/fraud-floor`,
  `w1/data-mode`, `n1/fanout`, `n1/email`, `n1/push`, `n1/inbox`, `n1/pwa`, `n1/discord`.
  `git commit -s`, Conventional Commits, `Co-Authored-By` trailer.
- Pipeline per unit: implement → independent reviewer (diff vs AGENTS.md and the brief) → the
  implementer's fix pass.
- Units run targeted checks only (`.claude/briefs/_done-means.md` and each brief's "Done
  means"): their packages' tests, `tsc`, lint and format on their paths, `vp build` for web
  units, plus `reuse lint`. Never `bun run verify`, `verify:full`, `podman compose`,
  `scripts/infra.ts` or a harness scenario. **CI on `main` is the gate**; the orchestrator pushes
  `main` after each merged wave and fixes what CI reports. The user runs the scenarios and every
  browser and visual check.
- Contract requests (exact diffs) go to the orchestrator, applied at integration. No unit adds,
  renames or removes a route file, creates a namespace or edits a shared contract file.
- No new third-party dependency in this batch (web push is hand-written RFC 8291/8188/8292 on
  WebCrypto; no Workbox, no PWA plugin; PWA icons are rendered by a harness tool with the
  harness's existing Playwright). Anything else needs `vet-package` and a contract request.

## Milestone checks

- **W1** (w1 §15): no `notImplemented` in the six §4.1 files; `timeline-sync` and `surge-guard`
  pass with no pending steps, `inFull` true, in `FULL_REQUIRED` and the new `features` shard
  (`shards.ts` and the CI matrix); the six extension steps run in `e4b-money`, `e2e-social` and
  `integrity-basic`; the w1 selectors check in `apps/web/tests/selectors.test.ts`; `privacy.md`
  carries the chat replay and retention text (draft); `CHAT_WATCH_GATE` stays `off` by default.
- **N1** (n1 §15): no `notImplemented` under `routes/notifications/`; `notifications` passes with
  no pending steps, also under `--profile no-proprietary` (steps 4 and 7 skipped), `inFull` true,
  in `FULL_REQUIRED` and the `features` shard, or its own `notify` shard if joining pushes
  `features` past ~12 minutes (decision (m)); step 6's installability check has no errors; the n1
  selectors check added; `privacy.md` and `cookies.md` carry the drafts at the bumped versions.
- **End of batch**: CI green on `main` with every job, including the full harness shards.

## Open items

For the orchestrator:

- Create this file before wave 1 (done) and keep the namespace list in step with any brief change.
- Decisions (a)–(o) are settled (2026-10-30); ADR 0036 is written and accepted, the trigger and
  W1-fraud-floor's hook hold on confirmed flags, and ADR 0017 carries its superseded note.
- State the final migration numbers in the base-sha message; tell the user about
  `init-env --merge` (VAPID) with the N1 sha.
- After wave 1: hand W1-data-mode the player files with W1-player's "Player seam" text in
  `docs/testing/w1-selectors.md`. After wave 3: `docs/README.md` rows for `docs/viewers/` and the
  new pages; the w1 and n1 selectors checks; the shard decision for `notifications`; the
  `e6-selectors.md` "Data export" rows (`blocks.json`, the notifications sections).
- PROGRESS: record ADR 0017's "W3" line as superseded (decision (a)), ADR 0036 as accepted, and
  the W2 (chat replay UI) and M1 (receipt email) deferrals.

For the user:

- Nothing blocks wave 1. Any orchestrator default in the decision table can still be reopened.
- Counsel, later: the W1 privacy text (chat replay, retention, blocks) and the N1 privacy
  (notifications, push, Discord, notification retention) and cookies (app files, push permission)
  drafts land unreviewed (decision (g)). N1's privacy bump requires re-acceptance; with no
  deployments yet that costs nothing.
- Run `bun scripts/init-env.ts --merge` once the N1 step lands, before bringing the harness stack
  up.

## After batch 4: the rest of N2

The rest of N2 (es catalog, N2-ui, N2-email, the switcher, Weblate) follows after **N1-email
merges** in wave 2: N2-email rewrites the email catalog and templates in `packages/email`, which
N1-email owns for all of batch 4 (it adds `goLiveDigest`, the link list and the go-live strings,
written without plurals until N2-email adds them).
