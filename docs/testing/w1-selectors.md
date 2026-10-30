<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W1 web ↔ harness contract (feature wins, wave 1)

The W1 units (payment breakdown, Calm Chat and blocks, the chat spine and the player seam, the
verified-watch gate and surge guard, the payment fraud floor and data mode) and their harness
scenarios agree on these routes, the player seam and the `data-testid` values. Changing one is a
contract change: update this file, the web app and the scenarios together. Tests select by
`data-testid` (never by visible text, which is translated). `harness/src/w1/selectors.ts` lists the
ids and `harness/tests/w1/selectors.test.ts` checks them against this file.

## Rules

- Tests select by `data-testid`, never visible text. Option items follow `<field>-<value>`.
- Numbers on elements are plain integers in `data-*` (cents, bytes, seconds); signed where the
  value is (breakdown lines).
- Test hook: `POST /internal/ops/tick` (`{ job }` from `OPS_TICK_JOBS`, behind
  `INTERNAL_API_SECRET`, only while `OPS_TEST_HOOKS=true`, `harness/compose.e6.yaml`, otherwise 404) runs `chat-retention`, `chat-surge-guard`, `money-reconcile` and `money-fraud-scan` on
  demand and returns their counts.
- The harness stack turns `CHAT_WATCH_GATE` and `CHAT_SURGE_GUARD` on (`harness/compose.w1.yaml`);
  both stay off per channel until a scenario enables them, so other scenarios are unaffected.

## Routes

| Route                                                  | What                                         | Unit           |
| ------------------------------------------------------ | -------------------------------------------- | -------------- |
| `/chat`                                                | verified-watch gate and surge-guard settings | W1-watch-gate  |
| `/settings/privacy`                                    | gains the blocked-users section              | W1-calm-chat   |
| `/transparency`                                        | gains the fee schedule                       | W1-breakdown   |
| `/revenue`, `/settings/subscriptions`                  | breakdown entry points                       | W1-breakdown   |
| `/treasury` (admin area, `routes/_admin/treasury.tsx`) | fraud flags section                          | W1-fraud-floor |

`/chat` is a studio page, shown in the studio nav only while the instance runs the gate or the
surge guard (`instance.info` `features.watchGate || features.surgeGuard`); otherwise the route
answers the not-found state.

## Player seam

W1-player builds it; W2 units build on it and never edit `controller.ts`.

`PlayerController` methods: `playheadWallclock(): Date | null` (PDT under the playhead,
`hls.playingDate` or Safari `getStartDate() + currentTime`), `seekToWallclock(t: Date): boolean`,
`setTargetLatency(seconds: number): number` (hls.js `liveSyncDuration`, returns the value applied;
native: changes nothing and returns the current latency; before `start()` the path is not decided
yet: the value is stored and returned, and applies only if hls.js attaches), `onTextTrack(cb)`,
`playbackMode(): "live" | "dvr"` and `onPlaybackMode(cb)`. The `player` element carries
`data-playback-mode`. Diagnostic query parameters on `/$channel` (read by `player.tsx`, for
`timeline-sync` step 2): `targetLatency=<seconds>` and `rendition=<name>`. `media-clock.ts` exposes
`playheadWallclock(channel)` / `playbackMode(channel)` for the chat panel. `chat/presentation.ts`
keeps order within a kind, so an item with a null or unparsable `mediaTs` (normally shown at once)
still waits behind held items of its kind; after `dispose`, `present` shows items at once. Chat
replay (`vods.chat` / `clips.chat`) items are `ChatMessage` plus `at` (`mediaTs`, or `createdAt`
when `catchingUp`, at microsecond precision), ordered by `(at, id)`; a reply whose quoted line is
hidden from this viewer has `replyTo: null`. W1-data-mode (wave 2)
adds `setDataMode(ceilingBps | null)` and `dataUsage()` (it takes `controller.ts` over after
W1-player merges).

## Test ids

### Studio nav

`studio-chat-link` (only while the gate or the surge guard runs on the instance).

### Breakdown

`breakdown-open` (on a revenue-ledger payment row and a "Your payments" row on
`/settings/subscriptions`; `data-payment-id`), `breakdown-dialog`, `breakdown-gross` (`data-cents`), `breakdown-line`
(`data-kind`, `data-component`, `data-cents`, signed), `breakdown-hold` (`data-releases-at`,
`data-released-at`, or `data-empty` when refunds or chargebacks emptied the hold), `breakdown-cut-source` (`data-history-id`, empty for the seed),
`breakdown-timeline-item` (`data-kind`), `breakdown-estimate` (`data-low-cents`,
`data-high-cents`; both absent when the provider charges no fee), `fee-schedule`, `fee-schedule-row` (`data-key`, `data-changed-at`, empty for
the seed).

### Calm Chat

`calm-toggle` (`data-state` `on|off`), `calm-digest` (the `aria-live` region), `chat-wave`
(`data-count`, `data-senders`), `chat-wave-expand`, `chat-report-wave`, `chat-message-actions`
(existing id, now for every signed-in viewer; `data-moderation` `true` when it offers timeout and
ban), `chat-user-block`, `blocked-users`, `blocked-user`
(`data-username`), `blocked-user-remove`, `chat-replay-disclosure`. Messages from blocked users are
not rendered; `chat-message` keeps its E1 attributes and gains `data-media-ts`.

### Watch gate

`chat-gate-settings`, `chat-gate-seconds`, `chat-gate-exempt-subs`, `surge-guard-enabled`,
`surge-guard-ratio`, `surge-guard-cooldown`, `chat-gate-save`, `surge-banner` (`data-state`
`on|suppressed`), `surge-end`, `surge-start`, `chat-gate-hint` (the chat input's note when the gate
or surge mode applies).

