<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W1 contract step (orchestrator)

The orchestrator does this on `main` before any W1 or N1 unit starts, commits it (`feat(w1):
contract step`, with the protections in the same commit or a second `feat(w1): contract step
protections` commit), pushes, and lets CI go green (CI is the gate; no local `verify`). **W1's
step lands first in batch 4; N1's contract step is applied on top of it** and takes the next
migration numbers (§2.4). Wave-1 units branch from the sha after both steps (the N1 step's sha).
Everything below was **checked against `a43aa6b`** (2026-10-29); line numbers are from that
commit; re-find an anchor by its quoted text when an earlier edit in this step moved it.

Plan: `.claude/briefs/next/W1-quick-wins.md`. Spec: `docs/product/feature-wins.md` §4.1–4.4,
§4.6, §5 "Wave 1" (the task brief also names §4.11, Rehearsal Mode: that is W2's, nothing here).
ADRs: `docs/decisions/0012-media-clock.md` (amendment 1, part 2), `0013-ledger-splits.md`
(decision 2, `PaymentMeta` v2), `0015-verified-watch-signal.md`, `0016-live-dvr.md` (decision 6,
the heartbeat mode), `0017-watch-rooms.md` (blocks), `0018-data-mode-claim.md`. Units:
`.claude/briefs/w1/W1-*.md`.

## 0. Where the code differs from the plan (corrections)

| Plan / ADR says                                                                            | Code at `a43aa6b`, and what this step does                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "`holdDays` moves to `packages/config`" (feature-wins §4.1, §5)                            | `holdDays` is the governance setting `payout.rules.holdDays` (`packages/contracts/src/shapes.ts:217-223`), read by `loadMoneySettings` (`packages/ledger/src/settings.ts:23-37`) in both the API (`services/api/src/money/reports.ts:245`) and the worker (`services/worker/src/money/holds.ts:42`). `services/worker/src/money/config.ts` holds no hold constant. **Nothing to move**                                                                         |
| W1-breakdown edits `rules.ts` for `cutHistoryId`                                           | `PaymentMeta` lives in `packages/ledger/src/reversals.ts:27-47`, not in contracts, and is v1. Freezing v2 (ADR 0013 decision 2) means changing `paymentSucceeded` (`rules.ts:132-170`), `reversal()`/`chargeback()`/`chargebackReversal()` metadata (`rules.ts:283-440`), `postReversal` and both callers. **This step does all of it** (§3.1), including `cutHistoryId`; W1-breakdown reads only and never edits `rules.ts`, which goes straight to W2-splits |
| `transparency.feeSchedule`                                                                 | There is no `transparency` namespace; the transparency procedure is `coop.transparency` (`router.ts:2421-2430`, handler `transparencyHandler` in `money/reports.ts`, composed in `routes/coop.ts:24`). The fee schedule becomes **`coop.feeSchedule`** at `GET /transparency/fee-schedule`                                                                                                                                                                     |
| `services/api/src/metrics.ts` is a Prometheus module                                       | Every service records metrics through OpenTelemetry meters (`meter()` from `@commonair/observability`; `services/api/src/playback/metrics.ts`, `services/chat/src/metrics.ts`). This step creates `services/api/src/metrics.ts` as an OTel meter module (§4.6)                                                                                                                                                                                                 |
| W1-watch-gate owns `services/chat/src/cache.ts` "for the cached Valkey read"               | `cache.ts` is the generic `TtlCache` used by `directory.ts` (`services/chat/src/cache.ts:1-56`). The gate's reader is a **new** `services/chat/src/watch-gate.ts` (stub here); `cache.ts` is untouched                                                                                                                                                                                                                                                         |
| W1-spine owns `persistence.ts` "writing `media_ts`"                                        | `MessageRow` is `schema.chatMessages.$inferInsert` (`persistence.ts:15`): once the column exists the writer stores whatever `core.ts` enqueues. This step passes `mediaTs` through `core.ts` (§5); **nobody edits `persistence.ts`**                                                                                                                                                                                                                           |
| The clamp needs `startedAt` and the channel median                                         | `ChannelState` has `liveBroadcastId` only (`services/chat/src/types.ts:48-60`, loaded at `directory.ts:116-155` from `channels` alone). This step adds `liveStartedAt` (§5) and a `ChannelLatency` reader stub                                                                                                                                                                                                                                                 |
| "A chat user card" for the block action                                                    | No user card exists. Messages carry a moderators-only `ModMenu` (`apps/web/src/chat/mod-menu.tsx`, mounted in `chat-panel.tsx`). W1-calm-chat turns it into a per-message menu for every signed-in viewer (block for all, timeout/ban for moderators)                                                                                                                                                                                                          |
| The verified-watch and chat-latency writers "run at the end of each `score-sessions` pass" | Both live in `services/worker/src/integrity/jobs.ts` `runScoring` (:96-131). Two units would edit it, so this step adds both calls to stubs (§6.2)                                                                                                                                                                                                                                                                                                             |
| `avoidCdn` is W1-watch-gate's, minting is W1-data-mode's                                   | Both are in `services/api/src/routes/playback.ts` `start` (:139-211). This step computes `avoidCdn` there completely (§4.4); W1-data-mode owns the file afterwards for `dm`                                                                                                                                                                                                                                                                                    |
| Studio settings component for the gate                                                     | No studio page edits chat settings today (chat modes are set by `/slow` etc. in chat). This step adds a placeholder studio route **`/chat`** (`chat` is already reserved, `services/api/src/auth/identity.ts:28`) that W1-watch-gate fills                                                                                                                                                                                                                     |
| "`timeline-sync`: replay order matches media time"; feature-wins: replay UI                | There is no public VOD or clip watch page in `apps/web` (VODs and clips appear only in the owner's `/content` board). Replay ships as **`vods.chat` / `clips.chat` API procedures** in W1; the replay panel is deferred to W2 (decided 2026-10-30, §13)                                                                                                                                                                                                        |
| Data mode: "the origin keeps only variants under `dm`, plus the audio-only variant"        | The origin synthesizes a multivariant only **when the ladder runs** (`services/origin/src/handler.ts:120-141`, `renditions.length > 0`), and the ladder starts at `TRANSCODE_VIEWER_THRESHOLD` (default 50 viewers, `packages/config/src/env.ts:257`). On a source-only channel there is no audio-only variant at all. W1-data-mode makes the origin synthesize for `dm` tokens even without renditions (its brief)                                            |
| Data mode floor "about 86 MB an hour"                                                      | 86 MB/h is the derived variant's advertised 192 kbit/s (`playlist.ts:157`), used only on source-only channels. With the ladder running the audio rung is 96 kbit/s AAC (`services/media/src/transcode/ladder.ts:27`), about 50 MB/h with container overhead. §8.3 has the budget table                                                                                                                                                                         |
| `message_set` report subject: "a small contract change"                                    | `safety.report` takes one `subjectId` (`router.ts:2525-2541`), `report_subject` is a Postgres enum (`schema/safety.ts:223`), and `resolve`'s `remove_content` handles one message (`routes/safety.ts:247-251`). §1.3 adds `messageIds`; this step implements report and resolve for `message_set` in `routes/safety.ts`                                                                                                                                        |
| A receipt email with the breakdown (`packages/email/src/templates/payments.tsx`)           | No payment receipt email exists (`templates/payments.tsx` has `payoutSent` and `chargebackNotice` only), and sending one means editing the posting paths (`confirmPaymentTx`, `stripe-events.ts`) W2-splits takes over. **Deferred to M1** (decided 2026-10-30, §13); W1-breakdown sends no email                                                                                                                                                              |
| User blocks: ADR 0012 decision 8 (a W1 unit), ADR 0017 (W3's contract step)                | **Decided (2026-10-30):** blocks land here (§2, `me.blocks.*`) and in W1-calm-chat (block action, live-chat hiding). ADR 0017 carries a dated note that its "W3's contract step adds them" line is superseded by ADR 0012 decision 8; PROGRESS records it                                                                                                                                                                                                      |
| ADR 0015 GA criterion 1, "W0-integrity's CDN fetch-judging"                                | W0-integrity merged only the `fetch_unjudged` marker. **Decided (user, 2026-10-30):** CDN fetch-judging is owned by S1 stage 4 (the CDN adapter's home; noted in `.claude/briefs/next/S1-scaling.md`), not W1. The gate ships behind `CHAT_WATCH_GATE=off`; GA waits for S1 stage 4                                                                                                                                                                            |
| Heartbeat mode field: ADR 0012/0016 `playbackMode`, feature-wins §4.12 `mode`              | The code has neither (`Heartbeat`, `entities.ts:278-307`). **`playbackMode`** (the ADRs win), on the chat `send` frame and the heartbeat alike                                                                                                                                                                                                                                                                                                                 |

Already right, do not redo: PDT passthrough tests (`services/origin/tests/playlist.test.ts`,
`relay/internal/hls/rewrite_test.go`); `gateEligible` / `GATE_ELIGIBLE`
(`packages/integrity/src/score.ts:97`, `jobs.ts:47`); the `follow_burst` signal
(`packages/integrity/src/channel.ts:117`); `media/visibility.ts` (`vodShown`, `vodVisible`,
`viewerAudience`) for replay's playability check; the worker's outbox and audit helpers
(`services/worker/src/moderation/records.ts` `emit`, `audit`); `withRunLock`
(`services/worker/src/integrity/lock.ts`); the ops test hook (`services/api/src/ops/hooks.ts`,
`OPS_TICK_JOBS` at `internal.ts:571`), which this step extends instead of adding a new hook.

### Decisions applied (2026-10-30)

The user and the orchestrator settled these before wave 1 (§13 has the full list; the batch
README's decision table records them).

| Decision                                                                                                                                       | Where                                | Decided by                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------ |
| (a) User blocks in W1 (table, `me.blocks.*`, the block action, hiding blocked users in live chat), not W3                                      | §1.3, §2, §4.2, W1-calm-chat         | orchestrator (ADR 0012 decision 8 already) |
| (b) CDN fetch-judging (ADR 0015 GA criterion 1) belongs to S1 stage 4; the gate ships behind `CHAT_WATCH_GATE=off` and GA waits for S1 stage 4 | §7, W1-watch-gate                    | user, 2026-10-30                           |
| (c) Data-mode budgets: the presets and constants in §1.1 `DATA_MODE` and §8.3; no ladder change in W1                                          | §1.1, §8.3, W1-data-mode             | user, 2026-10-30                           |
| (d) Payment fraud floor as ADR 0036 (accepted 2026-10-30); a `confirmed` flag keeps holding until an admin's audited release                   | §1.1, §1.3, §1.5, §2, W1-fraud-floor | user, 2026-10-30                           |

## 1. Contracts (`packages/contracts`)

### 1.1 `src/enums.ts` (append after `ENFORCEMENT_SOURCE_ACTIONS`, :349-359)

```ts
// Feature wins, wave 1 (W1; docs/testing/w1-selectors.md) ----------------------------------

/** Where a viewer's playhead is (ADR 0012 amendment 1 decision 1, ADR 0016 decision 6). */
export const PLAYBACK_MODES = ["live", "dvr"] as const;
/** User-to-user blocks (ADR 0012 amendment 1 decision 8; built in W1, not W3). */
export const BLOCK_RULES = { maxPerUser: 1000 } as const;
/** A "Report wave" (Calm Chat) groups at most this many messages of one channel. */
export const MESSAGE_SET_RULES = { minMessages: 2, maxMessages: 50 } as const;
/** `PaymentBreakdown.lines[].kind` (feature-wins §4.1). Gross side: tax, creator, coop_share, reversal. Co-op expense side: processor_fee, dispute_fee. Derived: coop_net. */
export const BREAKDOWN_LINE_KINDS = [
  "tax",
  "creator",
  "coop_share",
  "processor_fee",
  "coop_net",
  "reversal",
  "dispute_fee",
] as const;
/** The part of gross a `reversal` line takes back. */
export const BREAKDOWN_COMPONENTS = ["tax", "creator", "coop_share"] as const;
/** `PaymentBreakdown.timeline[].kind`, one per ledger transaction of the payment. */
export const BREAKDOWN_EVENT_KINDS = ["paid", "hold_released", "refunded", "charged_back", "chargeback_won"] as const;
/** The governance keys the fee schedule shows (`coop.feeSchedule`). */
export const FEE_SCHEDULE_KEYS = ["platform.cut", "payout.rules"] as const;
/**
 * The Support dialog's "typical fee" estimate (feature-wins §4.1): a range, labelled an estimate,
 * because card country and tax are unknown before payment. Accepted 2026-10-30 (Stripe's published
 * card pricing spans roughly 1.5 % + 25 ¢ for domestic EEA cards to 3.9 % + 30 ¢ with an
 * international surcharge); `manual` has no processor fee.
 */
export const PROCESSOR_FEE_ESTIMATE = {
  manual: null,
  stripe: { lowBps: 150, highBps: 390, fixedCents: 30 },
} as const;
/** Payment fraud floor (ADR 0036, W1-fraud-floor). */
export const PAYMENT_FRAUD_KINDS = ["payer_velocity", "payer_concentration", "new_payee", "manual"] as const;
/** open → reviewed (first treasurer) → cleared | confirmed (a second treasurer or an admin). A confirmed flag holds until an admin releases it (ADR 0036 decision 3). */
export const PAYMENT_FRAUD_STATUSES = ["open", "reviewed", "cleared", "confirmed"] as const;
export const PAYMENT_FRAUD_DECISIONS = ["clear", "confirm"] as const;
/**
 * The scan's thresholds (W1-fraud-floor). Ids, counts and cents only reach evidence.
 * - payer_velocity: one payer's succeeded payments to any channel in `velocityWindowMinutes` above
 *   `velocityMaxPayments` flags every payee of that window.
 * - payer_concentration: over the last `concentrationWindowDays`, when a payee's gross is at least
 *   `concentrationMinGrossCents` and either the top `concentrationTopN` payers bring at least
 *   `concentrationShare` of it, or payers whose accounts were younger than `newPayerAccountDays` at
 *   payment bring at least `newPayerShare` of it.
 * - new_payee: a payee's first payout ever at or above `newPayeeFirstPayoutCents`.
 */
export const PAYMENT_FRAUD_RULES = {
  velocityWindowMinutes: 60,
  velocityMaxPayments: 10,
  concentrationWindowDays: 30,
  concentrationMinGrossCents: 50_000,
  concentrationTopN: 3,
  concentrationShare: 0.8,
  newPayerAccountDays: 7,
  newPayerShare: 0.5,
  newPayeeFirstPayoutCents: 50_000,
} as const;
/** `payouts.hold_reason` while the payee has a holding fraud flag: open, reviewed, or confirmed and not released (DB-enforced, migration 0038). */
export const FRAUD_REVIEW_HOLD = "fraud_review";
/**
 * Data mode (ADR 0018). Accepted 2026-10-30 (§8.3 has the derivation).
 * `ceilingFor(mbPerHour)` = round(mbPerHour × 8 000 000 / 3600 / overheadFactor), clamped to the
 * claim's [32 000, 8 000 000] bit/s.
 */
export const DATA_MODE = {
  /** fMP4 boxes, LL-HLS part and playlist polling on top of the media bitrate (measured by W1-data-mode). */
  overheadFactor: 1.15,
  minCeilingBps: 32_000,
  maxCeilingBps: 8_000_000,
  /** Budget presets in MB per hour: audio only, ≤ 480p, ≤ 720p. */
  presetsMbPerHour: [50, 800, 1900] as const,
  /** Custom budget bounds (the claim bounds through the formula: about 16.6 and 4140 MB/h). */
  minMbPerHour: 20,
  maxMbPerHour: 4000,
} as const;
export const dataModeCeilingBps = (mbPerHour: number): number =>
  Math.min(
    DATA_MODE.maxCeilingBps,
    Math.max(DATA_MODE.minCeilingBps, Math.round((mbPerHour * 8_000_000) / 3600 / DATA_MODE.overheadFactor)),
  );
```

- `REPORT_SUBJECTS` (:126): append `"message_set"`.
- `PAYOUT_STATUSES` unchanged (a fraud hold is `held` with `hold_reason = 'fraud_review'`).

### 1.2 `src/shapes.ts`

- `ChannelChatSettings` (:33-44), add after `linksAllowed` (ADR 0015 decisions 6 and 7):

```ts
  /**
   * Verified-watch gate (ADR 0015 decision 7): seconds of gate-eligible watching this broadcast a
   * signed-in viewer needs before chatting; 0 = off, else 60–3600. Applies only while the instance
   * flag `CHAT_WATCH_GATE` is on (`instance.info` `features.watchGate`).
   */
  minVerifiedWatchSeconds: z
    .number()
    .int()
    .refine((s) => s === 0 || (s >= 60 && s <= 3600), "0 (off) or 60–3600")
    .default(0),
  /** Subscribers skip the gate (broadcaster, moderators, VIPs and verified bots always do). */
  verifiedWatchExemptSubscribers: z.boolean().default(true),
  /** Surge guard (ADR 0015 decision 6). Applies only while `CHAT_SURGE_GUARD` is on (`features.surgeGuard`). */
  surgeGuard: z
    .object({
      enabled: z.boolean().default(false),
      /** Share of new sessions older than 60 s that are not gate-eligible which trips the guard. */
      triggerUnverifiedRatio: z.number().min(0.1).max(1).default(0.5),
      cooldownMinutes: z.number().int().min(1).max(120).default(10),
    })
    .default({ enabled: false, triggerUnverifiedRatio: 0.5, cooldownMinutes: 10 }),
```

`chat.updateSettings` keeps `ChannelChatSettings.partial()` (`router.ts:893`): `surgeGuard` is
sent whole. Every place that builds a settings object from defaults (`ChannelChatSettings.parse({})`,
`directory.ts:147`) picks the new defaults up; fix any test that pins the full settings object
(`git grep -n "linksAllowed" -- '*.test.ts'`).

### 1.3 `src/api/entities.ts` and `src/api/router.ts`

Entities (new, after `RevenueLine`, :449-467, unless noted):

```ts
export const BreakdownLine = z.object({
  kind: z.enum(E.BREAKDOWN_LINE_KINDS),
  /** Signed: gross-side lines positive, reversal lines negative; fees positive (a co-op expense); coop_net signed. */
  amount: Money,
  /** Set on `creator` lines (one per recipient; Ledger Splits adds crew lines) and on creator `reversal` lines. */
  recipientUserId: Id.nullable(),
  /** `reversal` lines only: which part of gross they take back. */
  component: z.enum(E.BREAKDOWN_COMPONENTS).nullable(),
  /** The ledger transaction the line comes from; null for the derived `coop_net`. */
  transactionId: Id.nullable(),
});
export const PaymentBreakdown = z.object({
  paymentId: Id,
  kind: z.enum(E.PAYMENT_KINDS),
  channel: z.object({ slug: Slug, displayName: z.string() }),
  /** Who is looking: the payer, or the channel owner (payee). */
  viewerRole: z.enum(["payer", "payee"]),
  /** Null when the payment is anonymous and the viewer is the payee (`payments.anonymous`). */
  payer: UserPublic.pick({ id: true, username: true, displayName: true }).nullable(),
  gross: Money,
  succeededAt: Timestamp,
  lines: z.array(BreakdownLine),
  /** `succeededAt + payout.rules.holdDays`; null once released. */
  holdReleasesAt: Timestamp.nullable(),
  holdReleasedAt: Timestamp.nullable(),
  /** The `platform.cut` that fixed the split (`cutHistoryId` in the posting; null history id = the founding seed). */
  cutSource: z.object({
    historyId: Id.nullable(),
    changedAt: Timestamp.nullable(),
    proposalId: Id.nullable(),
    streamerShare: z.number(),
    coopShare: z.number(),
  }),
  timeline: z.array(
    z.object({ kind: z.enum(E.BREAKDOWN_EVENT_KINDS), at: Timestamp, amount: Money.nullable(), transactionId: Id }),
  ),
});
export const FeeScheduleEntry = z.object({
  /** `governance_settings_history.id`; null for the founding seed value (no history row exists for it). */
  id: Id.nullable(),
  key: z.enum(E.FEE_SCHEDULE_KEYS),
  value: z.record(z.string(), z.unknown()),
  previous: z.record(z.string(), z.unknown()).nullable(),
  /** Null for the seed. */
  changedAt: Timestamp.nullable(),
  proposalId: Id.nullable(),
});
export const BlockedUser = z.object({
  user: UserPublic.pick({ id: true, username: true, displayName: true }),
  createdAt: Timestamp,
});
export const SurgeState = z.object({
  /** `off`: no override. `on`: surge mode (gate at max(minVerifiedWatchSeconds, 60)). `suppressed`: a moderator ended it; no re-trigger until `until`. */
  state: z.enum(["off", "on", "suppressed"]),
  since: Timestamp.nullable(),
  until: Timestamp.nullable(),
  /** Who started or ended it by hand; null for the job. */
  by: UserPublic.pick({ id: true, username: true }).nullable(),
  /** Valkey could not be read: the gate fails open (ADR 0015 decision 1). */
  unavailable: z.boolean(),
});
export const PaymentFraudFlag = z.object({
  id: Id,
  payee: UserPublic.pick({ id: true, username: true, displayName: true }),
  kind: z.enum(E.PAYMENT_FRAUD_KINDS),
  status: z.enum(E.PAYMENT_FRAUD_STATUSES),
  /** Ids, counts and cents only. */
  evidence: z.record(z.string(), z.union([z.string(), z.number()])),
  raisedAt: Timestamp,
  /** Null when the scan raised it. */
  raisedBy: UserPublic.pick({ id: true, username: true }).nullable(),
  reviewedBy: UserPublic.pick({ id: true, username: true }).nullable(),
  recommendation: z.enum(E.PAYMENT_FRAUD_DECISIONS).nullable(),
  reviewedAt: Timestamp.nullable(),
  decidedBy: UserPublic.pick({ id: true, username: true }).nullable(),
  decidedAt: Timestamp.nullable(),
  /** A confirmed flag holds until an admin releases it (ADR 0036 decision 3); null otherwise. */
  releasedBy: UserPublic.pick({ id: true, username: true }).nullable(),
  releasedAt: Timestamp.nullable(),
  note: z.string(),
  /** Payouts of this payee held for review now. */
  heldPayouts: z.number().int(),
});
export const ChatReplayPage = z.object({
  items: z.array(
    ChatMessage.extend({
      /** Where replay places the line: `mediaTs`, or `createdAt` for a message sent while catching up. */
      at: Timestamp,
      /** Sent in DVR mode (`mediaTs` null): shown as "said while catching up". */
      catchingUp: z.boolean(),
    }),
  ),
  nextCursor: z.string().nullable(),
  /** False once the window's messages have aged out (ADR 0012 amendment 1 decision 6): the UI says chat is no longer kept. */
  retained: z.boolean(),
});
```

In place:

- `ChatMessage` (:326-341), after `replyTo`:
  `/** PDT under the sender's playhead, clamped by chat (ADR 0012 amendment 1 decisions 1-4); null when the channel was not live, in DVR mode, or for history rows written before W1. Optional so Twitch-shaped fixtures need no churn; every live frame and history row sets it. */ mediaTs: Timestamp.nullable().optional(),`
- `PlaybackStart` (:243-276), after `captions`:
  `/** The data-mode ceiling in the session's token (ADR 0018), null when off. */ dataMode: z.number().int().nullable(),`
- `Heartbeat` (:278-307), after `muted`:

```ts
  /** ADR 0012 amendment 1 / ADR 0016 decision 6. Absent = `live`. Accepted from W1, recorded from W2-dvr on. */
  playbackMode: z.enum(E.PLAYBACK_MODES).optional(),
  /** Seconds behind the live edge in `dvr` mode (W2-dvr); accepted and ignored in W1. */
  behindLiveSeconds: z.number().min(0).max(86_400).nullable().optional(),
  /** ADR 0018 decision 3: the data-mode ceiling in bit/s, null = turn off, absent = unchanged. */
  dataMode: z.number().int().min(E.DATA_MODE.minCeilingBps).max(E.DATA_MODE.maxCeilingBps).nullable().optional(),
```

- `InstanceInfo.features` (:1232-1240), after `vod`:
  `/** CHAT_WATCH_GATE (ADR 0015 decision 7): the studio shows the gate setting only when true. */ watchGate: z.boolean(), /** CHAT_SURGE_GUARD (ADR 0015 decision 6). */ surgeGuard: z.boolean(),`
- `RevenueLine` (:449-467), after `id`: `/** The payment the line belongs to (payments and their reversals); null for payouts. The breakdown entry point. */ paymentId: Id.nullable(),`
  — the `money.revenueLedger` handler (`services/api/src/money/reports.ts`, re-find
  `revenueLedger`) fills it from `ledger_transactions.ref_id` where `ref_type = 'payment'`; update
  its tests and the web fixtures that build `RevenueLine` (`git grep -ln "deductions" apps/web/tests harness`).
- `SupportInfo` (:468-486), after `gift`:
  `/** "Typical fee" range for the estimate (PROCESSOR_FEE_ESTIMATE[provider]); null when the provider charges none. */ feeEstimate: z.object({ lowBps: z.number().int(), highBps: z.number().int(), fixedCents: z.number().int() }).nullable(),`

Router (`src/api/router.ts`; import `DATA_MODE`, `MESSAGE_SET_RULES`, `BLOCK_RULES` from enums
via the existing `* as E`):

- `me` (:96-310), after `bots` (:273-309), a new group (session callers only: no `scopes`, so
  app tokens cannot reach it, like `me.deletion`):

```ts
    blocks: {
      list: user
        .route({ method: "GET", path: "/me/blocks", summary: "Users you blocked", ...tag("Users") })
        .input(PageInput)
        .output(page(D.BlockedUser)),
      /** All blocked user ids (at most BLOCK_RULES.maxPerUser), for hiding them in live chat. */
      ids: user
        .route({ method: "GET", path: "/me/blocks/ids", summary: "Ids of users you blocked", ...tag("Users") })
        .output(z.object({ userIds: z.array(Id).max(E.BLOCK_RULES.maxPerUser) })),
      add: user
        .meta({ access: "user", rateLimit: "write" })
        .route({
          method: "POST",
          path: "/me/blocks",
          summary: "Block a user: hidden from you in chat and chat replay",
          description: "Idempotent. Refused for yourself (BAD_REQUEST) and beyond BLOCK_RULES.maxPerUser (PRECONDITION_FAILED `block_limit`).",
          ...tag("Users"),
        })
        .input(z.object({ username: Slug }))
        .output(D.BlockedUser),
      remove: user
        .meta({ access: "user", rateLimit: "write" })
        .route({ method: "DELETE", path: "/me/blocks/{username}", summary: "Unblock a user", ...tag("Users") })
        .input(z.object({ username: Slug }))
        .output(Ok),
    },
```

- `playback.start` input (:688-698): add
  `/** ADR 0018: the data-mode ceiling in bit/s, null or absent = off. */ dataMode: z.number().int().min(E.DATA_MODE.minCeilingBps).max(E.DATA_MODE.maxCeilingBps).nullable().default(null),`
- `vods` (:749-782), after `remove`:

```ts
    /** ADR 0012 amendment 1 decisions 5 and 7: the broadcast's chat in media-time order; served exactly when the VOD is playable to the caller; filtered per viewer (blocks), never shared-cached. */
    chat: base
      .route({ method: "GET", path: "/vods/{id}/chat", summary: "Chat replay for a VOD", ...tag("VODs") })
      .input(z.object({ id: Id, cursor: z.string().max(200).optional(), limit: z.number().int().min(1).max(500).default(200) }))
      .output(D.ChatReplayPage),
```

- `clips` (:784-828), after `remove`: the same as `chat` with path `/clips/{id}/chat`, summary
  "Chat replay for a clip (the wall-clock window it was cut from)", tag "Clips".
- `chat` (:830-…), after `connectToken`:

```ts
    surge: {
      state: mod
        .meta({ access: "moderator", scopes: ["moderator:manage:chat"] })
        .route({ method: "GET", path: "/channels/{channel}/chat/surge", summary: "Surge-guard state", ...tag("Moderation") })
        .input(ChannelRef)
        .output(D.SurgeState),
      /** ADR 0015 decision 6: one click; `end` writes `suppressed` for the cooldown. Audited, with an outbox event. */
      override: mod
        .meta({ access: "moderator", scopes: ["moderator:manage:chat"], rateLimit: "write" })
        .route({ method: "POST", path: "/channels/{channel}/chat/surge", summary: "Start or end surge mode by hand", ...tag("Moderation") })
        .input(ChannelRef.extend({ action: z.enum(["start", "end"]) }))
        .output(D.SurgeState),
    },
```

- `money` (:1033-1321): after `statement` (:1195-1203):

```ts
    /** feature-wins §4.1. The payer, or the owner of the payee channel; anything else is NOT_FOUND (ids are time-ordered, so authorization is the guard). */
    paymentBreakdown: user
      .route({ method: "GET", path: "/payments/{paymentId}/breakdown", summary: "Where one payment's money went", ...tag("Monetization") })
      .input(z.object({ paymentId: Id }))
      .output(D.PaymentBreakdown),
    paymentBreakdowns: user
      .route({ method: "GET", path: "/me/payment-breakdowns", summary: "Breakdowns of your payments, or of payments to your channel", ...tag("Monetization") })
      .input(PageInput.extend({ role: z.enum(["payer", "payee"]).default("payer") }))
      .output(page(D.PaymentBreakdown)),
```

and in `treasurer` (:1205-1319), after `recordCost`:

```ts
      fraudFlags: {
        list: treasurer
          .route({ method: "GET", path: "/treasurer/fraud-flags", summary: "Payment fraud flags", ...tag("Treasury") })
          .input(PageInput.extend({ status: z.enum(E.PAYMENT_FRAUD_STATUSES).optional() }))
          .output(page(D.PaymentFraudFlag)),
        raise: treasurer
          .route({ method: "POST", path: "/treasurer/fraud-flags", summary: "Hold a payee's payouts for fraud review", ...tag("Treasury") })
          .input(z.object({ username: Slug, note: z.string().max(500).default("") }))
          .output(D.PaymentFraudFlag),
        review: treasurer
          .route({ method: "POST", path: "/treasurer/fraud-flags/{id}/review", summary: "First review: recommend clearing or confirming", ...tag("Treasury") })
          .input(z.object({ id: Id, recommendation: z.enum(E.PAYMENT_FRAUD_DECISIONS), note: z.string().max(500).default("") }))
          .output(D.PaymentFraudFlag),
        /** Four eyes: a different treasurer, or an admin, than the reviewer (database-enforced). Clearing releases the payee's fraud holds when no other flag is open. */
        decide: finance
          .route({ method: "POST", path: "/treasurer/fraud-flags/{id}/decide", summary: "Second review: clear or confirm", ...tag("Treasury") })
          .errors(SECOND_APPROVER)
          .input(z.object({ id: Id, decision: z.enum(E.PAYMENT_FRAUD_DECISIONS), note: z.string().max(500).default("") }))
          .output(D.PaymentFraudFlag),
        /** ADR 0036 decision 3: an admin's audited account action, the only release of a confirmed flag (database-enforced: admin, not the payee, once). Releases the payee's fraud holds when no other flag holds. */
        release: admin
          .route({ method: "POST", path: "/treasurer/fraud-flags/{id}/release", summary: "Admin: release the payouts a confirmed fraud flag holds", ...tag("Treasury") })
          .input(z.object({ id: Id }))
          .output(D.PaymentFraudFlag),
      },
```

(`SECOND_APPROVER` already exists in `common.ts` for ADR 0020's two-person rule; reuse it.
`release` takes no free text: the audit row carries ids and enums only. No admin web page calls it
in W1; the operator guide documents the call.)

- `coop` (:2109-2430), after `transparency`:
  `feeSchedule: base.route({ method: "GET", path: "/transparency/fee-schedule", summary: "Every change to the platform cut and payout rules, with dates", ...tag("Transparency") }).output(z.array(D.FeeScheduleEntry)),`
- `safety.report` input (:2533-2540): add
  `/** \`message_set\` only (a Calm Chat wave): the messages, all in one channel; \`subjectId\` must be one of them. */ messageIds: z.array(Id).min(E.MESSAGE_SET_RULES.minMessages).max(E.MESSAGE_SET_RULES.maxMessages).optional(),`with`.refine((i) => (i.subjectType === "message_set") === (i.messageIds !== undefined) && (i.messageIds === undefined || i.messageIds.includes(i.subjectId)), { message: "messageIds is required exactly for message_set and must contain subjectId", path: ["messageIds"] })`.
  The `summary` adds "or a wave of chat messages".

### 1.4 `src/chat.ts`

- Imports (:9-13): add `PLAYBACK_MODES` to the enums import and `import { Timestamp } from "./api/common.ts";`.
- `ClientFrame` `send` (:19-26), after `isAction`:

```ts
    /** PDT under the sender's playhead (`playheadWallclock()`), ISO 8601 with offset; a hint chat clamps (ADR 0012 amendment 1 decision 2). */
    mediaTs: Timestamp.optional(),
    /** `dvr` drops the hint (decision 2); absent = `live`. */
    playbackMode: z.enum(PLAYBACK_MODES).optional(),
```

- `NOTICE_CODES` (:41-70): add `"msg_verified_watch"` after `"msg_links_blocked"` (ADR 0015 decision 4:
  one code for every gate denial).
- `ServerFrame` (:72-…), before `pong`:

```ts
  /**
   * Surge guard (ADR 0015 decision 6), on the channel's chat control: sent when surge mode starts,
   * ends or is suppressed by a moderator. Viewers' chat inputs show "watchers-only for now"; the mod
   * view shows why. Published by the `chat-surge-guard` job and the override procedure.
   */
  z.object({
    op: z.literal("surge"),
    channel,
    state: z.enum(["off", "on", "suppressed"]),
    until: z.string().nullable(),
  }),
```

- `ServerFrame` `joined` (:80-86), after `me` (decided 2026-10-30: a viewer who joins mid-surge
  sees the hint at once instead of after the next frame or a denial):

```ts
    /** Surge mode at join (ADR 0015 decision 6); `off` when the guard is off, the channel has none, or Valkey is unreadable. */
    surge: z.object({ state: z.enum(["off", "on", "suppressed"]), until: z.string().nullable() }),
```

- `CONTROL_OPS` (:177): add `"surge"`.
- `services/irc/src/notices.ts` (:31 area): `msg_verified_watch: "msg_verified_watch",` (the IRC
  NOTICE `msg-id`, ADR 0015 decision 4). `services/irc/src/session.ts` (:528 area): `case "surge":
  return; // surge mode has no Twitch IRC line; the denial NOTICE carries it`.
- `apps/web/src/chat/messages.ts` `NOTICES` (:11-40): `msg_verified_watch: "chat.notice.verifiedWatch",`
  and in `apps/web/src/i18n/locales/en/core.json` after `chat.notice.linksBlocked` (:266):
  `"chat.notice.verifiedWatch": "This chat is for viewers who have been watching for a little while. Keep watching (signed in) and try again soon."`;
  regenerate `keys/core.gen.ts` (`bun run i18n:gen`). The web chat connection ignores unknown ops
  today (and drops the `joined`/`settings` frames' `settings`); W1-watch-gate cannot edit
  `connection.ts` (W1-player) or `chat-panel.tsx` (W1-calm-chat), so this step wires both into the
  banner's props (§8.1).

### 1.5 `src/events.ts` (internal events: ids, enums, numbers; never offered to apps)

After the co-op internal block (re-find `"coop.election.update"`), add:

```ts
  // Internal (W1, ADR 0015 decision 6): surge mode. Audited in the same transaction.
  "chat.surge.begin": def({
    version: "1",
    condition: [],
    scopes: [],
    internal: true,
    description: "Internal: surge mode started on a channel (the job or a moderator)",
    payload: {
      trigger: z.enum(["new_sessions", "follow_burst", "moderator"]),
      until: ts,
      by_user_id: id.nullable(),
    },
  }),
  "chat.surge.end": def({
    version: "1",
    condition: [],
    scopes: [],
    internal: true,
    description: "Internal: surge mode ended (cooldown, expiry or a moderator)",
    payload: { reason: z.enum(["cooldown", "expired", "moderator"]), by_user_id: id.nullable() },
  }),
  // Internal (W1-fraud-floor): a payee's payouts are held for, or released from, fraud review.
  "money.fraud.flag": def({
    version: "1",
    condition: [],
    scopes: [],
    internal: true,
    description: "Internal: a payment fraud flag was raised, reviewed, decided or released",
    payload: {
      flag_id: id,
      payee_user_id: id,
      kind: z.enum(PAYMENT_FRAUD_KINDS),
      status: z.enum(PAYMENT_FRAUD_STATUSES),
      /** A confirmed flag an admin released (ADR 0036 decision 3). */
      released: z.boolean(),
      held_payouts: z.number().int(),
    },
  }),
```

| Type               | Payload                                                        | Emitted                                                                                                |
| ------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `chat.surge.begin` | `trigger, until, by_user_id`                                   | `chat-surge-guard` job (`by_user_id` null), `chat.surge.override` `start`                              |
| `chat.surge.end`   | `reason, by_user_id`                                           | the job (`cooldown`, or `expired` when the key lapsed unseen), `override` `end`                        |
| `money.fraud.flag` | `flag_id, payee_user_id, kind, status, released, held_payouts` | the scan job, the payout batch (`new_payee`), `raise`, `review`, `decide`, `release`, same transaction |

`channelId` of the surge rows is the channel; of `money.fraud.flag`, the payee's channel or null.
Import the two enums at the top. Update the catalog snapshot in
`packages/contracts/tests/contract.test.ts` (three new internal types; `PUBLIC_EVENT_TYPES`
unchanged).

### 1.6 `src/internal.ts`

- `KEYS` (:142-236), at the end:

```ts
  /**
   * ADR 0015 decision 1: STRING JSON `VerifiedWatchValue`, `SET … EX 600` by the integrity worker
   * after each scoring pass, for channels with the gate on or the surge guard enabled.
   */
  verifiedWatch: (channelId: string, userId: string) => `verified-watch:${channelId}:${userId}`,
  /** ADR 0015 decision 6: STRING JSON `SurgeOverride`, TTL `until − now + 60 s`. */
  surgeOverride: (channelId: string) => `surge-override:${channelId}`,
  /** ADR 0012 amendment 1 decision 4: STRING, the median viewer latency in seconds, TTL 60 s. */
  chatLatency: (channelId: string) => `chat-latency:${channelId}`,
```

- After `KEYS`:

```ts
/** `KEYS.verifiedWatch` value: broadcast, gate-eligible seconds after jitter, privacy-relay fallback (ADR 0015 decisions 1, 4, 5). */
export const VerifiedWatchValue = z.object({
  b: z.uuid(),
  s: z.number().int().min(0),
  f: z.union([z.literal(0), z.literal(1)]),
});
export type VerifiedWatchValue = z.infer<typeof VerifiedWatchValue>;
/** `KEYS.surgeOverride` value. `by` is a user id or null for the job. */
export const SurgeOverride = z.object({
  state: z.enum(["on", "suppressed"]),
  since: z.string(),
  until: z.string(),
  by: z.uuid().nullable(),
});
export type SurgeOverride = z.infer<typeof SurgeOverride>;
/** ADR 0015 decision 4: verified-watch jitter (seconds) = HMAC-SHA256(INTERNAL_API_SECRET, prefix + broadcastId + ":" + userId) mod 31. */
export const VERIFIED_WATCH_JITTER = { prefix: "vw-jitter-v1:", modulo: 31 } as const;
export const VERIFIED_WATCH_TTL_SECONDS = 600;
/** ADR 0015 decision 4: denied sends per user per channel per minute before `msg_ratelimit`. */
export const WATCH_GATE_ATTEMPTS = { perMinute: 6, bucket: "chat-gate" } as const;
```

- `OPS_TICK_JOBS` (:571): append `"chat-retention", "chat-surge-guard", "money-fraud-scan",
  "money-reconcile"` (harness runs them now through the ops hook; §6.1). `services/api/src/ops/hooks.ts`
  `OPS_JOB_QUEUES` (:28-33) gains `"chat-retention": { queue: QUEUES.retention, name: "chat-retention" }`,
  `"chat-surge-guard": { queue: QUEUES.moderation, name: "chat-surge-guard" }`,
  `"money-fraud-scan": { queue: QUEUES.payments, name: "money-fraud-scan" }`,
  `"money-reconcile": { queue: QUEUES.payments, name: "money-reconcile" }`; extend its test.

### 1.7 `src/tokens.ts` (ADR 0018 decisions 1 and 2)

`PlaybackClaims` (:19-42): after `rid`:

```ts
    /**
     * Data mode (ADR 0018): the viewer's bitrate ceiling in bit/s. Only on origin tokens for a live
     * path; the origin keeps variants with BANDWIDTH ≤ dm plus the audio-only variant. Absent = off.
     */
    dm: z.number().int().min(32_000).max(8_000_000).optional(),
```

and a second refine after the `rid` one:
`.refine((c) => c.dm === undefined || (c.src === "origin" && !c.path.startsWith("vod/")), "dm only on origin tokens for a live path")`.
Signing parses with the schema (`packages/tokens/src/index.ts:71-72`), so nothing can mint `dm`
before this lands.

- **Go mirror** `relay/internal/tokens/playback.go`: `DM int64` on `PlaybackClaims` (:42-52) with
  the comment "0 when absent; set only on origin live tokens (ADR 0018)"; in `parseClaims`
  (:88-131), after the `rid` refine: if `raw["dm"]` is present, `jsonInt` it, require
  32000 ≤ dm ≤ 8000000, `Src == "origin"` and `!strings.HasPrefix(c.Path, "vod/")`, else
  `ErrMalformed`.
- **Vectors** `packages/tokens/src/vectors.ts`: a second playback vector `playbackDataMode`
  (claims `{ v: 1, sid, cid, path: "live/alice", src: "origin", dm: 111111, iat: 1700000000,
  exp: 1700000120 }`, same ids as the relay vector), then `bun run --filter @commonair/tokens
  vectors` (Ed25519 is deterministic: the existing vector is byte-identical). Tests: both suites
  (`packages/tokens/tests`, `relay/internal/tokens/tokens_test.go`) verify both vectors and refuse,
  as malformed: `dm` with `src: "relay"`, `dm` on `vod/…`, `dm: 1000`, `dm: 9000000`, `dm: "1"`.
  Run `go test ./... && go vet ./...` in `relay/`.

## 2. Database (follow `.claude/skills/schema-change/SKILL.md`)

### 2.1 `packages/db/src/schema/_shared.ts`

After the last enum (re-find the E9 `appSuspensionReason` block):

```ts
export const paymentFraudKind = pgEnum("payment_fraud_kind", E.PAYMENT_FRAUD_KINDS);
export const paymentFraudStatus = pgEnum("payment_fraud_status", E.PAYMENT_FRAUD_STATUSES);
export const paymentFraudDecision = pgEnum("payment_fraud_decision", E.PAYMENT_FRAUD_DECISIONS);
```

`reportSubject` picks up `message_set` from the enum.

### 2.2 Schema changes

- `schema/chat.ts` `chatMessages` (:11-38): after `deletedBy`:
  `/** PDT under the sender's playhead, clamped (ADR 0012 amendment 1); null when not live, in DVR mode, or unknown. Receive time (\`createdAt\`) stays authoritative. */ mediaTs: ts(),`and indexes`index("chat_messages_broadcast_media_idx").on(t.broadcastId, t.mediaTs)`(replay,
  decision 1) and`index("chat_messages_created_idx").on(t.createdAt)` (retention, decision 6).
- `schema/chat.ts`, new table after `chatBans`:

```ts
/**
 * User-to-user blocks (ADR 0012 amendment 1 decision 8; built in W1). Personal data: deleted with either account (account deletion pseudonymizes users,
 * so `services/worker/src/deletion/account-deletion.ts` deletes these rows explicitly); never
 * copied into append-only columns.
 */
export const userBlocks = pgTable(
  "user_blocks",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    blockedUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.blockedUserId] }),
    index("user_blocks_blocked_idx").on(t.blockedUserId),
    check("user_blocks_not_self", sql`${t.userId} <> ${t.blockedUserId}`),
  ],
);
```

- `schema/money.ts`, new table after `payouts` (:188-211):

```ts
/**
 * Payment fraud floor (ADR 0036, W1-fraud-floor). A payee with a holding flag (open, reviewed, or
 * confirmed and not released) gets no payout released (migration 0038's trigger); deciding needs
 * two different people (four eyes); only an admin releases a confirmed flag. Flags are never
 * deleted. `evidence` holds ids, counts and cents only; `note` is the treasurers' own text on this
 * mutable row, never copied into the audit log.
 */
export const paymentFraudFlags = pgTable(
  "payment_fraud_flags",
  {
    id: id(),
    payeeUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    kind: paymentFraudKind().notNull(),
    status: paymentFraudStatus().notNull().default("open"),
    evidence: jsonb().$type<Record<string, string | number>>().notNull().default({}),
    /** Null when the scan raised it. */
    raisedById: uuid().references(() => users.id, { onDelete: "restrict" }),
    raisedAt: ts().notNull().defaultNow(),
    reviewedById: uuid().references(() => users.id, { onDelete: "restrict" }),
    recommendation: paymentFraudDecision(),
    reviewedAt: ts(),
    decidedById: uuid().references(() => users.id, { onDelete: "restrict" }),
    decision: paymentFraudDecision(),
    decidedAt: ts(),
    /** ADR 0036 decision 3: the admin who released a confirmed flag; null until then. */
    releasedById: uuid().references(() => users.id, { onDelete: "restrict" }),
    releasedAt: ts(),
    note: text().notNull().default(""),
  },
  (t) => [
    index("payment_fraud_flags_payee_idx").on(t.payeeUserId, t.status),
    // One undecided flag per payee and kind: the scan re-finding it adds nothing.
    uniqueIndex("payment_fraud_flags_open_uq")
      .on(t.payeeUserId, t.kind)
      .where(sql`status in ('open', 'reviewed')`),
  ],
);
```

Export both tables from `schema/index.ts` as the others are. `schema/chat.ts` imports only
`boolean, index, jsonb, pgTable, smallint, text, uniqueIndex, uuid` from `drizzle-orm/pg-core`: add
`check` and `primaryKey`.

### 2.3 Migrations

1. `cd packages/db && bunx drizzle-kit generate --name w1_quick_wins` → **`0037_w1_quick_wins.sql`**.
   drizzle-kit writes `ALTER TYPE "public"."report_subject" ADD VALUE 'message_set';`: keep it
   (Postgres 12+ allows it in the migration transaction; nothing in this migration uses the
   value). Check: three enums, two tables, one column, four indexes (two on `chat_messages`, one on
   `user_blocks`, two on `payment_fraud_flags` incl. the partial unique), one check, FKs.
2. `bunx drizzle-kit generate --custom --name w1_protections` → **`0038_w1_protections.sql`**, SPDX
   header, a header comment listing the rules, `--> statement-breakpoint` separators:

```sql
-- 1. payment_fraud_flags (ADR 0036): inserted open, undecided and unreleased; open -> reviewed by
--    a treasurer or an admin; reviewed -> cleared | confirmed by a different person who is a
--    treasurer or an admin (four eyes); nobody reviews, decides or releases a flag on their own
--    payouts; decided rows are frozen except one release of a confirmed flag by an admin; never
--    deleted.
CREATE FUNCTION commonair_payment_fraud_flag_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment fraud flags are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.reviewed_by_id IS NOT NULL OR NEW.recommendation IS NOT NULL
       OR NEW.reviewed_at IS NOT NULL OR NEW.decided_by_id IS NOT NULL OR NEW.decision IS NOT NULL
       OR NEW.decided_at IS NOT NULL OR NEW.released_by_id IS NOT NULL OR NEW.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'a fraud flag starts open and undecided' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- ADR 0036 decision 3: the one change a decided flag allows, an admin releasing a confirmed one.
  IF OLD.status = 'confirmed' AND OLD.released_at IS NULL AND NEW.released_by_id IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['released_by_id','released_at'])
         IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['released_by_id','released_at']) THEN
    IF NEW.released_at IS NULL THEN
      RAISE EXCEPTION 'a release sets the admin and the time' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.released_by_id = OLD.payee_user_id OR NOT EXISTS (
         SELECT 1 FROM public.users u WHERE u.id = NEW.released_by_id
         AND u.role::text = 'admin' AND NOT u.banned) THEN
      RAISE EXCEPTION 'only an admin other than the payee releases a confirmed fraud flag' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('cleared', 'confirmed') THEN
    RAISE EXCEPTION 'a decided fraud flag is frozen' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.released_by_id IS NOT NULL OR NEW.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'only a confirmed fraud flag is released' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','reviewed_by_id','recommendation','reviewed_at','decided_by_id','decision','decided_at','note'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','reviewed_by_id','recommendation','reviewed_at','decided_by_id','decision','decided_at','note']) THEN
    RAISE EXCEPTION 'a fraud flag changes only by review and decision' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'open' AND NEW.status = 'reviewed' THEN
    IF NEW.reviewed_by_id IS NULL OR NEW.recommendation IS NULL OR NEW.reviewed_at IS NULL
       OR NEW.decided_by_id IS NOT NULL OR NEW.decision IS NOT NULL OR NEW.decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'a review sets the reviewer, the recommendation and the time only' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.reviewed_by_id = OLD.payee_user_id THEN
      RAISE EXCEPTION 'nobody reviews a fraud flag on their own payouts' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = NEW.reviewed_by_id
                   AND u.role::text IN ('treasurer', 'admin') AND NOT u.banned) THEN
      RAISE EXCEPTION 'only a treasurer or an admin reviews a fraud flag' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'reviewed' AND NEW.status IN ('cleared', 'confirmed') THEN
    IF NEW.decided_by_id IS NULL OR NEW.decision IS NULL OR NEW.decided_at IS NULL
       OR NEW.decision::text <> CASE NEW.status WHEN 'cleared' THEN 'clear' ELSE 'confirm' END
       OR NEW.reviewed_by_id IS DISTINCT FROM OLD.reviewed_by_id
       OR NEW.recommendation IS DISTINCT FROM OLD.recommendation THEN
      RAISE EXCEPTION 'a decision sets the decider, a matching decision and the time only' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.decided_by_id = OLD.reviewed_by_id OR NEW.decided_by_id IS NOT DISTINCT FROM OLD.raised_by_id
       OR NEW.decided_by_id = OLD.payee_user_id THEN
      RAISE EXCEPTION 'the second review needs a different person' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = NEW.decided_by_id
                   AND u.role::text IN ('treasurer', 'admin') AND NOT u.banned) THEN
      RAISE EXCEPTION 'only a treasurer or an admin decides a fraud flag' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = OLD.status AND NEW.status IN ('open', 'reviewed')
     AND (to_jsonb(NEW) - 'note') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'note') THEN
    RETURN NEW; -- a note edit
  END IF;
  RAISE EXCEPTION 'fraud flag status % cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER payment_fraud_flags_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payment_fraud_flags
  FOR EACH ROW EXECUTE FUNCTION commonair_payment_fraud_flag_guard();
--> statement-breakpoint
CREATE TRIGGER payment_fraud_flags_no_truncate BEFORE TRUNCATE ON public.payment_fraud_flags
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 2. payouts: while the payee has a holding fraud flag (open, reviewed, or confirmed and not
--    released by an admin), no payout is inserted or moved into pending, scheduled or paid (the
--    fraud floor blocks release, it does not merely flag; ADR 0036 decision 3).
CREATE FUNCTION commonair_payout_fraud_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.status::text IN ('pending', 'scheduled', 'paid')
     AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status)
     AND EXISTS (SELECT 1 FROM public.payment_fraud_flags f
                 WHERE f.payee_user_id = NEW.user_id
                   AND (f.status IN ('open', 'reviewed') OR (f.status = 'confirmed' AND f.released_at IS NULL))) THEN
    RAISE EXCEPTION 'payouts to a payee under fraud review stay held' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payouts_fraud_guard BEFORE INSERT OR UPDATE ON public.payouts
  FOR EACH ROW EXECUTE FUNCTION commonair_payout_fraud_guard();
--> statement-breakpoint
```

Interaction with the account-ready release paths (`checkout-treasurer.ts:446-457`,
`stripe-events.ts:551-561`): they move `held`/`payout_account_not_ready` payouts to `pending`, which
`payouts_fraud_guard` refuses for a flagged payee, failing the whole treasurer call or Stripe
`account.updated` webhook. W1-fraud-floor therefore re-tags a flagged payee's
`held`/`payout_account_not_ready` payouts to `fraud_review` in the transaction that raises the flag
(its brief), so those `UPDATE … WHERE hold_reason = 'payout_account_not_ready'` statements match
nothing; the trigger stays as written (a missed re-tag fails loudly instead of paying out).

Then `CREATE OR REPLACE FUNCTION commonair_configure_app_role(r name)`: the body of the latest
version (`0034_e8_protections.sql:96-125` at `a43aa6b`; re-check `git grep -n 'FUNCTION
   commonair_configure_app_role' packages/db/drizzle` in case E9 or N2 replaced it) unchanged, plus
`-- W1 (0038): fraud flags are never deleted.` and
`EXECUTE format('REVOKE DELETE, TRUNCATE ON public.payment_fraud_flags FROM %I', r);`, and keep
`REVOKE EXECUTE ON FUNCTION commonair_configure_app_role(name) FROM PUBLIC;`. 3. Tests: new `packages/db/tests/w1.int.test.ts` (`createTestDatabase()`, as the app role): a flag
inserted `reviewed` is refused; open → reviewed by a treasurer works, by a plain user is refused
(`42501`); a treasurer reviewing or deciding a flag on their own payouts is refused (`42501`);
reviewed → cleared by the reviewer is refused, by a second treasurer or an admin works; a decided
flag cannot change otherwise; release: a confirmed flag released by an admin works once (a second
release, a treasurer's, the payee-admin's, or a release of an open, reviewed or cleared flag is
refused); DELETE refused; a payout insert as `pending` for a flagged payee fails (`23514`), as
`held` works; `held → pending` fails while the flag is open, reviewed or confirmed, works once it
is cleared, and works once a confirmed flag is released; `user_blocks` refuses a self-block; `chat_messages.media_ts` round-trips.

### 2.4 Numbering for N1

W1 takes **0037** (`w1_quick_wins`) and **0038** (`w1_protections`). **N1 takes 0039 (and 0040 if it
needs a separate protections migration) if W1 took 0037 and 0038.** If this step ends with a
different count, N1 shifts and the orchestrator states the final numbers in N1's base-sha message.
Generate on top of this step's snapshot, never in parallel.

### 2.5 Seed and shared DB helpers

- `packages/db/src/seed.ts` `integrity.thresholds` (:122-…): add `gateUnlocksPerAddress: 5,
  gateFallbackAccountAgeDays: 7` to the value (ADR 0015 decisions 3 and 5). The seed inserts missing
  keys only, so existing volumes keep the old value; the schema default below covers them.
- `packages/integrity/src/thresholds.ts` `IntegrityThresholds` (:15-24): add
  `/** ADR 0015 decision 3: accounts unlocked per exact address per channel per broadcast. */ gateUnlocksPerAddress: z.number().int().min(1).max(100).default(5),`
  and `/** ADR 0015 decision 5: account age privacy-relay viewers need while the gate is on. */ gateFallbackAccountAgeDays: z.number().int().min(0).max(365).default(7),`;
  document both in `packages/integrity/README.md` beside the other thresholds.
- `packages/integrity/src/payments/index.ts` (new stub, **W1-fraud-floor**: a comment naming the
  owner and `export {};`) and `export * from "./payments/index.ts";` in
  `packages/integrity/src/index.ts`, so the unit never edits the barrel.

### 2.6 Legal: privacy policy (ADR 0012 amendment 1 decision 9; draft, counsel not reviewed)

Decided 2026-10-30 (user): this bump lands as a draft that counsel has not reviewed; N1's privacy
bump goes on top of it.

- `packages/db/src/legal/privacy.md`, "What you publish" (:20-21): append "Live chat messages are
  saved with the broadcast and replayed beside its VOD and clips; messages that were deleted or
  moderated are never replayed, and people you block stay hidden from you in replay. Your list of
  blocked users is kept until you remove them or one of you deletes the account."
- "How long we keep it" (:72-78), after the "Account data and content" bullet:
  "- Chat messages: {{chatRetentionDays}} days, or longer while the broadcast's VOD exists, but
  never more than {{chatReplayMaxDays}} days (a report keeps the reported text as evidence)."
  (Not "whichever comes first": ADR 0012 decision 6 keeps a 40-day VOD's chat 40 days.)
- `packages/db/src/legal/index.ts`: `LEGAL_PLACEHOLDERS` gains `"chatRetentionDays"` and
  `"chatReplayMaxDays"`; `services/api/src/lib/legal.ts` renders them from `CHAT_RETENTION_DAYS` and
  `CHAT_REPLAY_MAX_DAYS` (§7; the API loads `chatEnv`). Use the placeholder syntax the file already
  uses (check `PLACEHOLDER_PATTERN`). Bump `PRIVACY_SEED_VERSION` from
  `"2026-10-29-interact-draft"` to `"2026-10-30-chat-replay-draft"` and extend its comment ("…
  and again for chat replay, retention and blocks (ADR 0012 amendment 1)"). Update
  `packages/db/tests/seed.int.test.ts` (`expect(body("privacy")).toMatch(/replayed/)`) and the
  legal render tests for the two placeholders.
- PROGRESS "Legal seed follow-ups": the chat replay and retention text is in; counsel has not
  reviewed it.

## 3. Shared money code

### 3.1 `PaymentMeta` v2 (ADR 0013 decision 2; frozen here, read by W1-breakdown, extended by nobody)

New `packages/ledger/src/meta.ts` (exported from `src/index.ts`):

```ts
/** One recipient's slice of the creator share. A payment with no split: the owner at 10,000 bps. */
export const ShareV2 = z.object({
  userId: z.uuid(),
  role: z.enum(["owner", "crew"]),
  bps: z.number().int().min(0).max(10_000),
  creatorCents: z.number().int(),
});
/** Written by `paymentSucceeded` from W1 on. No v1 reader exists (staging is reset, ADR 0013 decision 2). */
export const PaymentMetaV2 = z.object({
  v: z.literal(2),
  paymentKind: z.enum(["subscription", "tip"]),
  /** The channel owner, payee of record (patronage reads it, `packages/patronage/src/inputs.ts:128`). */
  creatorUserId: z.uuid(),
  provider: z.string(),
  settlement: z.enum(["cash", "receivable"]),
  revenueGrossCents: z.number().int().positive(),
  taxCents: z.number().int().nonnegative(),
  creatorCents: z.number().int().nonnegative(),
  coopCents: z.number().int().nonnegative(),
  feeCents: z.number().int().nonnegative(),
  streamerShare: z.number(),
  coopShare: z.number(),
  /** `governance_settings_history.id` of the `platform.cut` in effect; null = the founding seed. */
  cutHistoryId: z.uuid().nullable(),
  splitVersionId: z.uuid().nullable(),
  /** Sorted by user id; `creatorCents` sums to the payment's `creatorCents`. */
  shares: z.array(ShareV2).min(1),
});
/** One recipient's slice of a reversal: what came from their own lot for this payment, and what the owner's other sources covered (ADR 0013 decision 5). */
export const ReversalShareV2 = z.object({
  userId: z.uuid(),
  role: z.enum(["owner", "crew"]),
  creatorCents: z.number().int(),
  fromOwnLotCents: z.number().int(),
  ownerCoveredCents: z.number().int(),
});
/** Written by `refund`, `chargeback` and `chargebackReversal`. */
export const ReversalMetaV2 = z.object({
  v: z.literal(2),
  disputeId: z.uuid(),
  creatorUserId: z.uuid(),
  provider: z.string(),
  settlement: z.enum(["cash", "receivable"]),
  revenueGrossCents: z.number().int(),
  taxCents: z.number().int(),
  creatorCents: z.number().int(),
  coopCents: z.number().int(),
  receivableCents: z.number().int().optional(),
  disputeFeeCents: z.number().int().optional(),
  feeRefundCents: z.number().int().optional(),
  shares: z.array(ReversalShareV2).min(1),
});
```

- `rules.ts` `PaymentSucceededInput` gains `cutHistoryId: string | null`; `paymentSucceeded` writes
  `PaymentMetaV2.parse({...})` with `v: 2`, `splitVersionId: null` and
  `shares: [{ userId: creatorUserId, role: "owner", bps: 10_000, creatorCents }]`. `reversal()`
  writes `v: 2` and `shares: [{ userId, role: "owner", creatorCents: −split.creatorCents,
  fromOwnLotCents, ownerCoveredCents }]`, computing `fromOwnLotCents` from the entries drawn from
  `own` (the payment's lot) and `ownerCoveredCents` from the rest (liability, other lots,
  receivable); `chargebackReversal` writes `v: 2` and one owner share. Entries and amounts do not
  change.
- `reversals.ts`: delete the v1 `PaymentMeta`/`ChargebackMeta` (:27-47); parse `PaymentMetaV2` and
  `ReversalMetaV2`.
- `settings.ts` `MoneySettings` gains `cutHistoryId: string | null`: `loadMoneySettings` also reads
  `select id from governance_settings_history where key = 'platform.cut' order by changed_at desc,
  id desc limit 1` (null when none: the seed writes no history row).
- Callers pass it: `services/api/src/money/stripe-events.ts:268-283` (`const { cut, cutHistoryId } =
  await loadMoneySettings(tx)`), `services/api/src/money/checkout-treasurer.ts` `confirmPaymentTx`
  (:91-…, re-find `paymentSucceeded({`), and every test fixture that posts a payment:
  `services/worker/tests/e6-fixtures.ts:74`, `services/worker/tests/money.int.test.ts`,
  `services/api/tests/money-reports.int.test.ts`, `packages/ledger/tests/{rules.test,ledger.int.test}.ts`,
  `packages/patronage/tests/patronage.int.test.ts` (`git grep -ln "paymentSucceeded(" -- packages services`).
- Tests (`packages/ledger/tests/rules.test.ts`): v2 metadata parses for a payment, partial refund,
  chargeback and won chargeback; `fromOwnLotCents + ownerCoveredCents = −creatorCents` on every
  reversal; `cutHistoryId` round-trips; an integration test that `loadMoneySettings` returns the
  newest history id after a settings change and null on a fresh seed.
- `packages/ledger/src/breakdown.ts` (new stub, **W1-breakdown**): a comment naming the owner and
  `export {};`, plus `export * from "./breakdown.ts"` in `src/index.ts`, so the unit never edits the
  barrel.
- **Staging reset** (ADR 0013 decision 2): the rc droplet's ledger rows are v1. Record in PROGRESS
  that the staging Postgres volume is recreated (as ADR 0020 did) when this step deploys; there
  is no migration of v1 rows.

### 3.2 `money.support` fee estimate

The `money.support` handler (`services/api/src/money/checkout.ts` or `reports.ts`; re-find
`os.money.support.handler`) sets `feeEstimate: PROCESSOR_FEE_ESTIMATE[provider]`. Update its tests
and the web `SupportInfo` fixtures (`apps/web/tests/support-fixtures.ts`, `git grep -ln "messageMaxLength" apps/web/tests harness`).

### 3.3 `message_set` reports (`services/api/src/routes/safety.ts`)

- `subjectInfo` (:58-92) gains the case `message_set`: load `chatMessages` where `id in
  input.messageIds` (pass them in); all must exist and share one `channelId`, else `NOT_FOUND`
  "Nothing to report was found"; `userId` null (several senders); `evidence: { messages: [{ id,
  userId, body }], senders: <distinct count> }` (as `chat_message` keeps its body, :79-80).
- The advisory lock and duplicate check key on the representative `subjectId` as today.
- `resolve` `remove_content` (:247-251): for `message_set`, set `deletedAt`/`deletedBy` on every id in
  `evidence.messages` not yet deleted, and publish one `delete` control frame per message after
  commit (as the `chat_message` path does); `suspend_user` and `ban_from_channel` on a
  `message_set` → `badRequest("A wave has several senders: act on each message")`.
- `apps/web/src/components/safety/report-dialog.tsx`: optional prop `messageIds?: string[]`,
  forwarded to `safety.report` (W1-calm-chat uses it; no other change there).
- Tests in a new `services/api/tests/safety-wave.int.test.ts` (no `safety*` API test file exists at
  `a43aa6b`; report tests live in `me-enforcement.int.test.ts`/`platform.int.test.ts`, follow their
  setup): a wave report stores every body; mixed channels → `NOT_FOUND`; `messageIds` without
  `message_set` → `BAD_REQUEST`; resolve removes all.

## 4. API scaffolding (`services/api`)

### 4.1 Route files and stubs (so every unit owns disjoint files)

| Procedure(s)                      | Composer edit (orchestrator)                                                             | Stub file (unit-owned)                                                                            | Owner          |
| --------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------- |
| `me.blocks.{list,ids,add,remove}` | `routes/me.ts` `me` (:113-…): `blocks: meBlocks,` after `bots`                           | `routes/me-blocks.ts` (`export const meBlocks = { … }`, all `notImplemented`)                     | W1-calm-chat   |
| `vods.chat`, `clips.chat`         | `routes/vods.ts` `vods` (:131-…): `chat: vodChat,`; `routes/clips.ts`: `chat: clipChat,` | `chat-replay/handlers.ts` (`vodChat`, `clipChat`: `os.vods.chat.handler(notImplemented)` …)       | W1-spine       |
| `chat.surge.{state,override}`     | `routes/chat.ts`: `surge: chatSurge,`                                                    | `chat/surge.ts` (`export const chatSurge = { state, override }`)                                  | W1-watch-gate  |
| `money.paymentBreakdown(s)`       | `routes/money.ts` (:8-12): `...breakdownHandlers,`                                       | `money/breakdown.ts` (`export const breakdownHandlers = { paymentBreakdown, paymentBreakdowns }`) | W1-breakdown   |
| `coop.feeSchedule`                | `routes/coop.ts` (:24 area): `feeSchedule: feeScheduleHandler,`                          | `money/fee-schedule.ts`                                                                           | W1-breakdown   |
| `money.treasurer.fraudFlags.*`    | `routes/money.ts`: `treasurer: { ..., fraudFlags: treasurerFraudHandlers }`              | `money/fraud.ts`                                                                                  | W1-fraud-floor |

`router.ts` is unchanged (same namespaces). After the step, `grep -c '.handler(notImplemented)'`
over the six stub files totals 4 + 2 + 2 + 2 + 1 + 4 = **15**.

### 4.2 `chat.updateSettings` (`routes/chat.ts:199-…`)

While `CHAT_WATCH_GATE` is off, an input with `minVerifiedWatchSeconds > 0` →
`precondition("watch_gate_off", "The verified-watch gate is not enabled on this instance")`; while
`CHAT_SURGE_GUARD` is off, `surgeGuard.enabled: true` → `precondition("surge_guard_off", …)`. Other
fields save as today. Tests in the chat route tests.

### 4.3 `instance.info` (`routes/instance.ts:115-122`)

`watchGate: env.CHAT_WATCH_GATE === "on", surgeGuard: env.CHAT_SURGE_GUARD === "on"`. Update the
`instance.info` tests and every `InstanceInfo` fixture in `apps/web/tests` (`git grep -ln "p2pDefault" apps/web/tests harness`).

### 4.4 `assignSource` (`playback/delivery.ts`) and `playback.start`

- `AssignInput` (:31-36) gains `/** ADR 0015 decision 2: no CDN for a signed-in viewer of a gated or surging channel. */ avoidCdn?: boolean;`
  and `/** ADR 0018 decision 4: data-mode sessions are origin sessions. */ originOnly?: boolean;`.
  `assignSource` (:47-64): `if (input.originOnly) return { source: "origin" };` first; the CDN
  branch requires `!input.avoidCdn`. Tests in `services/api/tests/delivery.test.ts`: originOnly with
  relays and CDN → origin; avoidCdn above the threshold → relay draw or origin, never cdn; neither →
  today's behaviour.
- `playback.start` (`routes/playback.ts:153-163`): compute
  `avoidCdn = caller !== undefined && (watchGateOn(c) || (await surgeActive(deps, c.id)))` where
  `watchGateOn(c)` = `deps.env.CHAT_WATCH_GATE === "on"` and the channel's parsed
  `chatSettings.minVerifiedWatchSeconds > 0`, and `surgeActive` = `deps.env.CHAT_SURGE_GUARD ===
  "on"` and `KEYS.surgeOverride(c.id)` holds `state: "on"` (a Valkey error → false: fail toward
  serving). Pass `avoidCdn`; pass `originOnly: false` (W1-data-mode sets it from `input.dataMode`).
  Set `dataMode: null` in the returned `PlaybackStart` (W1-data-mode fills it) and update every
  `PlaybackStart` fixture (`git grep -ln "p2pAvailable" apps/web/tests harness`). Tests in a new
  `services/api/tests/playback-w1.int.test.ts` (no `playback*` API test file exists at `a43aa6b`;
  copy the setup of `p2p-grant.int.test.ts`): a signed-in viewer of a gated channel above the CDN
  threshold is not on the CDN; an anonymous one may be.

### 4.5 Breakdown and block helpers the units share

None: each unit's helpers live in its own files.

### 4.6 `services/api/src/metrics.ts` (new; orchestrator)

```ts
import { meter } from "@commonair/observability";
const m = meter("commonair.api");
/** First-party counters (feature-wins §6). No ids, addresses or user data in labels. */
export const apiMetrics = {
  /** `money.paymentBreakdown` reads that returned a breakdown, by viewer role (payer|payee). */
  breakdownViews: m.createCounter("money.payment_breakdown.views", { description: "Payment breakdowns opened" }),
  /** Surge overrides by moderators, by action (start|end). */
  surgeOverrides: m.createCounter("chat.surge.overrides", {
    description: "Surge mode started or ended by a moderator",
  }),
};
```

Move nothing else into it in this step (`playback/metrics.ts` stays).

### 4.7 Account deletion (`services/worker/src/deletion/account-deletion.ts`, orchestrator)

Beside the `chat_messages` delete (:299-302), add
`await del("user_blocks", tx.delete(s.userBlocks).where(or(eq(s.userBlocks.userId, userId), eq(s.userBlocks.blockedUserId, userId))).returning({ u: s.userBlocks.userId }));`.
Fraud flags stay (money records, `restrict`; ids only, ADR 0004). Test in the account-deletion
integration tests.

**Data export** (`services/worker/src/exports/collectors.ts`, orchestrator; the N1 step edits the
same file on top, so no unit touches it): one account `ExportFile` `blocks.json`, the users the
requester blocked as `{ username, blockedAt }` (public slug and time only, explicit `fields`,
filtered by the requester's id as the file header requires); cases in
`services/worker/tests/export-collectors.test.ts` (two blocks exported, none of another user's);
the `docs/testing/e6-selectors.md` "Data export" row gains `blocks.json`.

## 5. Chat scaffolding (`services/chat`, orchestrator)

- `types.ts`:
  - `ChannelState` (:48-60) gains `/** The live broadcast's \`started_at\` (the clamp's lower bound); null when offline. */ liveStartedAt: Date | null;`
  - New, after `Standing`:

```ts
/** What the verified-watch gate needs for one sender (ADR 0015), loaded by `WatchGate.load`. */
export interface WatchGateState {
  /** Seconds required now: max(minVerifiedWatchSeconds, 60 while surge mode is on); 0 = no gate applies. */
  requiredSeconds: number;
  /** `KEYS.verifiedWatch` for the channel's live broadcast; null when absent or for another broadcast. */
  verified: { broadcastId: string; seconds: number; fallback: boolean } | null;
  /** Surge mode only: the sender had a non-deleted message in the channel before the surge began. */
  surgeExempt: boolean;
  /** `integrity.thresholds.gateFallbackAccountAgeDays`: the account age a `fallback` (privacy-relay) viewer also needs (decision 5). */
  fallbackAccountAgeDays: number;
  /** Valkey could not be read: fail open (decision 1). */
  unavailable: boolean;
}
```

- `Standing` (:62-71) gains `/** Set by core for the send path only; null when no gate applies (and on joins). */ verifiedWatch: WatchGateState | null;`
  and `NO_STANDING` gets `verifiedWatch: null`. `directory.ts` `loadStanding` returns
  `verifiedWatch: null` (the gate state is never cached with the standing).
- `directory.ts` `loadChannel` (:116-155): `liveStartedAt` from `broadcasts.started_at` of
  `row.liveBroadcastId` (one extra select only when it is set; or a left join).
- `clamp.ts` (new stub, **W1-spine**):

```ts
export interface ClampInput {
  receivedAt: Date;
  /** The client's `mediaTs`, parsed; null when absent or unparsable. */
  hint: Date | null;
  playbackMode: "live" | "dvr";
  /** `ChannelState.liveStartedAt`; null = channel not live. */
  liveStartedAt: Date | null;
  /** `KEYS.chatLatency` in seconds, read only when `hint` is null; null = no key. */
  channelLatencySeconds: number | null;
}
/** ADR 0012 amendment 1 decisions 2 and 4. Pure. */
export function clampMediaTs(_i: ClampInput): Date | null {
  return null; // W1-spine
}
```

- `chat-latency.ts` (new stub, **W1-spine**):
  `export class ChannelLatency { constructor(valkey: ValkeyClient, opts?: { ttlMs?: number }) {} async get(_channelId: string): Promise<number | null> { return null; } }`
- `watch-gate.ts` (new stub, **W1-watch-gate**):

```ts
export interface WatchGateDeps {
  valkey: ValkeyClient;
  db: Database;
  limiter: Limiter;
  metrics: Metrics;
  logger: Logger;
  enabled: { watchGate: boolean; surgeGuard: boolean };
}
export class WatchGate {
  constructor(_d: WatchGateDeps) {}
  /** The gate state for one sender; null when neither the gate nor surge mode applies to the channel. */
  async load(_channel: ChannelState, _userId: string, _now: Date): Promise<WatchGateState | null> {
    return null;
  }
  /** After a `msg_verified_watch` rejection: counts the attempt; returns `msg_ratelimit` past WATCH_GATE_ATTEMPTS, else the rejection unchanged. */
  async denied(_channelId: string, _userId: string, r: Rejection, _now: Date): Promise<Rejection> {
    return r;
  }
  /** A `surge` control frame arrived for the channel: drop the cached override so the next send reads it. */
  invalidate(_channelId: string): void {}
  /** Surge state for the `joined` frame (§1.4); `off` on any error (fail open). */
  async surge(
    _channel: ChannelState,
    _now: Date,
  ): Promise<{ state: "off" | "on" | "suppressed"; until: string | null }> {
    return { state: "off", until: null };
  }
}
```

`core.ts` `onControl` (:323-…): before the final `deliver`, `if (msg.op === "surge")
  this.d.watchGate.invalidate(channelId);` (the frame is still delivered to every viewer).

- `core.ts`:
  - `SendInput` (:39-44) gains `mediaTs?: string | null; playbackMode?: "live" | "dvr" | null;`.
  - `CoreDeps` (:51-65) gains `latency: ChannelLatency; watchGate: WatchGate;`.
  - `submit` (:76-170): after `const standing = …` (:86):
    `const gate = user ? await this.d.watchGate.load(channel, user.id, receivedAt) : null; const sendStanding = gate ? { ...standing, verifiedWatch: gate } : standing;`
    and pass `sendStanding` to the pipeline; on a `msg_verified_watch` rejection,
    `rejection = await this.d.watchGate.denied(channel.id, user.id, rejection, receivedAt)` before
    the metric. After acceptance, before building `message`:

```ts
const hint = input.mediaTs ? new Date(input.mediaTs) : null;
const mode = input.playbackMode ?? "live";
const mediaTs = clampMediaTs({
  receivedAt,
  hint: hint && !Number.isNaN(hint.getTime()) ? hint : null,
  playbackMode: mode,
  liveStartedAt: channel.liveStartedAt,
  channelLatencySeconds: hint || mode === "dvr" || !channel.liveStartedAt ? null : await this.d.latency.get(channel.id),
});
```

    `message.mediaTs = mediaTs?.toISOString() ?? null` and the enqueued row `mediaTs`.

- `server.ts` `handleSend` (:273-297): pass `mediaTs: frame.mediaTs ?? null, playbackMode:
  frame.playbackMode ?? null`; the join handler adds `surge: await watchGate.surge(channel, new Date())`
  to the `joined` frame (update the chat tests that pin the frame); construct `ChannelLatency` and `WatchGate` beside the directory and
  pass them in `CoreDeps`; `PluginHost.say` (:548-561) passes neither (bots get the median, decision 4).
- `rules.ts` is **not** changed here (W1-watch-gate adds the gate to `checkGates`; with
  `verifiedWatch` always null until then, nothing changes).
- `metrics.ts`: add `watchGateUnavailable()` (counter `chat.watch_gate.unavailable`).
- Chat env: `main.ts` (:10) loads `.and(chatEnv)` (§7); `startChatService` takes
  `watchGate: env.CHAT_WATCH_GATE === "on", surgeGuard: env.CHAT_SURGE_GUARD === "on"` into
  `WatchGateDeps.enabled`. Update `scripts/selfhost/unit-env.ts` `MAIN_TS_SCHEMAS.chat` (:49) to add
  `"chatEnv"` (its test parses `main.ts`).
- `services/api/src/chat/messages.ts` (:95): `mediaTs: m.mediaTs ? iso(m.mediaTs) : null`.
- Run the chat unit and integration tests and `services/irc` tests.

## 6. Worker scaffolding (`services/worker`)

### 6.1 Job stubs (registered in `src/jobs/index.ts` `JOBS`, :51-93, after the E9 block, with the comment `// Feature wins, wave 1 (W1).`)

Each a `defineJob` with its final queue, name, schedule and a handler returning zeros under the
run-lock pattern of `vod-retention.ts`:

| File (unit-owned)              | Queue               | Name               | Schedule                    | Returns (stub)                        | Owner          |
| ------------------------------ | ------------------- | ------------------ | --------------------------- | ------------------------------------- | -------------- |
| `src/jobs/chat-retention.ts`   | `QUEUES.retention`  | `chat-retention`   | `{ pattern: "41 * * * *" }` | `{ deleted: 0, held: 0 }`             | W1-spine       |
| `src/jobs/chat-surge-guard.ts` | `QUEUES.moderation` | `chat-surge-guard` | `{ every: 30_000 }`         | `{ channels: 0, begun: 0, ended: 0 }` | W1-watch-gate  |
| `src/jobs/money-fraud-scan.ts` | `QUEUES.payments`   | `money-fraud-scan` | `{ every: 900_000 }`        | `{ flagged: 0, held: 0 }`             | W1-fraud-floor |
| `src/jobs/money-reconcile.ts`  | `QUEUES.payments`   | `money-reconcile`  | `{ pattern: "17 3 * * *" }` | `{ payments: 0, mismatches: 0 }`      | W1-breakdown   |

`src/jobs/names.ts` only re-exports webhook names; nothing to add there. Worker env spreads
`chatEnv` (§7) like `coopEnv`.

### 6.2 Post-scoring writers (`src/integrity/jobs.ts` `runScoring`, :96-131)

New stub files: `src/integrity/verified-watch.ts`
(`export async function writeVerifiedWatch(ctx: WorkerContext): Promise<{ channels: number; keys: number }> { return { channels: 0, keys: 0 }; }`, **W1-watch-gate**)
and `src/integrity/chat-latency.ts`
(`export async function writeChatLatency(ctx: WorkerContext): Promise<{ channels: number }> { return { channels: 0 }; }`, **W1-spine**).
In `runScoring`, after `refreshViewerCounts` and before `const counts = …`:

```ts
// W1: writers that read this pass's verdicts (ADR 0015 decision 1, ADR 0012 amendment 1 decision 4).
// A failure is logged and counted, never fails scoring.
const vw = await postScoring(ctx, "verified-watch", () => writeVerifiedWatch(ctx));
const cl = await postScoring(ctx, "chat-latency", () => writeChatLatency(ctx));
```

with a local `postScoring` that catches, logs `integrity post-scoring writer failed` with
`errorFields`, adds `metrics.integrityActions.add(1, { kind: "\${name}_failed" })` and returns null;
add `verifiedWatchKeys: vw?.keys ?? 0, chatLatencyChannels: cl?.channels ?? 0` to `counts`. Run the
worker tests.

## 7. Config

`packages/config/src/env.ts`, after `interactEnv` (:329-332):

```ts
const chatShape = z.object({
  /** ADR 0015 decision 7: the verified-watch gate; `off` until its GA criteria are met (S1 stage 4 owns CDN fetch-judging). */
  CHAT_WATCH_GATE: z.enum(["off", "on"]).default("off"),
  /** ADR 0015 decision 6: the surge guard; stays `off` by default after GA. */
  CHAT_SURGE_GUARD: z.enum(["off", "on"]).default("off"),
  /** ADR 0012 amendment 1 decision 6: days chat is kept when its broadcast has no VOD (the report window). */
  CHAT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  /** Days chat attached to a VOD is kept at most. */
  CHAT_REPLAY_MAX_DAYS: z.coerce.number().int().min(1).max(3650).default(60),
});
export const chatEnv = chatShape.superRefine((env, ctx) => {
  if (env.CHAT_REPLAY_MAX_DAYS < env.CHAT_RETENTION_DAYS)
    ctx.addIssue({
      code: "custom",
      path: ["CHAT_REPLAY_MAX_DAYS"],
      message: "CHAT_REPLAY_MAX_DAYS must be at least CHAT_RETENTION_DAYS",
    });
});
```

Add `chatEnv: chatShape` to `ALL_ENV_SCHEMAS` (:624-650) after `interactEnv` (as `moderationEnv`
does for its shape). Spread into `services/api/src/env.ts` `SCHEMAS` and `services/worker/src/env.ts`;
chat loads it in `main.ts` (§5). Config test: the refine. The worker spreads `.shape`, which drops
the refine: repeat the `CHAT_REPLAY_MAX_DAYS >= CHAT_RETENTION_DAYS` check in `workerEnv`'s
`superRefine` (the retention job is the one that reads both).

**Worker secret (ADR 0015 decision 4).** The verified-watch writer's jitter is
`HMAC-SHA256(INTERNAL_API_SECRET, …)`, but `workerEnv` has no `INTERNAL_API_SECRET` at `a43aa6b`
(it spreads no `internalEnv`; `infra/selfhost/env/commonair-worker.keys` lacks it). Add
`...internalEnv.pick({ INTERNAL_API_SECRET: true }).shape` to `workerEnv` (with a `// W1: verified-watch
jitter (ADR 0015 decision 4)` comment), fix any worker test that builds the env without it, and
regenerate the keys (below) so self-hosted workers receive it. Compose already passes the whole
`.env` (`env_file`), so `compose.yaml` needs nothing.

`.env.example`, after the interactivity block (:129-131):

```
# --- chat (ADR 0012 amendment 1, ADR 0015) ---
# Verified-watch gate and surge guard: off until their GA criteria are met.
CHAT_WATCH_GATE=off
CHAT_SURGE_GUARD=off
# Chat kept 30 days, or with its VOD at most 60 days (CHAT_REPLAY_MAX_DAYS >= CHAT_RETENTION_DAYS).
CHAT_RETENTION_DAYS=30
CHAT_REPLAY_MAX_DAYS=60
```

- `infra/selfhost/env/commonair-{api,chat,worker}.keys`: regenerate with `bun scripts/selfhost/unit-env.ts`
  (never by hand; N1's step regenerates on top; `--check` must stay green). Expect the four `CHAT_*`
  keys in all three and `INTERNAL_API_SECRET` newly in the worker's. `selfhost.sh` needs no flag:
  `init-env --merge` adds the `.env.example` defaults on install and upgrade.
- `docs/self-hosting/configuration.md`: regenerate the table with `bun scripts/config-reference.ts`
  and add a short "Chat retention and the verified-watch gate" paragraph (the two flags stay off
  until GA; retention is the privacy policy's figure).
- `harness/compose.w1.yaml` (new, CC0 header like `harness/compose.e8.yaml`): `api`, `chat` and
  `worker` `CHAT_WATCH_GATE: "on"`, `CHAT_SURGE_GUARD: "on"` (both off by default per channel, so
  other scenarios are unaffected). Add it to `HARNESS_OVERRIDES` (`scripts/infra.ts`, after
  `compose.e9.yaml`) and the tests that count overrides, to the multi-instance replicas
  (`harness/compose.multi-instance.yaml` `api-2`, `chat-2` if present, `worker-2`, with a
  `# harness/compose.w1.yaml` comment) and to the override lists in `harness/README.md`.

## 8. Web scaffolding (`apps/web`)

### 8.1 Routes, nav, placeholders

- New placeholder route `src/routes/_studio/chat.tsx` (`/chat`, studio session guard as
  `_studio/overlays.tsx`, `component: () => <NotFoundState />`), **filled by W1-watch-gate**.
  Regenerate `src/routeTree.gen.ts`. No unit adds, renames or removes a route file.
- `src/lib/nav.ts` `StudioEntry` (:55-56) id `"chat"`, `studioNav` (:153-165) `{ id: "chat", to:
  "/chat", current: path === "/chat" }` after `bot`; `src/routes/_studio.tsx` `studioItem`:
  `data-testid="studio-chat-link"`, Hugeicons `BubbleChatSecureIcon` (or `Message01Icon` if absent:
  check `@hugeicons/core-free-icons`), key `studio.chat` ("Chat safety") in `core.json` next to
  `studio.relays`. Shown only when `features.watchGate || features.surgeGuard` (the route itself
  answers `NotFoundState` otherwise). Update `tests/nav.test.ts`.
- Mount points (the component files are created as stubs returning `null`, owned by the unit named):
  - `src/chat/surge-banner.tsx` (`export function SurgeBanner(props: { channel: string; canModerate: boolean; signedIn: boolean; settings: ChannelChatSettings | null; surge: { state: "off" | "on" | "suppressed"; until: string | null } | null; gateDenied: boolean }): React.JSX.Element | null`) — **W1-watch-gate**; this step renders `<SurgeBanner …/>` above the message list in `src/chat/chat-panel.tsx` and feeds it:
    - `src/chat/connection.ts` `ChatEvents` gains `onSettings?: (settings: ChannelChatSettings) => void` (called from the `joined` and `settings` frames) and `onSurge?: (f: { state: "off" | "on" | "suppressed"; until: string | null }) => void` (`case "surge"`, and from the `joined` frame's `surge`); a test in `apps/web/tests/chat-state.test.ts` beside "ChatConnection ban frames".
    - `chat-panel.tsx` keeps `settings` (latest `onSettings`), `surge` (latest `onSurge`, null until one arrives) and `gateDenied` (true after a `msg_verified_watch` notice, reset on reconnect) in state and passes them. A viewer who joins mid-surge learns it from the `joined` frame's `surge` at once (decided 2026-10-30, §1.4).
  - **Replay disclosure** (ADR 0012 decision 9): this step renders it in `chat-panel.tsx`'s input area (small text, `data-testid="chat-replay-disclosure"`, `t("chat.replayDisclosure")` plus a privacy-policy link labelled `t("chat.replayDisclosureLink")` through `components/legal-document-link.tsx`). It must land with the keys: `apps/web/tests/i18n.test.ts` fails on any catalog key no `src` file uses, and its `UNUSED_ALLOWED` list cannot be shrunk by a unit. W1-calm-chat keeps the line where it is (it may restyle it).
  - `src/components/blocks/blocked-users.tsx` (`export function BlockedUsers(): React.JSX.Element | null`) — **W1-calm-chat**; this step renders it as the last section of `src/routes/_app/settings.privacy.tsx`.
  - `src/components/money/fee-schedule.tsx` (`export function FeeSchedule(): React.JSX.Element | null`) — **W1-breakdown**; this step renders it at the end of `src/components/money/transparency.tsx`.
  - `src/chat/presentation.ts` — **W1-player**; stub with the final API (W1-calm-chat codes against it in the same wave):

```ts
export type PresentationKind = "chat" | "alert";
export interface PresentationItem {
  kind: PresentationKind;
  mediaTs: string | null;
  own: boolean;
}
/** ADR 0012 amendment 1 decision 3: hold an item until the playhead reaches its media time (alerts on, chat off by default, own messages never held, at most 60 s, nothing held in DVR mode). */
export interface PresentationQueue {
  /** Calls `show` now or when the playhead reaches `item.mediaTs`. */
  present<T extends PresentationItem>(item: T, show: (item: T) => void): void;
  /** Per-device opt-in to sync chat lines (localStorage, default off). */
  syncChat: boolean;
  dispose(): void;
}
export function presentationQueue(_opts: { channel: string; creatorView: boolean }): PresentationQueue {
  return { present: (item, show) => show(item), syncChat: false, dispose: () => {} }; // W1-player
}
```

- `src/player/media-clock.ts` — **W1-player**; stub `export function playheadWallclock(_channel: string): Date | null { return null; } export function playbackMode(_channel: string): "live" | "dvr" { return "live"; }` (the registry the player writes and chat reads).

### 8.2 i18n namespaces (created empty here: `locales/en/<name>.json` = `{}` and `keys/<name>.gen.ts` by `bun run i18n:gen`)

| Namespace       | Unit           | Key prefixes                 |
| --------------- | -------------- | ---------------------------- |
| `w1-breakdown`  | W1-breakdown   | `breakdown.`, `feeSchedule.` |
| `w1-calm-chat`  | W1-calm-chat   | `calmChat.`, `blocks.`       |
| `w1-watch-gate` | W1-watch-gate  | `chatGate.`, `surge.`        |
| `w1-fraud`      | W1-fraud-floor | `fraud.`                     |
| `w1-data-mode`  | W1-data-mode   | `dataMode.`                  |

No existing key uses these prefixes (checked at `a43aa6b`). W1-spine and W1-player write no web
strings (the replay disclosure is `chat.replayDisclosure` in `core`, added here:
"Chat is saved with this broadcast's VOD and replayed beside it." and `chat.replayDisclosureLink`:
"How long we keep chat"; this step renders both in the chat input area, §8.1, because an unused
catalog key fails `apps/web/tests/i18n.test.ts`). Units follow
`apps/web/src/i18n/README.md` "How to add a namespace"; none edits `core` or another namespace;
a changed `keys/index.gen.ts` is a contract request. Logical CSS only (`tests/logical-css.test.ts`).
No email strings in W1.

### 8.3 Data-mode budgets (accepted 2026-10-30)

Derivation from the ladder in code (`services/media/src/transcode/ladder.ts:22-27`;
MB/h = kbit/s × 0.45; with the 1.15 overhead factor of `DATA_MODE`):

| Variant (when it exists)                                 | Media kbit/s                  | MB/h (media) | MB/h with overhead                   |
| -------------------------------------------------------- | ----------------------------- | ------------ | ------------------------------------ |
| `audio` rung (ladder running, ≥ 50 viewers)              | 96 (AAC)                      | 43           | ≈ 50                                 |
| derived audio-only (source-only channel; advertised 192) | the streamer's audio, 128–160 | 58–72        | ≈ 66–83 (≤ 99 at the advertised 192) |
| `480p`                                                   | 1200 + 96                     | 583          | ≈ 671                                |
| `720p`                                                   | 3000 + 128                    | 1408         | ≈ 1619                               |
| `1080p`                                                  | 6000 + 160                    | 2772         | ≈ 3188                               |

Presets (`DATA_MODE.presetsMbPerHour`) and their ceilings (`dataModeCeilingBps`):

| Preset | MB/h | `dm` (bit/s) | Plays with the ladder                                         | Plays source-only                                                         |
| ------ | ---- | ------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Audio  | 50   | 96 618       | `audio` rung (fits the budget)                                | derived audio-only (kept below the ceiling; the meter shows ≈ 66–83 MB/h) |
| Low    | 800  | 1 545 894    | `480p` (MediaMTX's measured BANDWIDTH ≈ 1.35–1.5 Mbit/s fits) | the source only if its advertised BANDWIDTH ≤ dm, else audio-only         |
| Medium | 1900 | 3 671 498    | `720p`                                                        | likewise                                                                  |
| Off    | —    | none         | everything                                                    | everything                                                                |

- **Budgets under ~86 MB/h** (open question in ADR 0018 / feature-wins §4.6): met by the `audio`
  rung whenever the ladder runs. On source-only channels audio-only is the floor and is kept
  (ADR 0018 decision 1); the player shows its estimate ("this stream's audio uses about N MB an
  hour", from the audio-only variant's advertised BANDWIDTH × 0.45 × 1.15) beside the budget.
- **Ladder rule: none in W1** (decided 2026-10-30). Possible follow-up, not scheduled: start an audio-only
  rung on a source-only channel while at least one data-mode session watches it (one AAC encode,
  negligible CPU), so every channel's floor is ≈ 50 MB/h. That is a `services/media/src/transcode/**`
  change and needs a Valkey count of data-mode sessions per channel; not scheduled.

## 9. Harness scaffolding (orchestrator-owned except the step modules)

Keep every W1 step module under `harness/src/w1/` so CI's import-graph selection
(`scripts/ci-changes.ts`) runs only the scenarios they affect.

- `harness/src/w1/selectors.ts` + `harness/tests/w1/selectors.test.ts` against
  `docs/testing/w1-selectors.md` (shape of `harness/src/e8/selectors.ts`).
- `harness/src/w1/steps.ts` (pure): `TIMELINE_STEPS = { 1: "live media time", 2: "browser viewers at forced latencies", 3: "replay exclusions", 4: "retention" }`,
  `SURGE_STEPS = { 1: "bots refused", 2: "CDN-assigned bot refused", 3: "per-address cap", 4: "real viewers chat after 60 s", 5: "audio-only screen-reader viewer", 6: "surge trips and reverts", 7: "studio and mod banner" }`,
  `W1_EXTENSIONS = { "e4b-money": ["breakdown", "reconciliation", "fraud-hold"], "e2e-social": ["flood", "block"], "integrity-basic": ["data-mode"] }`,
  `PENDING_TIMELINE_STEPS = [1, 2, 3, 4]`, `PENDING_SURGE_STEPS = [1, 2, 3, 4, 5, 6, 7]`,
  `PENDING_W1_EXTENSIONS` = all six extension steps, `parseSteps`, prerequisites (none). **Only the
  orchestrator removes a step from a pending list, when it merges the unit that implements it.**
  Tests in `harness/tests/w1/steps.test.ts`.
- `harness/src/w1/kit.ts`: `W1Run` (`ctx`, admin `api`, `streamer` live on the test pattern with the
  ladder forced as `clock-skew` forces it, signed-in viewers, `db`, `via`, `hooks.ops(job)` posting
  `INTERNAL_ROUTES.opsTick` (404 → an error naming `harness/compose.e6.yaml`)), and the context
  types the three extended scenarios hand their extension steps: `MoneyExtension` (the e4b-money
  actors, the confirmed payment ids, refund and chargeback ids, `provider`, `via`),
  `SocialExtension` (streamer, fan, troll, chat clients, `via`), `IntegrityExtension` (the live
  channel, the browser launcher, the viewer helpers). Read each scenario to fill them from what is
  already in scope.
- Step stubs, each throwing `new Error("<unit> not merged")`: `harness/src/w1/timeline.ts` (steps
  1, 3, 4; W1-spine), `timeline-web.ts` (step 2; W1-player), `surge.ts` (all seven; W1-watch-gate),
  `breakdown.ts` (`stepBreakdown`, `stepReconciliation`; W1-breakdown), `fraud.ts`
  (`stepFraudHold`; W1-fraud-floor), `calm.ts` (`stepFlood`, `stepBlock`; W1-calm-chat),
  `data-mode.ts` (`stepThrottledViewer`; W1-data-mode).
- Scenarios: new `harness/scenarios/timeline-sync.ts` and `harness/scenarios/surge-guard.ts`
  (`inFull: false`, `needs` as `interact.ts` (it already lists `chat`), dispatched from `steps.ts`, `--set
  steps=`, `--set via=`). Existing `e4b-money.ts`, `e2e-social.ts`, `integrity-basic.ts`: one block
  at the end of each run, `for (const s of w1Extensions("<name>", args)) await ctx.step(...)`, with
  `--set w1=` to name pending ones; each extension runs only when not pending. At the end of the
  milestone the orchestrator sets `inFull` true for both new scenarios, adds them to
  `FULL_REQUIRED` (`harness/src/registry.ts:33-…`, a `// W1:` group) and a shard `features: ["timeline-sync", "surge-guard"]`
  (named for the feature waves, not W1: N1's `notifications` joins it, §15)
  in `harness/src/shards.ts:11-17` and the CI matrix (`.github/workflows/ci.yml`; `git grep -n
  FULL_SHARDS scripts harness/tests` for tests pinning the list).

## 10. `docs/testing/w1-selectors.md` (write it; the units build against it)

Header and intro as `docs/testing/e8-selectors.md` ("W1 web ↔ harness contract (feature wins,
wave 1)"). Sections `## Rules`, `## Routes`, `## Player seam`, `## Test ids`, `## Scenarios`.

### Rules

- Tests select by `data-testid`, never visible text; numbers in `data-*` are plain integers
  (cents, bytes, seconds); option items follow `<field>-<value>`.

### Routes

| Route                                                  | What                                         | Unit           |
| ------------------------------------------------------ | -------------------------------------------- | -------------- |
| `/chat` (studio)                                       | verified-watch gate and surge-guard settings | W1-watch-gate  |
| `/settings/privacy`                                    | gains the blocked-users section              | W1-calm-chat   |
| `/transparency`                                        | gains the fee schedule                       | W1-breakdown   |
| `/revenue`, `/settings/subscriptions`                  | breakdown entry points                       | W1-breakdown   |
| `/treasury` (admin area, `routes/_admin/treasury.tsx`) | fraud flags section                          | W1-fraud-floor |

### Player seam (W1-player; W2 units build on it and never edit `controller.ts`)

`PlayerController` methods: `playheadWallclock(): Date | null` (PDT under the playhead,
`hls.playingDate` or Safari `getStartDate() + currentTime`), `seekToWallclock(t: Date): boolean`,
`setTargetLatency(seconds: number): number` (hls.js `liveSyncDuration`, returns the value applied;
native: changes nothing and returns the current latency), `onTextTrack(cb)`, `playbackMode(): "live" | "dvr"` and `onPlaybackMode(cb)`.
The `player` element carries `data-playback-mode`. Diagnostic query parameters on `/$channel`
(read by `player.tsx`, for `timeline-sync` step 2): `targetLatency=<seconds>` and `rendition=<name>`. `media-clock.ts` exposes
`playheadWallclock(channel)` / `playbackMode(channel)` for the chat panel. W1-data-mode (wave 2)
adds `setDataMode(ceilingBps | null)` and `dataUsage()` (it takes `controller.ts` over after
W1-player merges).

### Test ids

- **Breakdown:** `breakdown-open` (on a revenue row, a subscription row, the support dialog's
  estimate link; `data-payment-id`), `breakdown-dialog`, `breakdown-gross` (`data-cents`),
  `breakdown-line` (`data-kind`, `data-component`, `data-cents`, signed), `breakdown-hold`
  (`data-releases-at` or `data-released-at`), `breakdown-cut-source` (`data-history-id`, empty for
  the seed), `breakdown-timeline-item` (`data-kind`), `breakdown-estimate` (`data-low-cents`,
  `data-high-cents`), `fee-schedule`, `fee-schedule-row` (`data-key`, `data-changed-at`, empty for
  the seed).
- **Calm Chat:** `calm-toggle` (`data-state` `on|off`), `calm-digest` (the `aria-live` region),
  `chat-wave` (`data-count`, `data-senders`), `chat-wave-expand`, `chat-report-wave`,
  `chat-message-actions` (existing id, now for every signed-in viewer), `chat-user-block`,
  `blocked-users`, `blocked-user` (`data-username`), `blocked-user-remove`,
  `chat-replay-disclosure`. Messages from blocked users are not rendered; `chat-message` keeps its
  E1 attributes and gains `data-media-ts`.
- **Watch gate:** `chat-gate-settings`, `chat-gate-seconds`, `chat-gate-exempt-subs`,
  `surge-guard-enabled`, `surge-guard-ratio`, `surge-guard-cooldown`, `chat-gate-save`,
  `surge-banner` (`data-state` `on|suppressed`), `surge-end`, `surge-start`, `chat-gate-hint` (the
  chat input's note when the gate or surge mode applies).
- **Fraud floor:** `fraud-flags`, `fraud-flag` (`data-kind`, `data-status`, `data-payee`),
  `fraud-flag-review`, `fraud-flag-decide`, `fraud-flag-raise`, `fraud-decision-clear`,
  `fraud-decision-confirm`; `fraud-flag` also carries `data-released` (`true` once an admin
  released a confirmed flag; no release control in W1); payout rows keep their ids and show
  `data-hold-reason`.
- **Data mode:** `data-mode-toggle` (`data-state`), `data-mode-budget` with options
  `data-mode-budget-50|800|1900|custom`, `data-usage` (`data-bytes`, `data-mb-per-hour`),
  `data-mode-estimate` (`data-mb-per-hour`), `data-mode-notice` (`data-reason`
  `native-reload|dvr|vod`). The `player` element gains `data-data-mode` (the ceiling, empty when off).

### Scenarios

- **`timeline-sync` 1 (W1-spine):** a live channel; a signed-in API chat client sends with
  `mediaTs` = now − 5 s → the stored and live `mediaTs` equal it; now + 10 s → receive time;
  now − 120 s → receive − 60 s; before `started_at` → `started_at`; `playbackMode: "dvr"` → null;
  an IRC (tmi.js) message gets receive − the channel median once three verified viewers report
  latency (≥ 3 sessions), else receive time; offline channel → null and the message is accepted.
- **2 (W1-player):** two Chromium viewers on different rungs at forced latencies (hls.js
  `liveSyncDuration` 3 s and 9 s via `setTargetLatency`) each send a marker message; `vods.chat`
  after the VOD is ready returns them in media-time order, each within 1 s of the PDT the sender's
  page reported at send time.
- **3 (W1-spine):** replay excludes a deleted message, a held-and-never-approved one, messages before
  a `/clear`, a user banned mid-broadcast (their earlier lines), a blocked user (for the blocker
  only, seeded `user_blocks` row or `me.blocks.add` once calm-chat merged); a `private` VOD's
  replay is refused to a stranger; `clips.chat` returns the clip window.
- **4 (W1-spine):** with `CHAT_RETENTION_DAYS` rows backdated (direct SQL on test rows), the
  `chat-retention` ops tick deletes offline chat older than 30 days, keeps VOD-attached chat up to
  60 days, deletes past 60, skips an author under a legal hold.
- **`surge-guard` 1–7 (W1-watch-gate):** as ADR 0015 "Consequences" lists them: integrity-basic's
  fetch-less bots that chat are refused with `msg_verified_watch`; a bot assigned to the CDN path
  (forced through the harness CDN) is refused; six accounts behind one address leave exactly one
  refused; real viewers chat after 60 s + jitter + a scoring pass; an audio-only screen-reader
  (accessibility-tree) viewer verifies and chats; a scripted surge of new sessions trips the guard
  (`surge` frame `on`, `chat.surge.begin` outbox row and audit row), a moderator ends it
  (`suppressed`), and it reverts; step 7 drives `/chat` and the `surge-banner` in the browser.
- **`e4b-money` extensions:** `breakdown` (W1-breakdown): for the tip, a gift and a subscription,
  `money.paymentBreakdown` lines sum (gross side) to gross exactly, fee lines sit outside it, the
  refund's and chargeback's reversal lines sum to their amounts, the payer sees it and a stranger
  gets `NOT_FOUND`, the anonymous tip hides the payer from the creator; via=web the dialog shows
  the same numbers. `reconciliation` (W1-breakdown): the `money-reconcile` ops tick reports 0
  mismatches, including after the chargeback and (stripe provider) a won chargeback.
  `fraud-hold` (W1-fraud-floor): a fresh payee receiving tips from new accounts above the
  thresholds is flagged by the `money-fraud-scan` tick; the payout run holds them with
  `fraud_review`; a direct `held → pending` update fails; review + a second treasurer's clear
  releases it (the harness grants the second treasurer with `grantRole`; no admin web path in W1).
- **`e2e-social` extensions:** `flood` (W1-calm-chat): with Calm Chat on, 50 msg/s for 10 s from
  bots: at most N (= 3) distinct rows per second rendered, every mention of the fan rendered, the
  digest region updated at most every 5 s; axe-core (`@axe-core/playwright`, only if its contract
  request with `vet-package` output passes; otherwise the in-repo accessibility-tree check) reports no
  violations on the chat panel.
  `block` (W1-calm-chat): the fan blocks the troll from `chat-user-block`; the troll's next message
  is not rendered for the fan but is for the streamer; unblock from `/settings/privacy` restores it.
- **`integrity-basic` extension `data-mode` (W1-data-mode):** a Chromium viewer throttled to
  64 kbit/s and a WebKit viewer with the Audio preset play audio-only, keep `data-usage` below the
  estimate + 20 %, and their sessions are verified at the end of the scenario.

## 11. Shared-file rules for the milestone (every brief repeats its part)

| Shared thing                                                                                                                                                                                       | Resolution                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/**`, `packages/db/**` (schema, migrations, seed, legal), `packages/config/**`, `.env.example`, `packages/tokens/**`, `relay/internal/tokens/**`, `infra/**`                    | Orchestrator only (W1 step, then N1 step on top). Units file contract requests                                                                                                                                               |
| `packages/ledger/src/{meta,rules,reversals,settings,index}.ts`                                                                                                                                     | Orchestrator (§3.1). W1-breakdown owns only `breakdown.ts`; W1-fraud-floor only `payouts.ts`                                                                                                                                 |
| `packages/integrity/src/thresholds.ts`, `README.md`                                                                                                                                                | Orchestrator (§2.5). W1-fraud-floor owns `packages/integrity/src/payments/**`                                                                                                                                                |
| `services/api/src/routes/{me,vods,clips,chat,money,coop,safety,instance,playback}.ts`, `router.ts`, `http.ts`, `main.ts`, `env.ts`, `metrics.ts`, `ops/hooks.ts`, `playback/delivery.ts`, `lib/**` | Orchestrator. Exception: `routes/playback.ts` belongs to W1-data-mode from wave 2 (§4.4 lands first)                                                                                                                         |
| `services/chat/src/{core,server,types,directory,pipeline,metrics,main}.ts`, `services/irc/**`                                                                                                      | Orchestrator (§5). Units: W1-spine `clamp.ts`, `chat-latency.ts`; W1-watch-gate `rules.ts`, `watch-gate.ts`                                                                                                                  |
| `services/worker/src/jobs/index.ts`, `integrity/jobs.ts`, `env.ts`, `deletion/**`, `outbox.ts`                                                                                                     | Orchestrator (§6). Units own their job and writer files                                                                                                                                                                      |
| `services/worker/src/exports/collectors.ts`                                                                                                                                                        | Orchestrator (§4.7 `blocks.json`; the N1 step also edits it). No unit writes it                                                                                                                                              |
| Route tree, nav, `_studio.tsx`, `core.json`, `tests/nav.test.ts`, `chat/messages.ts`, `settings.privacy.tsx`, `report-dialog.tsx`                                                                  | Orchestrator (§8). Units fill their stubs and placeholder routes                                                                                                                                                             |
| `apps/web/src/chat/{chat-panel.tsx,state.ts,view.ts,mod-menu.tsx}`, tests `chat-state`, `chat-events`, `chat`, `e7-chat`                                                                           | W1-calm-chat (the `<SurgeBanner/>` mount, its props and the replay disclosure stay where this step put them). `connection.ts` and new `chat-connection*` tests: W1-player; `chat-gate*`/`surge-banner*` tests: W1-watch-gate |
| `apps/web/src/player/{controller.ts,player.tsx,heartbeat.ts}`, `apps/web/tests/heartbeat.test.ts`                                                                                                  | W1-player in wave 1, then handed to W1-data-mode (wave 2)                                                                                                                                                                    |
| i18n                                                                                                                                                                                               | §8.2                                                                                                                                                                                                                         |
| Harness scenarios, `src/w1/{steps,kit,selectors}.ts`, `registry.ts`, `shards.ts`, compose overrides, CI                                                                                            | Orchestrator. Units own their step modules (§9)                                                                                                                                                                              |
| `docs/testing/*`, `docs/README.md` (index rows for the new pages and the new `docs/viewers/` folder), PROGRESS.md, ADRs, READMEs                                                                   | Orchestrator; units propose text. Units own their `docs/streamers/*.md` / `docs/viewers/*.md` / `docs/operators/*.md` page                                                                                                   |
| `apps/web/tests/selectors.test.ts`                                                                                                                                                                 | Orchestrator adds the w1 check at the end of the milestone                                                                                                                                                                   |

## 12. Waves (batch 4: W1 + N1; at most six units at a time)

Contract steps: **W1 (this file), then N1** on top. Units branch from the N1 step's sha.

| Wave | Units                                                                              | Why                                                                                                                                                                                                                                                                            |
| ---- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | W1-breakdown, W1-calm-chat, W1-spine, W1-player, W1-watch-gate, W1-fraud-floor (6) | All six need only this step: disjoint by §4.1, §5, §6, §8.1. Calm-chat codes against the `presentation.ts` stub W1-player fills in the same wave. W1 goes first because data mode depends on the player seam and the watch gate and Spine are the largest units (longest tail) |
| 2    | W1-data-mode, N1-fanout, N1-email, N1-push, N1-inbox, N1-pwa (6)                   | Data mode consumes W1-player's seam and takes `controller.ts`/`player.tsx` over, so it waits for W1-player. N1's units touch notifications, email, push, PWA and a new `jobs/notify-go-live.ts`: disjoint from W1                                                              |
| 3    | N1-discord (alone)                                                                 | N1's own ordering (Discord last, per its plan)                                                                                                                                                                                                                                 |

Between waves the orchestrator merges each unit, applies its contract requests, lifts the harness
steps whose units have all merged, pushes `main` and waits for CI. `timeline-sync` step 2 needs
W1-spine and W1-player; `surge-guard` step 5 needs W1-watch-gate and W1-player (`?rendition=audio`);
`e2e-social` `block` needs W1-calm-chat; `timeline-sync` step 3's block
case uses a seeded row until W1-calm-chat merges.

## 13. Decisions (settled 2026-10-30)

The user answered items 2–5 on 2026-10-30; items 1 and 6–11 are orchestrator defaults the batch
README records as decided (the user may reopen them).

1. **User blocks in W1** (table, `me.blocks.*`, block action, live-chat hiding in W1-calm-chat),
   not W3. ADR 0012 decision 8, accepted 2026-10-27, already put them here; ADR 0017 carries a
   dated note (2026-10-30) that its "W3" line is superseded.
2. **CDN fetch-judging is owned by S1 stage 4** (user): the gate ships `CHAT_WATCH_GATE=off` and
   GA waits for it (`.claude/briefs/next/S1-scaling.md` stage 4 says so).
3. **Data mode** (user): `DATA_MODE` presets 50 / 800 / 1900 MB/h, overhead 1.15, **no ladder
   change in W1**; the "audio rung while a data-mode viewer watches a source-only channel" rule is
   not scheduled.
4. **Payment fraud floor: ADR 0036** (user; `docs/decisions/0036-payment-fraud-floor.md`, accepted
   2026-10-30): the kinds and `PAYMENT_FRAUD_RULES`, four-eyes deciding enforced by
   `payment_fraud_flags_guard`, the DB-enforced payout hold, audit and outbox in the same
   transaction, no personal data in flags. The split graph is W2-splits'.
5. **A `confirmed` flag keeps holding** (user): `payouts_fraud_guard` and W1-fraud-floor's batch
   hook treat open, reviewed, and confirmed-but-unreleased flags as holding; a cleared flag
   releases; the only way back from a confirm is `money.treasurer.fraudFlags.release`, an admin's
   audited account action (`released_by_id`/`released_at`, trigger-checked, once). Nobody reviews,
   decides or releases a flag on their own payouts.
6. **Breakdown receipt email deferred to M1** (`.claude/briefs/next/M1-money-follow-ups.md`).
7. **Chat replay UI deferred to W2** (`.claude/briefs/next/W2-feature-wave.md`): W1 ships
   `vods.chat` / `clips.chat` and the harness steps.
8. **Spine split** into W1-spine (server) and W1-player (client seam, presentation queue, sending
   `mediaTs`).
9. **No patronage estimate on the breakdown** in W1. **Support dialog fee estimate** 1.5–3.9 % +
   30 ¢ (`PROCESSOR_FEE_ESTIMATE`) accepted.
10. **Mid-surge joiners:** the `joined` frame carries `surge` (§1.4, §5) so the hint shows at once;
    W1-calm-chat keeps the wiring in `chat-panel.tsx`, W1-watch-gate fills `WatchGate.surge`.
11. **Fraud flags have no admin web path in W1:** the harness clears with a second treasurer
    (`grantRole`); `release` is API-only. **`@axe-core/playwright`** for the Calm Chat axe check only
    through a contract request with `bun scripts/vet-package.ts` output; if its license or vetting
    fails, the check uses the in-repo accessibility-tree approach. **CI shard:** the planned `w1`
    shard is named `features`; N1's `notifications` joins it unless that pushes it past ~12
    minutes, then its own `notify` shard (decided at the N1 milestone end).
12. Technical defaults (orchestrator): `playbackMode` as the one mode name;
    `coop.feeSchedule` instead of `transparency.feeSchedule`; the `surge` chat control frame (ADR 0015
    says the mod view shows a banner, not how it learns); chat ignores the gate while the flag is
    off and the API refuses to save it on; replay `retained: false` once a window aged out;
    `me.blocks.*` session-only (no OAuth scope); privacy text uses `{{chatRetentionDays}}`
    placeholders; the staging ledger reset for `PaymentMeta` v2.

## 14. Done means for the contract step

CI green on the pushed commit; locally, targeted: `bun --bun vp test run` (and `test:int` where
they exist, one package at a time) in `packages/contracts`, `packages/db`, `packages/config`,
`packages/tokens`, `packages/ledger`, `packages/integrity`, `packages/patronage`, `services/api`,
`services/chat`, `services/irc`, `services/worker`, `services/origin`, `apps/web`, `harness`; `go
test ./... && go vet ./...` in `relay/`; `bunx tsc -p` for each; `vp build` and `bun run i18n:check`
in `apps/web`; `bun scripts/config-reference.ts --check`; `bun scripts/selfhost/unit-env.ts --check`;
`reuse lint`. The 15 stubs of §4.1 answer `NOT_IMPLEMENTED`. Then record the units under "In
flight" in PROGRESS.md and hand each unit its brief and the N1 step's sha.

## 15. W1 milestone done means

- No `notImplemented` in the six §4.1 files.
- `timeline-sync` and `surge-guard` pass with no pending steps, are in `FULL_REQUIRED` with `inFull`
  true and in the `features` shard; the six extension steps run in `e4b-money`, `e2e-social` and
  `integrity-basic`; CI green on main.
- The w1 selectors check is in `apps/web/tests/selectors.test.ts`.
- `privacy.md` carries the chat replay and retention text (draft, counsel not reviewed).
- `CHAT_WATCH_GATE` stays `off` by default (GA: ADR 0015 decision 8, criterion 1 via S1 stage 4).