### Fraud floor

`treasury-tab-fraud` (the treasury tab), `fraud-flags`, `fraud-flag` (`data-flag-id`, `data-kind`,
`data-status`, `data-payee`, `data-held-payouts`, and `data-released`: `true` once an admin
released a confirmed flag; no release control in W1), `fraud-flag-evidence`, `fraud-flag-held`,
`fraud-flag-confirmed`, `fraud-flag-action-hint`, `fraud-flag-review`, `fraud-flag-decide`
(disabled for the reviewer, the raiser and the payee), `fraud-review-dialog`,
`fraud-decide-dialog`, `fraud-decision` with `fraud-decision-clear` and `fraud-decision-confirm`,
`fraud-note`, `fraud-raise-form`, `fraud-raise-username`, `fraud-flag-raise`. Payout rows keep
their ids and show `data-hold-reason`.

### Data mode

`data-mode-toggle` (`data-state`), `data-mode-budget` with options `data-mode-budget-50`,
`data-mode-budget-800`, `data-mode-budget-1900` and `data-mode-budget-custom`, `data-usage`
(`data-bytes`, `data-mb-per-hour`), `data-mode-estimate` (`data-mb-per-hour`), `data-mode-notice`
(`data-reason` `native-reload|dvr|vod`). The `player` element gains `data-data-mode` (the ceiling
in bit/s, empty when off).

## Scenarios

Steps are pending until the unit that implements them merges (`harness/src/w1/steps.ts`); a
pending step runs only when named (`--set steps=`, `--set w1=`). Both new scenarios take
`--set steps=` and `--set via=web|api`.

- **`timeline-sync` 1 (W1-spine):** a live channel; a signed-in API chat client sends with
  `mediaTs` = now − 5 s → the stored and live `mediaTs` equal it; now + 10 s → receive time;
  now − 120 s → receive − 60 s; before `started_at` → `started_at`; `playbackMode: "dvr"` → null;
  an IRC (tmi.js) message gets receive − the channel median once three verified viewers report
  latency (≥ 3 sessions), else receive time; offline channel → null and the message is accepted.
- **`timeline-sync` 2 (W1-player):** two Chromium viewers on different rungs at forced latencies
  (hls.js `liveSyncDuration` 3 s and 9 s via `setTargetLatency`; 12 s would sit on the oldest of
  MediaMTX's seven segments) each send a marker message;
  `vods.chat` after the VOD is ready returns them in media-time order, each within 1 s of the PDT
  the sender's page reported at send time.
- **`timeline-sync` 3 (W1-spine):** replay excludes a deleted message, a held-and-never-approved
  one, messages before a `/clear`, a user banned mid-broadcast (their earlier lines), a blocked user
  (for the blocker only, seeded `user_blocks` row or `me.blocks.add` once W1-calm-chat merged); a
  `private` VOD's replay is refused to a stranger; `clips.chat` returns the clip window.
- **`timeline-sync` 4 (W1-spine):** with rows backdated (direct SQL on test rows), the
  `chat-retention` ops tick deletes offline chat older than `CHAT_RETENTION_DAYS` (30), keeps
  VOD-attached chat up to `CHAT_REPLAY_MAX_DAYS` (60), deletes past 60, and skips an author under a
  legal hold.
- **`surge-guard` 1–7 (W1-watch-gate):** as ADR 0015 "Consequences" lists them: (1)
  integrity-basic's fetch-less bots that chat are refused with `msg_verified_watch`; (2) a bot
  assigned to the CDN path (forced through the harness CDN) is refused; (3) six accounts behind one
  address leave exactly one refused; (4) real viewers chat after 60 s + jitter + a scoring pass; (5)
  an audio-only screen-reader (accessibility-tree) viewer verifies and chats; (6) a scripted surge
  of new sessions trips the guard (`surge` frame `on`, `chat.surge.begin` outbox row and audit row),
  a moderator ends it (`suppressed`), and it reverts; (7) drives `/chat` and the `surge-banner` in
  the browser.
- **`e4b-money` extensions:** `breakdown` (W1-breakdown): for the tip, a gift and a subscription,
  `money.paymentBreakdown` lines sum (gross side) to gross exactly, fee lines sit outside it, the
  refund's and chargeback's reversal lines sum to their amounts, the payer sees it and a stranger
  gets `NOT_FOUND`, the anonymous tip hides the payer from the creator; via=web the dialog shows the
  same numbers. `reconciliation` (W1-breakdown): the `money-reconcile` ops tick reports 0
  mismatches, including after the chargeback and (stripe provider) a won chargeback. `fraud-hold`
  (W1-fraud-floor): a fresh payee receiving tips from new accounts above the thresholds is flagged
  by the `money-fraud-scan` tick; the payout run holds them with `fraud_review`; a direct
  `held → pending` update fails; review + a second treasurer's clear releases it (the harness grants
  the second treasurer with `grantRole`; no admin web path in W1).
- **`e2e-social` extensions:** `flood` (W1-calm-chat): with Calm Chat on, 50 msg/s for 10 s from
  bots: at most N (= 3) distinct rows per second rendered, every mention of the fan rendered, the
  digest region updated at most every 5 s; an accessibility check (axe-core only through an accepted
  contract request, otherwise the in-repo accessibility-tree check) reports no violations on the
  chat panel. `block` (W1-calm-chat): the fan blocks the troll from `chat-user-block`; the troll's
  next message is not rendered for the fan but is for the streamer; unblock from
  `/settings/privacy` restores it.
- **`integrity-basic` extension `data-mode` (W1-data-mode):** a Chromium viewer throttled to
  64 kbit/s and a WebKit viewer with the Audio preset play audio-only, keep `data-usage` below the
  estimate + 20 %, and their sessions are verified at the end of the scenario.
