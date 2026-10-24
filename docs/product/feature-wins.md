<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Feature wins: what CommonAir can ship that Twitch can't

Co-authored by the pod: Senior PM and Engineering Manager (facilitators), Staff Engineer/Architect, Senior Realtime & Media Engineer, Lead Product Designer/UX Researcher, Creator Success & DevRel Lead, Billing & Co-op Finance Lead, and Trust & Safety/Integrity Lead. Repo state checked at `8e5e14a` on 2026-10-21. This is the final plan, revised after the review round (see §8, "Review outcome").

## 1. Summary

**The bet.** Twitch wins on scale and network effects, so we should not try to beat it feature for feature. We should ship the things its business model keeps it from shipping. Every item here rests on something CommonAir already enforces or computes:

- a trigger-balanced, append-only ledger (`packages/ledger`, `packages/db/drizzle/0001_protections.sql`);
- integrity-verified sessions (`packages/integrity`, `playback_sessions.verdict`);
- one open pipeline from ingest to player (MediaMTX → `services/media` → `services/origin` → `apps/web/src/player`);
- Ed25519 primitives with test vectors (`packages/tokens`);
- co-op governance.

The pod cut 38 pitches to 14 features. They run in a Wave 0 of prerequisites and then three feature waves. No feature unit depends on any of the 100 handlers that still return `notImplemented`. The count is from `grep -c notImplemented services/api/src/routes/*.ts`: coop 25, interact 21, bot 15, developer 13, chat 6, safety 5, integrity 4, admin 3, me 3, vods 3, clips 2.

The review found that three foundations the draft took for granted do not yet exist:

- **One media clock.** Each rendition and the recorder stamp their own PDT.
- **Closed integrity review items.** The 2H2 items in `PROGRESS.md:235` are still open.
- **A multi-recipient ledger.** Hold release and reversals are single-creator throughout.

Wave 0 builds the first two. Ledger Splits moves to Wave 2 behind ADR 0013 and a payment-fraud floor.

**Headline wins:**

1. **Glass-box Payment Breakdown and a public fee schedule.** Every sub and tip shows the creator's share, the co-op's share, the card fee and the co-op's net, which can be negative. Each breakdown links to the dated governance setting that fixed the cut. Twitch's splits are tiered, threshold-based, and never shown per transaction.
2. **Verified-watch chat gate.** Chat can require proof that the sender is actually loading the video. This protects against hate raids. Twitch cannot expose this signal because its counting is closed.
3. **Timeline Spine, then Open Captions.** One aligned media clock carries chat, events, VOD and clip chat replay. Live auto-captions ship as a standard HLS subtitle track that is open, multilingual-ready and self-hostable. Twitch's May 2026 auto-captions cover community clips only.
4. **Ledger Splits.** Collab, crew and mod revenue shares post atomically, per recipient, in the ledger. Twitch pays one channel per transaction.
5. **Signed Audience Attestations.** Each broadcast gets a hash-chained, Ed25519-signed statement of its verified audience, which a sponsor can check offline.

## 2. Themes

| Theme                         | What it means here                                                                                       | Features                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Open books**                | The ledger and governance settings are already the truth, so we show them to the people who pay and earn | Payment Breakdown and fee schedule, Ledger Splits             |
| **Verified, not inflated**    | Integrity verdicts become products for creators, sponsors and mods                                       | Verified-watch gate, Audience Attestations, Creator Analytics |
| **Live sync**                 | One aligned media clock across chat, events, player and VOD                                              | Timeline Spine, Free Live DVR, Watch Rooms                    |
| **Access by default**         | Accessibility and low bandwidth are public goods, with their cost published                              | Open Captions, Calm Chat, Any-Connection Mode                 |
| **Accountable safety**        | Enforcement you can read, cite and audit                                                                 | Open Enforcement (plus the Wave 0 statement-of-reasons track) |
| **Creator tools and freedom** | Lower the risk of trying CommonAir, and of leaving it                                                    | Rehearsal Mode, Portability                                   |

## 3. Ranked shortlist

Scores start from the pod tally (mean across 7 roles). Score = value + feasibility − risk. Each review-driven change is listed under Adjustments. Wave order follows dependencies, not rank.

| #   | Feature                                                         | Theme           | Value | Feas. | Risk | Score | Size | Wave                               |
| --- | --------------------------------------------------------------- | --------------- | ----- | ----- | ---- | ----- | ---- | ---------------------------------- |
| 1   | Glass-box Payment Breakdown and fee schedule (pm-2 + fin-1)     | Open books      | 4.29  | 4.8   | 1.57 | 7.52  | S–M  | 1                                  |
| 2   | Calm Chat (ux-5)                                                | Access          | 4.14  | 5.0   | 1.71 | 7.43  | S    | 1                                  |
| 3   | Timeline Spine (arch-6 + rt-1 clock)                            | Live sync       | 4.57  | 3.3   | 2.0  | 5.87  | L    | 1 (after W0-clock)                 |
| 4   | Verified-watch gate and surge guard (tns-2)                     | Verified        | 4.71  | 3.6   | 3.0  | 5.31  | M    | 1 (flagged; GA after W0-integrity) |
| 5   | Open Captions (ux-1)                                            | Access          | 5.0   | 2.8   | 2.86 | 4.94  | L    | 2                                  |
| 6   | Creator Analytics (dx-1 + arch-2)                               | Verified        | 4.0   | 3.57  | 2.8  | 4.77  | M    | 2 (group appeals 2b)               |
| 7   | Open Enforcement: clause catalog and live report (tns-3 + pm-5) | Safety          | 3.7   | 3.5   | 2.5  | 4.70  | M    | 2 (jury 3)                         |
| 8   | Any-Connection Mode (ux-3, trimmed)                             | Access          | 3.57  | 3.6   | 2.5  | 4.67  | S–M  | 1b                                 |
| 9   | Signed Audience Attestations (tns-1 + arch-3 + pm-3)            | Verified        | 4.1   | 3.2   | 2.86 | 4.44  | M    | 2b                                 |
| 10  | Rehearsal Mode (dx-5)                                           | Creator tools   | 3.71  | 3.3   | 2.86 | 4.15  | M    | 2                                  |
| 11  | Portability phases 1–2 (dx-4 + pm-6 + arch-5)                   | Creator freedom | 4.1   | 3.0   | 3.2  | 3.90  | L    | 3                                  |
| 12  | Watch Rooms (ux-2 + rt-3)                                       | Live sync       | 3.83  | 3.3   | 3.3  | 3.83  | M    | 3                                  |
| 13  | Ledger Splits (arch-1 + dx-2 + pm-4 + pm-1 pool)                | Open books      | 4.24  | 2.8   | 3.4  | 3.64  | L    | 2 (after ADR 0013 + fraud floor)   |
| 14  | Free Live DVR (rt-2, reframed)                                  | Live sync       | 3.6   | 3.0   | 3.3  | 3.30  | M    | 2                                  |

Unscored, because they are owed rather than wins: the **DSA Art. 17 statement-of-reasons compliance track** (Wave 0/1), the **payment-fraud floor** (Wave 1), the **integrity 2H2 closure** (Wave 0) and **media-clock alignment** (Wave 0).

**Adjustments.**

- **Payment Breakdown:** feasibility 5.0 → 4.8. It now parses v1 and v2 payment metadata, adds the fee-schedule changelog and chargeback timeline, and adds owner paths the draft left out.
- **Timeline Spine:** feasibility 4.0 → 3.3, size M → L. It now depends on W0-clock. The draft assumed a single PDT clock. In fact the ladder rungs are separate ffmpeg processes publishing back to their own MediaMTX paths (`services/media/src/ffmpeg/args.ts:99-125`). MediaMTX stamps LL-HLS PDT per path (`infra/mediamtx/mediamtx.yml:63`, with no `useAbsoluteTimestamp`). The VOD recorder's PDT at `args.ts:169` comes from a third, `-c copy`, process.
- **Verified-watch gate:** feasibility 4.0 → 3.6. CDN-delivered sessions are not fetch-judged (`packages/integrity/src/signals/fetch.ts:107`), and the 2H2 items gate GA.
- **Open Captions:** feasibility 3.0 → 2.8. The chat filter pool has to be extracted into a package first, and the unit needs a sidecar image, infra work and a captions-on latency profile.
- **Creator Analytics:** risk 3.0 → 2.8. v1 is read-only exclusion categories, and group appeals move to 2b after appeal stickiness is fixed.
- **Open Enforcement:** score unchanged. Statements of reasons move out to the compliance track, so this item covers the clause catalog, `rule_ref` and the public report.
- **Any-Connection Mode:** feasibility 3.86 → 3.6. The token claim touches contracts, the Go relay mirror and vectors, all orchestrator-owned.
- **Audience Attestations:** feasibility 3.4 → 3.2. The `packages/tokens` work moves to the orchestrator, and per-channel chain serialization is added.
- **Rehearsal Mode:** feasibility 3.57 → 3.3. There is no `broadcasts.visibility` column. It needs a new `broadcasts.kind` and pre-publish arming.
- **Watch Rooms:** feasibility 3.83 → 3.3, risk 3.0 → 3.3, moved to Wave 3. It needs the aligned clock and player seam, a DB-backed retention design (ADR 0017), and the stricter age-mixing rules.
- **Ledger Splits:** feasibility 3.33 → 2.8, risk 3.0 → 3.4, size L, moved to Wave 2. Hold release, reversals, chargebacks and locks are single-recipient end to end (see 4.10). It is also a mule cash-out path until the fraud floor exists.
- **Free Live DVR:** feasibility 3.43 → 3.0, risk 3.0 → 3.3. The DVR path is source-only with no ABR, segments are publicly reachable under `/media/vods`, and the relay has no purge path. v1 is origin-only.

## 4. Feature specs

Every spec assumes the AGENTS.md rules:

- Contract, DB, `packages/tokens` and KEYS changes go through the orchestrator's contract step.
- Events are written through the outbox in the same transaction.
- `audit_log` covers moderator, admin, integrity and governance actions.
- No personal data goes into append-only columns.
- All strings go through i18n, and only house primitives are used.
- Migration numbers are assigned by the orchestrator at each contract step, not in specs, because E5 and E6 are mid-flight.

### 4.1 Glass-box Payment Breakdown and public fee schedule

**Problem and Twitch gap.** Twitch revenue shares are tiered and threshold-based. Partner Plus reaches 70/30, and thresholds have changed repeatedly since 2023. They are never shown per transaction: viewers can't see how much of a payment reaches the creator, and creators see aggregated net. YouTube and Kick give no per-transaction breakdown either. Kick advertises 95/5 but publishes no ledger.

**User stories.**

- Viewer: after a $10 tip I see the creator's cents, the co-op's share, the card fee, the co-op's net, and the dated setting that fixed the cut.
- Creator: I open a revenue row and see its lines, when its hold releases, and a chargeback or refund timeline: dispute opened, clawback source, dispute fee borne by the co-op.
- Member or prospective viewer: /transparency shows a fee-schedule changelog of every change to `platform.cut` and `payout.rules`, with dates.
- Prospective payer: the support dialog shows an _estimated_ split before payment.

**Design.**

- A read-only projection of the `paymentSucceeded` posting (`packages/ledger/src/rules.ts:132`) and its reversals.
- The DTO is renamed to avoid a clash with relay bandwidth "receipts" (`relay.receipt`, `RECEIPT_STATUSES`): `PaymentBreakdown { paymentId, grossCents, currency, lines[{kind: tax|creator|coop_share|processor_fee|coop_net|reversal|dispute_fee, cents, recipientUserId?}], holdReleasesAt, cutSource, timeline[] }`.
- **Fee framing, corrected against the code.** Shares are computed on gross minus tax. The processor fee is a co-op expense, posted as a `paymentFees` debit against settlement. The breakdown shows **co-op share**, **processor fee** and **co-op net** as separate lines. Co-op net can be negative: at the seeded 10% cut (`DEFAULT_PLATFORM_CUT`, `rules.ts:22`), a $1 tip gives the co-op 10¢ against a fee of about 33¢. Showing that is the point. The draft's "of which" copy is dropped.
- **Invariants.**
  - Gross-side lines (tax + creator(s) + co-op share) sum exactly to gross, through any partial or full refund.
  - The processor fee, the non-reversed fee on refunds, and the chargeback dispute fee are separate co-op-expense lines _outside_ the gross sum. The dispute fee is its own `paymentFees` debit from settlement.
  - A nightly reconciliation invariant checks, per payment: gross-side lines + fee lines = the settlement-account movement across that payment's postings.
- **Metadata v1/v2.** The builder accepts today's scalar metadata (`creatorUserId`/`creatorCents`) and the v2 share vector frozen in the Wave 1 contract step (ADR 0013). `lines[]` allows N creator lines, so Ledger Splits needs no breakdown change.
- **`cutSource`.**
  - Resolved by (`platform.cut`, `changed_at <= occurredAt`) against `governance_settings_history`.
  - Shows "founding default (seed)" when no history row exists. The seed writes none, because history is written only by the settings trigger.
  - From Wave 1 on, `paymentSucceeded` records `cutHistoryId` in posting metadata. This is a small `rules.ts` change owned by this unit in Wave 1; Splits takes `rules.ts` over in Wave 2.
- **Fee-schedule changelog** (promoted from parked): a read of `governance_settings_history` filtered to the money keys, rendered on /transparency. It is the page `cutSource` links to.
- **Estimate:** support-dialog preview with a "typical fee" range. Card-country fees and Stripe Tax are unknown before payment, so it is labelled "estimate".
- **Cut from v1:**
  - the public channel split card. Before splits it only repeats the instance cut, and after splits it lets observers work out crew income. It is revisited after Splits plus a privacy review;
  - the patronage-returned estimate (patronage runs are stubs);
  - the EventSub `payment.receipt` event (EventSub delivery is a stub).

**Architecture fit.**

- New `packages/ledger/src/breakdown.ts`: a pure builder over transactions by `refType='payment'`/`refId`, using `holdReleaseDueAt` (`rules.ts:173`). `holdDays` comes from a shared config readable by both api and worker (today it is in `services/worker/src/money/config.ts`; the contract step moves the constant to `packages/config`).
- API: `services/api/src/money/breakdown.ts`, built on `reports-lib.ts`. Fee schedule: `services/api/src/money/fee-schedule.ts`. Router registration in `services/api/src/routes/money.ts` is done by the orchestrator.
- Contract: `money.paymentBreakdown({paymentId})` and `money.paymentBreakdowns` (paged), visible to the payer or the payee creator only; `transparency.feeSchedule`.
- Web:
  - breakdown drawer `apps/web/src/components/money/breakdown-*.tsx`;
  - entry points in `apps/web/src/routes/_app/settings.subscriptions.tsx`, `apps/web/src/routes/_studio/revenue.tsx`, `apps/web/src/components/money/revenue.tsx`, and `apps/web/src/components/support/support-dialog.tsx` (estimate);
  - fee schedule as `apps/web/src/components/money/fee-schedule.tsx`, imported by the transparency page.
- Email: a fixed breakdown template added to `packages/email/src/templates/payments.tsx`, with no creator-controlled text.
- No migration.

**Integrity and T&S.**

- UUIDv7 ids are time-ordered, so non-enumerability rests on authorization, not on the id.
- The creator-side view masks the payer when `payments.anonymous = true` (`packages/db/src/schema/money.ts:85`), including the creator's copy of gift breakdowns.
- Recipients are referenced by id (ADR 0004).

**Money.** Read-only, apart from the `cutHistoryId` metadata field.

**Accessibility.** Dialog with a semantic table. `<MoneyAmount>` for all amounts. Negative co-op net is announced in words, not by colour alone.

**Tests.**

- Property test: gross-side lines sum to gross across random partial-reversal sequences, for v1 and v2 metadata.
- Unit: fee lines stay outside gross, including the dispute fee; `cutSource` falls back to the seed.
- Integration: manual and stripe-mock payments.
- Harness: `e4b-money` asserts breakdown sums and the reconciliation invariant, including chargeback and won-chargeback cases.

**Size.** S–M.

**Open questions.** How to present tax lines under the Stripe Tax adapter versus manual tax.

### 4.2 Calm Chat

**Problem and Twitch gap.** Large chats are unreadable, and close to unusable with a screen reader. Slow mode and emote-only mode are creator-side restrictions that apply to everyone. Twitch has no per-viewer reading mode.

**User stories.**

- A VoiceOver user hears a digest every few seconds instead of 40 messages per second.
- An overwhelmed viewer sees waves of identical messages collapsed to "312 · PogChamp".

**Design.** v1 is client-only.

- A wave reducer groups messages by NFKC-normalized body, with zero-width characters stripped, in a 5 s window.
- A rate governor shows at most N distinct messages per second (default 3).
- Priority order: mentions of me, broadcaster, mods, replies to me, first-time chatters. Subscriber priority is off by default.
- One `aria-live="polite"` digest every ~5 s.
- j/k navigation, a jump-to-mentions shortcut, and `prefers-reduced-motion` respected.
- Settings are kept in localStorage, inside try/catch.
- "Report wave" sends one grouped report. The report subject `message_set` is added in the Wave 1 contract step (a small contract change, stated honestly).
- The server-side `wave` frame is deferred.

**Architecture fit.** New `apps/web/src/chat/calm/{reducer,governor,digest}.ts`. The unit owns `chat-panel.tsx`, `view.ts` and `state.ts`. It wires in the Spine's presentation queue (exported from the new `apps/web/src/chat/presentation.ts`), so that only one unit edits `state.ts`.

**Integrity and T&S.**

- Held messages and mentions of the viewer are never collapsed.
- Harassment waves render as an expandable group showing the sender count.
- Hashing must not merge messages that differ by a slur token.
- Mods always see raw chat.

**Money.** None.

**Accessibility.** This is the feature. axe-core runs in Playwright.

**Tests.**

- Exhaustive reducer and governor unit tests: empty windows, Unicode normalization, priority, window boundaries.
- Storybook wave rows in dark and light at 320 px.
- `e2e-social` flood step at 50 msg/s: at most N rows per second rendered, zero mentions dropped.

**Size.** S.

**Open questions.** Whether the digest interval should be user-tunable.

### 4.3 Timeline Spine

**Problem and Twitch gap.** Twitch replays VOD chat by server receive time, which drifts from the video by each viewer's latency. Clips carry no chat. Alerts fire when the server sends them, so a viewer 8 s behind sees the poll before the moment that prompted it.

**User stories.**

- VOD and clip chat line up with the moment they refer to.
- An alert overlay fires when _my_ playhead reaches the moment.
- Clips include the chat from that second.

**Design.**

1. **Clock alignment (W0-clock, prerequisite).** Choose one media clock in ADR 0012, after the spike. Either the rungs and recorder carry source NTP (RTCP SR plus MediaMTX `useAbsoluteTimestamp`), or `services/media` measures each rung's and the recorder's offset against the source and origin corrects PDT. Targets: cross-rendition skew < 100 ms, live-to-VOD skew < 250 ms. Clips are cut by recorder wall-clock windows (`vod/recorder.ts:132`), so clip replay keys on the aligned recorder clock.
2. **PDT passthrough is already tested.** `services/origin/tests/playlist.test.ts` ("non-URI lines are untouched", fixture with PDT at `fixtures.ts:32`) and `relay/internal/hls/rewrite_test.go:48-63` cover it. No new work.
3. **Player seam (done criterion).** `apps/web/src/player/controller.ts` exposes:
   - `playheadWallclock()`, built on the existing `hls.playingDate` (line 164) and Safari `getStartDate()` (lines 167–170);
   - `seekToWallclock(t)`, `setTargetLatency(s)`, a text-track hook, and a `mode` reporter (`live|dvr`).

   Wave 2 units build on these seams and do not edit `controller.ts`.

4. **Chat.**
   - Optional `mediaTs` plus `playbackMode` on the client send frame and server message frame (`packages/contracts/src/chat.ts`), added in the Wave 1 contract step so DVR doesn't force a second change.
   - Live mode: clamped to [max(receive − 60 s, broadcast.startedAt), receive], and rejected for non-live channels.
   - DVR mode: `media_ts` is null, and replay shows the message as "said while catching up".
   - Missing `mediaTs` (IRC, bots): receive time minus the channel's median heartbeat latency, read from a new `KEYS.chatLatency(channelId)`. The integrity worker writes it from the `latencySeconds` heartbeats already sent.
5. **Presentation queue** (new `apps/web/src/chat/presentation.ts`):
   - on for overlays and alerts, off by default for chat lines;
   - own messages echo instantly;
   - the creator dashboard shows real time.
6. **Replay** procedures `vods.chat` and `clips.chat`, ordered by `media_ts`. Replay excludes:
   - held, deleted and moderated messages;
   - messages from deleted or banned users;
   - messages from users the viewer has blocked;
   - anything on a VOD or clip that is removed or restricted.

   It is governed by a chat retention period (none exists today) and a user-facing disclosure that live chat is replayed.

**Architecture fit.**

- Migration: nullable `chat_messages.media_ts timestamptz` plus a `(channel_id, media_ts)` index (`packages/db/src/schema/chat.ts`).
- The orchestrator's contract step lands the `mediaTs` passthrough in `services/chat/src/pipeline.ts`/`core.ts`/`types.ts`. The unit owns a new `services/chat/src/clamp.ts` and `persistence.ts`.
- Replay handlers live in a new `services/api/src/chat-replay/`, wired into the router by the orchestrator. They do not go in `routes/vods.ts`/`clips.ts`, which E6 owns.
- `services/irc` ignores the field.

**Integrity and T&S.** Receive time stays authoritative for report evidence, and `media_ts` is only a hint. The clamp limits backdating to 60 s.

**Money.** None.

**Accessibility.** Synced replay helps people who read captions and chat together.

**Tests.**

- Clamp unit tests: window edges, before `startedAt`, offline channel, DVR null.
- Replay exclusion integration tests.
- Harness `timeline-sync` (new): two Chromium viewers at forced latencies on different rungs. Replay order matches media time within 1 s.

**Size.** L, including the seam. W0-clock is separate.

**Open questions.** Whether chat hold-back should become a viewer opt-in (usability test). The retention period (ADR 0012).

### 4.4 Verified-watch chat gate and surge guard

**Problem and Twitch gap.** Twitch offers follower age, account age, phone and email verification, Shield Mode, AutoMod, Suspicious User Detection and Shared Ban Info. None of them asks whether the chatter is actually loading the video. Hate-raid bots chat without watching.

**User stories.**

- A hate-raided streamer turns on "chat requires 60 s+ of verified watching", and scripted accounts can't post.
- A botted surge trips watchers-only mode for 10 minutes, with a mod banner explaining why.
- A friend's real raid passes because its sessions verify.

**Design.**

- The integrity worker (`services/worker/src/integrity/jobs.ts`) writes `KEYS.verifiedWatch(channelId, userId)` with verified seconds this broadcast.
  - It writes only for sessions with verdict `verified` **whose fetch check actually ran**.
  - Sessions skipped as `cdn` or `no_accounting` (`signals/fetch.ts:77`) count as unverified for gating.
  - The TTL outlasts the scoring interval, so chatters don't flap between allowed and denied.
- Signed-in viewers only, because anonymous sessions have no `userId`. The UI says so.
- 60 s minimum, because verification takes about 3 heartbeats.
- Exemptions: mods, VIPs, and optionally subscribers.
- An account-age fallback for privacy-relay users is on whenever the gate is on.
- **Oracle hardening.**
  - One generic denial for both "not yet" and "never", returned as an i18n code.
  - Jittered unlock time and per-user attempt limits.
  - Unlocks capped per network hash per channel, reusing integrity network grouping.
- **Surge guard v1.**
  - Triggers on new-session spikes and `follow_burst` flags (`packages/integrity/src/channel.ts`).
  - The override is **TTL'd Valkey state** that chat reads. It is not a settings-row write, which would create settings history and need API-side publishing, still open in PROGRESS.
  - Hysteresis and cooldown.
  - Writes `audit_log` and an outbox `chat.surge.begin/end` event.
  - Mods get an audited one-click override. Chatters in good standing are unaffected.
- **Rollout.** Off by default, behind an instance flag, until W0-integrity closes the 2H2 items (fetch-less bots, false positives, appeal stickiness). GA follows.

**Architecture fit.**

- `services/chat/src/rules.ts` stays pure. The contract step adds `verifiedWatchSeconds` to `GateInput`/`Standing` (`types.ts`), loaded in `pipeline.ts`.
- The unit owns `rules.ts` (gate logic, code-based rejections) and `cache.ts` (cached Valkey read).
- `ChannelChatSettings` (`packages/contracts/src/shapes.ts:35-37`) gains `minVerifiedWatchSeconds` and `surgeGuard {enabled, triggerUnverifiedRatio, cooldownMinutes}`.
- New `KEYS.verifiedWatch` and `KEYS.surgeOverride` (`packages/contracts/src/internal.ts`).
- Worker job `services/worker/src/jobs/chat-surge-guard.ts`, registered in `names.ts` by the contract step.
- Studio settings component `apps/web/src/components/studio/chat-gate-settings.tsx` and a mod-view banner.

**Integrity and T&S.**

- Audio-only and DVR sessions keep accruing verified seconds.
- Residential proxies with real browsers raise the attacker's cost but are not stopped, so the gate stays one layer among several.

**Money.** None.

**Accessibility.** The denial message is kind and localized. A screen-reader user on audio-only must be able to verify and then chat (harness assertion).

**Tests.**

- Hysteresis unit tests.
- Integration test of the cached read against real Valkey.
- Harness `surge-guard` (new), reusing the `integrity-basic` bots:
  - bots that try to chat are rejected;
  - a CDN-assigned bot is rejected;
  - N accounts behind one IP are capped;
  - real viewers chat after 60 s;
  - a scripted surge trips the guard and it reverts.

**Phase 2 (Wave 3), fair giveaways (tns-5).**

- Commit-reveal seed, and an HMAC-SHA256 draw with rejection sampling.
- Salted pseudonyms.
- No paid or loyalty-point entry.
- Size M.

**Size.** M.

**Open questions.** Whether onboarding should recommend the surge guard once false-positive data exists.

### 4.5 Open Captions

**Problem and Twitch gap.** Twitch has no native live auto-captions. Its May 2026 TwitchCon Rotterdam announcement covered auto-captions for community clips and an Auto Clips beta. Live captioning goes through OBS or XSplit tooling. YouTube Live has had English auto-captions on normal-latency streams for years, so the claim is not "unique". It is **open, self-hostable, multilingual-ready, at any latency, with cost published**. This is PLAN Phase-two work pulled forward.

**User stories.**

- A Deaf viewer turns on CC on any opted-in stream.
- An editor corrects captions after the stream, and the VOD keeps them.

**Design.**

- A caption worker in `services/media` pulls the live path over the existing RTSP pull, extracts 16 kHz mono, and runs a whisper.cpp sidecar on 2–5 s chunks.
- Its WebVTT is aligned to the **W0-clock media clock**.
- The origin multivariant rewrite (`services/origin/src/playlist.ts`, next to the audio-only variant at line 226) adds `EXT-X-MEDIA TYPE=SUBTITLES`.
- **Captions-on latency profile.** Today's LL-HLS gives about 3 s glass-to-glass (1 s segments, `liveSyncDurationCount` 3). When CC is on, the player raises its target through the seam's `setTargetLatency()` to about 8–10 s, so cues arrive before their PDT reaches the playhead.
- Cues are stitched into the existing VOD `captions[]` (`packages/contracts/src/api/entities.ts`).
- Captions are opt-in per instance and per creator, under an operator concurrency cap with a queue. The UI says when capacity is the reason captions are off.
- **Word filter.** Masking, not removal, configurable by the creator, through the safe-regex pool. A shared-lib step first extracts that pool from `services/chat/src/filter-runner.ts`/`filter-worker.ts` into a package, because a service can't import another service's internals.
- v1 includes a creator correction editor.
- Deferred: transcript panel and translation.

**Architecture fit.**

- Contract: channel `captions {enabled, spokenLanguage, maskWords}` and `vods.captions.update`.
- Migration: `broadcast_caption_tracks` and `caption_edits` (edits reference users by id).
- The model is fetched by `scripts/fetch-model.ts` with a pinned digest.
- The sidecar is a new image: compose wiring plus an `infra/image-licenses.json` entry, owned by this unit's infra sub-scope.
- Subtitle playlists and VTT segments are served through the origin route seam.
- Compute is posted as a categorized `infra_costs` line, so it shows in `TransparencyMonth.costs`.

**Integrity and T&S.**

- Transcripts are personal data: they get a retention period and are covered by `services/worker/src/deletion`.
- They do not feed T0/T1 or other automated moderation without a separate ADR and disclosure.
- Machine translation will be labelled.

**Money.** Compute is a published co-op cost. The worker cap becomes a governance setting after E5.

**Accessibility.** The core purpose. Theme-token styling, with user-set size and contrast.

**Tests.**

- WebVTT segmenter unit tests.
- Origin rendition test.
- Relay test that the `EXT-X-MEDIA` SUBTITLES URI is rewritten.
- hls.js check that LL-HLS loads a SUBTITLES rendition.
- Harness `captions` (new) with a CC0 synthetic-TTS fixture:
  - word error rate below threshold;
  - each cue arrives before its PDT reaches the playhead;
  - VOD captions present after the stream ends.

**Size.** L.

**Open questions.**

- **Step 0 gate:** ADR 0011 on whisper.cpp (MIT) and the _specific_ weights at the pinned digest.
- Policy on CC-BY weights (Opus-MT) before translation.
- CPU tier for small boxes.

### 4.6 Any-Connection Mode (trimmed)

**Problem and Twitch gap.** Twitch has manual quality selection and audio-only on mobile, but no data-budget control and no live usage meter.

**User stories.** On a 1 GB/month plan, I set 50 MB/hour. The player chooses audio-only, plus captions once they exist, shows the MB used, and returns to video on Wi-Fi.

**Design.**

- A client budget controller (`apps/web/src/player/budget.ts`) uses `stats.ts` byte rates to set hls.js `autoLevelCapping`.
- Below the lowest rung it drops to the existing audio-only variant (`AUDIO_ONLY_BANDWIDTH`).
- A usage meter in the stats popover. `saveData`/`effectiveType` set the default where available.
- DVR (source-only, see 4.14) is excluded from data mode, and the UI says so.
- **Cut:** LAN /24 peer grouping and the stills rendition.

**Architecture fit.**

- `dataMode` is a **playback token claim**, added by the orchestrator in:
  - `packages/contracts/src/tokens.ts`;
  - the Go mirror `relay/internal/tokens/playback.go`;
  - `packages/tokens` vectors.
- Minting is in `services/api/src/playback`, and origin enforcement in `services/origin/src/auth.ts`.
- The draft named `services/origin/src/issuance.ts`, which is relay-issuance accounting; that was wrong.
- Integrity gets per-mode expected byte-rate bounds in `packages/integrity/src/allowance.ts`.

**Integrity and T&S.** Audio-only is the cheapest viewbot, so per-segment fetch evidence is still required. The mode changes expected rates, not evidence requirements.

**Money.** None directly.

**Accessibility.** Access on metered connections.

**Tests.**

- Budget controller unit tests.
- Integrity bound tests.
- Token vector tests (TS and Go).
- Harness: a 64 kbps Chromium and WebKit viewer stays verified on audio-only.

**Size.** S–M.

**Sequencing.** Wave 1b, on the Spine's player seam.

### 4.7 Open Enforcement: clause catalog and live report

**Problem and Twitch gap.** Twitch notices name a guideline category but do not say whether a human or a model decided, and do not show per-rule overturn rates. Its transparency report is aggregate and semiannual.

**Scope split.** DSA Art. 17 statements of reasons for platform T1/T2/NCII actions are a legal floor that ADR 0006 already owes, and production is under way (ADR 0010). They move to the unscored **W1-sor compliance track** (§5). This feature is what goes beyond the floor.

**User stories.**

- A streamer labelled T2 sees `rule_id@version`, whether the decision was automated or made by a human, the appeal path, and last month's overturn rate for T2 labels.
- A member reads per-rule counts on /transparency.

**Design.**

- A versioned clause catalog.
- `rule_ref` on platform actions only. Channel-moderator actions in `mod_actions` are labelled as channel rules and kept out of platform statistics and statements.
- A live per-rule report: counts by rule, tier, detection source, time-to-action against the SLA, overturn rate, and NCII 48-hour compliance. Cells under k are suppressed.
- Exact classifier scores appear only in the appeal view; notices show the governance range.
- Wave 3: an advisory member audit jury that samples closed T1/T2 and report cases (never T0), blurred by default. It is drawn with a seed committed to `audit_log`.

**Architecture fit.**

- Migration: `policy_rules` (or clauses in `legal_documents`, per ADR 0019), plus `rule_ref` on `moderation_cases`, `appeals`, and platform-origin `mod_actions` (`packages/db/src/schema/safety.ts`, `moderation.ts`).
- Contract: `transparency.enforcement`.
- Web: `apps/web/src/components/transparency/enforcement-report.tsx`. `transparency.tsx` only imports it, because E5 shares that route.
- The DSA Transparency Database adapter is off by default.

**Integrity and T&S.** k-suppression, no names. The jury electorate depends on E5 membership.

**Money.** None.

**Accessibility.** Plain-language notices, with clause text in i18n.

**Tests.**

- k-suppression unit tests.
- Channel-versus-platform separation tests.
- `trust-safety` harness: report counts move after T1/T2 actions.

**Size.** M. The jury is M in Wave 3.

**Open questions.** Clause catalog storage.

### 4.8 Signed Audience Attestations

**Problem and Twitch gap.** Sponsors rely on scrapers (StreamsCharts, SullyGnome, StreamHatchet) that can't tell bots from people. Twitch's 2025 viewbot crackdown cut reported numbers with no per-channel explanation, and Twitch offers no signed attestation a third party can check.

**User stories.** A creator sends a sponsor a 30-day proof link. The sponsor's verifier checks the signatures: 412 average verified viewers, 9% excluded.

**Design.**

- A worker job on `stream.offline` waits a **settle delay shared with Creator Analytics** (one constant ≥ integrity `finalizeSeconds` plus the re-score policy, set in ADR 0014). It reads **the same per-minute rollup** as Analytics.
- It signs a canonical per-broadcast statement containing:
  - schema version, instance origin, and channel and broadcast ids;
  - period, integrity package version, and a _hash_ of the threshold set;
  - peak and average verified concurrents, and verified viewer-hours;
  - excluded hours by reason code;
  - delivery mix (origin, relay, CDN);
  - `prev_hash`.
- The per-channel chain is serialized with an advisory lock, so supersede entries can't race the offline job.
- Ed25519 worker-only key, with `kid` and a published key history.
- Window proofs are signed rollups over attestation hashes.
- A re-score appends a "superseded" entry and never mutates.
- The reason breakdown is owner-only unless shared through an expiring link.
- The statement says "excluded traffic is not proof of wrongdoing".
- **Cut:** PDF, country data, embeddable badge.

**Architecture fit.**

- Migration: append-only `integrity_attestations` (the `0001_protections.sql` pattern).
- `INTEGRITY_SIGNING_KEY` in `packages/config`, `.env.example` and `scripts/init-env.ts`.
- `packages/tokens/src/attestation.ts` and TS/Go vectors are written by the **orchestrator** in the Wave 2b contract step, because AGENTS.md assigns `packages/tokens` to it.
- Contract: `integrity.attestations.list/get/share`, a public verifier route, `/.well-known/commonair-attestation`, and an SDK `verify()` helper.
- `services/api/src/routes/integrity.ts` is handed over from W2-rollup-analytics once that unit merges.

**Integrity and T&S.**

- **Hard gate:** W0-integrity closed (the 2H2 items, `PROGRESS.md:235`). The draft cited HANDOFF.md, which doesn't list them.
- A ruleset changelog and a red-team pass happen before public use.
- The verifier shows the instance domain prominently.

**Money.** None directly. Sponsor escrow is a later idea.

**Accessibility.** The verifier is plain, screen-reader-friendly HTML.

**Tests.**

- Canonicalization, tamper and vector tests.
- Integration: figures equal session verdicts; concurrent supersede is serialized.
- `integrity-basic` harness: the swarm is excluded under `datacenter_ip`, and a tampered row fails verification.

**Size.** M.

**Open questions.** The settle delay value.

### 4.9 Creator Analytics

**Problem and Twitch gap.** Twitch's viewbot filtering is opaque, and its 2025 rollout cut viewership with no per-session explanation. No platform shows creators what their audience costs to serve.

**User stories.**

- A streamer whose count dropped sees 120 sessions excluded under "datacenter" as one group.
- The same page shows that relays delivered 40% of last night's bytes.

**Design.**

- One rollup job runs on `stream.offline` after the shared settle delay. It writes `broadcast_audience_minutes` (verified, raw, excluded by category, by source) and `broadcast_costs` (bytes by source × an operator-declared cost model, kept in config until governance proposals exist).
- Categories only, never thresholds. 24-hour delay, minimum group size.
- **v1 is read-only.** Group appeals ship in Wave 2b, after W0-integrity fixes appeal stickiness, and are rate-limited.
- Cost is owner-private and marginal only. The public side gets an instance rollup with the community-delivered share (relays now; P2P once a client exists).
- Retention: per-minute data 90 days, per-broadcast data forever.

**Architecture fit.**

- Reads `playback_sessions`, `integrity_flags`, `egress_samples` and `infra_costs`.
- Contract: `analytics.{broadcast, range, exclusions, pnl}`. A new `APPEAL_SUBJECTS` value is added in 2b.
- Implements the `integrity.channelSummary` stub.
- Web: `apps/web/src/routes/_studio/analytics.tsx`.

**Integrity and T&S.** The detection oracle is mitigated by the delay and categories. A third-party `analytics:read` scope gets aggregates only.

**Money.** Read-only joins to ledger revenue lines.

**Accessibility.** Charts come with table fallbacks.

**Tests.**

- Rollup math unit tests (zero cost, CDN off).
- Integration: totals equal verdicts.
- `integrity-basic` harness: the swarm appears as one excluded group.

**Size.** M.

### 4.10 Ledger Splits

**Problem and Twitch gap.** Stream Together and Shared Chat put collaborators together, but money goes to whichever channel the viewer is on. Mods and editors are paid off-platform. Twitch, YouTube and Kick have no native split.

**User stories.**

- Four creators take 25% each for a marathon window.
- A streamer pays two mods 5% each and an editor 12% of tips.
- Every recipient sees their line.

**Why this is no longer Wave 1 (verified in the repo).**

- `releaseDueHolds` (`packages/ledger/src/holds.ts:48-55`):
  - groups lots by `e.memo` across _all_ `liability:creator-hold:%` accounts;
  - reads a single `metadata->>'creatorUserId'`;
  - dedupes on `hold-release:<paymentId>`.

  With N recipients under one memo, the lots get summed, the release goes to one creator, and every other recipient stays held for good.

- `holdRelease` (`rules.ts:188`), `refund`/`chargeback`/`chargebackReversal` (`rules.ts:333-382`), `PaymentMeta` and `postReversal` (`reversals.ts`) and `paymentHoldRemaining` (`queries.ts`) all assume one creator.

**Design.**

- `revenue_splits`: owner channel, recipient, basis (tips | subs | all), basis points, optional `broadcast_id` or window, cap, version.
- Recipients must accept and must have a payout account. Splits apply to future revenue only, and changes create versions.
- The co-op cut is taken once, before the split.
- `splitNetN(net, cut, shares)` via `largestRemainder` (`math.ts:54`).
- **Per-recipient memos** `hold:<paymentId>:<userId>` and idempotency keys `hold-release:<paymentId>:<userId>`. The due query groups by (account, memo).
- **PaymentMeta v2.** A versioned Zod schema with the share vector and `splitVersionId`. v1 is still read. The legacy recompute-from-cut path in `reversalSplit` stays for pre-splits payments.
- Reversals lock every recipient in sorted user-id order, so they can't deadlock against `runPayoutBatch` (`payouts.ts`). They produce hold, liability and receivable sources per recipient. `ChargebackMeta` stores a per-recipient vector so `chargebackReversal` can restore each slice.
- **Clawback policy (ADR 0013, decided before code). Proposed:**
  - (a) the owner channel absorbs recipients' clawback shortfalls;
  - (b) recipients' shares stay held for the full dispute window.

  So a 5% mod never becomes a co-op debtor over a dispute on someone else's channel. A co-op mutual (fin-4) stays parked.

- **Banned or legal-hold recipient:** the share goes to a suspense hold account keyed by recipient (`accounts.ts`). Release or forfeit is governance-visible, forfeits return to the owner channel and never silently to the co-op, and every movement writes `audit_log`. Enforcement lives in the hold-release job and the protections trigger, not only the API.
- **Cut from v1:** raid-share tails and chat room-linking.

**Architecture fit.**

- Migration:
  - `revenue_splits`, `revenue_split_acceptances`;
  - a real link table `revenue_split_postings(split_version_id, ledger_transaction_id)` written in the same transaction;
  - a protections trigger: a split is immutable once linked postings exist, basis points total ≤ 10,000 per basis, and accepted shares freeze.
- Contract: `money.splits.{list, propose, accept, end}`, event `channel.split.update`, scope `channel:manage:splits`.
- Studio Crew page. `audit_log` on every change.

**Integrity and T&S.**

- **Prerequisite: W1-fraud-floor** (card velocity, payer diversity, split graph). It _blocks payout release_ and does not merely flag.
- New split recipients get a payout hold of at least the payment hold plus an account-age gate.
- The treasurer gets a four-eyes flag on the first payout to a new split recipient.

**Money.**

- Payouts follow existing rules. Connect is deferred (ADR 0007), so crew balances are paid by the treasurer through the manual adapter, and the UI says so.
- A minimum payout and batching keep the treasurer's load bounded.
- Payment Breakdown already renders N lines.

**Accessibility.** The accept flow shows a plain-language preview ("a $10 tip gives each of you $2.18").

**Tests.**

- Property tests: sums preserved, 1¢ payments, 3- and 7-way splits, partial refund after a split ended, v1/v2 metadata mix.
- Trigger integration tests.
- Lock-ordering test against a concurrent payout batch.
- `e4b-money` harness:
  - a 2-way split tip **releases holds to both recipients**;
  - a chargeback claws back per the ADR 0013 policy;
  - a won chargeback restores each slice;
  - a split to a fresh recipient, then chargeback, then a payout attempt is blocked.

**Size.** L.

**Open questions.** Payee and contractor tax status (counsel). Notice period for ending a standing split.

### 4.11 Rehearsal Mode

**Problem and Twitch gap.** Twitch has no private test broadcast with a simulated audience. YouTube has unlisted streams but no simulated chat or events.

**User stories.** A 10-minute rehearsal on the normal key. Simulated chat at 3 msg/s and a spam burst exercise the filters. The creator gets a checklist: ingest green, filter held 4 messages, a bitrate dip at 12:04.

**Design.**

- New `broadcasts.kind` enum (`live|rehearsal`). The draft's `broadcasts.visibility` does not exist, and adding to `VISIBILITIES` would leak into VOD and clip semantics (`packages/db/src/schema/media.ts:150`).
- Because the broadcast row is created at publish, Studio **arms** a rehearsal first: a channel flag with a TTL in Valkey (`KEYS.rehearsalArmed`). The MediaMTX auth hook (`services/api/src/routes/stream.ts`) reads it.
- Exclusions:
  - **DB triggers** block `stream_hours`, patronage, integrity counts, attestations and ledger rows for rehearsal broadcasts.
  - Directory, notification and EventSub exclusion are app-level read filters, each with tests.
- At most ~5 named invitees, no anonymous links, no embed, no DVR. VOD kept 24 h. Duration capped.
- Full ADR 0006 T0/T1 sampling, with invitees audit-logged.
- The synthetic audience comes from a new `packages/sim` extracted from `harness/`, with harness ownership agreed.
- v1 checks ingest, transcode and health (`services/media/src/health`), chat filters and the held queue, and the player.
- Alert checks wait for 3D. Test tips never touch the ledger.

**Architecture fit.** Migration: enum plus triggers. Contract: `stream.rehearsal.{arm, presets, report}`. Worker `rehearsal-driver`.

**Integrity and T&S.** Private live broadcast is a classic abuse pattern, hence named invitees, full scanning and audit.

**Money.** Zero ledger effect, asserted.

**Accessibility.** The report is a checklist.

**Tests.** Harness `rehearsal` (new):

- no directory entry, notification, `stream_hours` row or ledger entry;
- simulated chat is filtered;
- an invitee can watch, and an anonymous link is refused.

**Size.** M.

### 4.12 Free Live DVR

**Problem and Twitch gap.** Twitch Stream Rewind (rolled out around September 2025) is limited to channel subscribers and Turbo, opt-in for Affiliates and Partners, and needs VODs on. Our gap: rewind free for every viewer, plus an honest split of "live" versus "catching up".

**User stories.** A late joiner drags back 20 minutes, presses L, and is live again.

**Design.**

- v1 window ≤ the VOD-backed window, read from object storage through `services/media/src/vod/assemble.ts`/`playlist.ts` and a new origin DVR playlist route issuing per-session segment tokens.
- **Source-only.** The recorder copies the source path (`vod/recorder.ts`, `-c copy`), so there is no ABR. The UI says so, and DVR is excluded from data mode. Recording the ladder is an ADR 0016 option, with its cost posted to `infra_costs`.
- **Visibility inherits the VOD gate.** A `subscribers` or `private` VOD gives a gated DVR or none.
- **Segments must not be publicly reachable.** Today the recorder uploads closed segments to `vods/<vodId>/` (`recorder.ts:9-11`), and `services/origin/src/media.ts:17` serves the `vods` prefix with no token or removal check. ADR 0009 accepts that withheld VOD objects stay readable at unguessable URLs. DVR v1 has in-progress recordings written to a private prefix that only the DVR route reads, and moves them to `vods/` on publish. That is the W0-media-exposure fix below.
- **Removal re-check** on every playlist request. A mid-stream T0 purges DVR segments.
- **Origin-only in v1.** DVR segments are relay-ineligible, because the relay cache (`relay/internal/cache`) has no purge path and relay tokens are bound to `live/<slug>`. The draft's "relays cache DVR without changes" line is deleted. A signed relay purge is a v2 prerequisite.
- Creator "DVR off" toggle.
- Heartbeats report `mode`/`behindLiveSeconds` through the seam. Counts split into "watching live" and "catching up", and only live feeds discovery and patronage.

**Architecture fit.**

- Contract: `PlaybackStart.dvrWindowSeconds`, heartbeat fields (landed with the Wave 1 `playbackMode`), channel `dvr_window_seconds` capped by an instance setting.
- New `services/origin/src/dvr.ts`, registered through the origin route seam (no `handler.ts` edit).
- Recorder prefix change in `services/media/src/vod/recorder.ts`.
- Count semantics in `packages/integrity/src/concurrency.ts`.
- Player UI `apps/web/src/player/dvr*.tsx` on the seam.

**Integrity and T&S.** DVR sessions accrue verified seconds for the gate but are not live viewers.

**Money.** DVR egress is origin egress in v1 and is costed in Analytics.

**Accessibility.** Keyboard seeking.

**Tests.**

- Origin unit tests: DVR playlist, removal re-check, visibility gate.
- Harness `live-dvr` (new):
  - DVR minutes are not counted live;
  - removed and in-progress segments return 404 via `/media` and via the DVR route;
  - a relay request for a DVR segment is refused.

**Size.** M.

**Open questions.** Segment upload lag, which sets the minimum distance behind live. Recorder-buffer v2 with a Valkey owner key.

### 4.13 Watch Rooms (Wave 3)

**Problem and Twitch gap.** Twitch discontinued its Prime Video Watch Parties in April 2024. Twitch has no friends-sync on a live channel. Stream Together and Guest Star are co-streaming, which this is not. Friends drift by seconds and fall back to Discord screen-share.

**User stories.** Four friends open a room on a tournament, their players lock together, and they share a side chat.

**Design.**

- At most 8 members. Signed-in, age-confirmed accounts.
- **No room mixes under-18 and adult accounts.** Rooms inherit every member's platform and channel bans. A host can't invite someone who has blocked a member.
- Sync to slowest member or host, capped at ~5 s behind the edge (`hlsSegmentCount 7`).
- Steering via the seam's `setTargetLatency()` (hls.js `liveSyncDuration`) rather than raw rate nudges. WebKit native: seek-only correction with ~1 s tolerance.
- New `services/chat/src/watch-rooms.ts`. Frame dispatch in `core.ts`/`socket.ts` is landed by the orchestrator, and `rooms.ts` (core fan-out) is untouched.
- Side chat goes through the normal filter.
- **Reports go to platform moderation, not channel mods.** Retention follows ADR 0017: a TTL'd table covered by the deletion worker, snapshotted into `evidence_objects` on report.
- Live only. Public presence is opt-in.

**Architecture fit.** Room frames and `CHAT_LIMITS` in contracts. A web drawer reusing chat-panel blocks and `<ChannelAvatar>`.

**Integrity and T&S.** Each member keeps their own session, so counts are unchanged.

**Money.** None.

**Accessibility.** Reduced-motion-safe reactions, keyboard-navigable chat.

**Tests.**

- Drift unit tests.
- Harness `watch-room`:
  - delta < 500 ms on Chromium and < 1 s on WebKit;
  - a mixed-age join is refused;
  - a report captures evidence.

**Size.** M.

**Open questions.** Report window (72 h proposed).

### 4.14 Portability phases 1–2 (Wave 3)

**Problem and Twitch gap.** Twitch followers can't be exported or contacted. The PLAN's Twitch import covers moving in only.

**User stories.**

- A creator pins a signed "follow me on CommonAir" link, and conversions are counted.
- A viewer opts into "keep me posted if they move" and gets one email when the creator does.

**Design.**

1. Signed move links `/m/<channel>/<nonce>`, with `follows.source` attribution (counts only) and rate-limited creation.
2. Consented portability grants plus email go-live notifications. `consent_records`, one-click unsubscribe, and creators never receive emails.
3. One versioned bundle schema shared with the Twitch import. It carries a signed moderation-standing statement. Destination imports run the T0 hash gate, and channels under legal hold are refused.

ActivityPub comes after the federation unit and its T&S design.

**Architecture fit.**

- Migration: `move_links`, `follow_portability_grants` (cascade on deletion), `follows.source`, `channels.moved_to`.
- Signing through `packages/tokens` (orchestrator) and email through `packages/email`.
- The bundle needs `me.exports` (E6).

**Integrity and T&S.** Counts use non-excluded follows only. Links are signed and rate-limited. The standing statement keeps exit from becoming ban evasion.

**Money.** Paid subs end with prorated refunds. The co-op bears the refund fee by rule, which needs finance sign-off.

**Accessibility.** Plain consent copy.

**Tests.** Harness `portability`: a link converts, Mailpit receives the moved notice, and a bundle round-trips.

**Size.** L.

**Open questions.** Twitch Developer Agreement and `TRADEMARKS.md` review.

## 5. Sequencing

**Status at `ef9f2b3` (2026-10-23).** E5 and E6 are done, most of the 2H2 items are fixed, and
some owner paths changed. The wave plans in `.claude/briefs/next/` (W0–W3) list each correction
and take precedence where they differ from this section.

**Workstream E (not this pod's).** E5 (coop, 25 stubs), E6 (exports, VOD/clips stubs, overlays) and Phase 3D (interact 21, bot 15) own the stubbed namespaces. The only stub any unit here implements is `integrity.channelSummary` (W2-rollup-analytics).

**Contract step first, every wave.** The orchestrator lands each wave's contract, enum, migration, KEYS, `packages/tokens` and router-registration edits in one commit, following the E4c "step 2" pattern, and writes `docs/testing/<unit>-selectors.md`. Then at most 6 units run in parallel on disjoint paths, each reviewed before merge.

### Wave 0: prerequisites (start now, in parallel)

| Unit                           | Owner paths (write)                                                                                                                                                     | Contracts honored                              | Tests                                                                        | Done when                                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| W0-clock                       | `services/media/src/ffmpeg/args.ts`, `services/media/src/clock/**` (offset publisher), `infra/mediamtx/mediamtx.yml`                                                    | ADR 0012 media-clock definition (spike output) | offset unit tests                                                            | harness `clock-skew`: cross-rendition skew < 100 ms, live-to-VOD skew < 250 ms                                      |
| W0-integrity                   | `packages/integrity/src/**` (scoring, appeals re-score), `services/worker/src/integrity/**`                                                                             | existing verdict and appeal shapes             | unit tests per 2H2 item; fetch-unjudged sessions marked ineligible for gates | `PROGRESS.md:235` 2H2 integrity items closed; `integrity-basic` passes with fetch-less bot and false-positive cases |
| W0-media-exposure (T&S triage) | `services/media/src/vod/recorder.ts` (private in-progress prefix), `services/origin/src/media.ts`                                                                       | ADR 0009 amendment                             | origin unit tests                                                            | in-progress and removed VOD segments return 404 via `/media`; `trust-safety` harness asserts it                     |
| W0-sor (compliance)            | `packages/moderation/src/reasons.ts`, `services/worker/src/moderation/sor-*`, `apps/web/src/routes/_app/settings.appeals.tsx`, `packages/email/src/templates/trust.tsx` | `me.enforcement.list`; SoR shape (ADR 0019)    | statement builder unit tests per action type; channel-mod actions excluded   | `trust-safety` asserts a statement for every platform T1/T2/NCII action                                             |

W0-clock and W0-media-exposure both touch `services/media`, but on disjoint files (`ffmpeg/args.ts` and `clock/**` versus `vod/recorder.ts`). W0-integrity and W1-watch-gate both touch `services/worker/src/integrity/jobs.ts`. W0-integrity owns it, and the `verifiedWatch` write lands after W0-integrity merges. Until then W1-watch-gate develops against a stub writer it owns in `services/worker/src/integrity/verified-watch.ts`, which W0-integrity's merge wires in.

### Wave 1: quick wins on existing foundations (6 parallel, plus 1b)

**Contract step contents (orchestrator):**

- `PaymentMeta` v2 schema (with v1 back-compat), the `cutHistoryId` field, and the `holdDays` move to `packages/config`.
- `money.paymentBreakdown(s)`, `transparency.feeSchedule` and the report subject `message_set`.
- Chat frames `mediaTs` and `playbackMode`, plus heartbeat `mode`/`behindLiveSeconds`.
- The `mediaTs` passthrough in `services/chat/src/{pipeline,core,types}.ts`, and `verifiedWatchSeconds` in `GateInput`/`Standing`.
- `KEYS.verifiedWatch`, `KEYS.surgeOverride`, `KEYS.chatLatency`.
- `ChannelChatSettings` fields and `chat.surge.*` events.
- Migration for `chat_messages.media_ts`.
- `chat-replay` router wiring and `money.ts` registrations.
- The api Prometheus metrics module (`services/api/src/metrics.ts` does not exist today).
- `dataMode` in `packages/contracts/src/tokens.ts`, `relay/internal/tokens/playback.go` and vectors (for 1b).

| Unit                                        | Owner paths (write)                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Contracts honored                                                          | Tests                                                     | Done when                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| W1-breakdown                                | `packages/ledger/src/breakdown.ts`, `packages/ledger/src/rules.ts` (`cutHistoryId` only; handed to W2-splits after merge), `services/api/src/money/{breakdown,fee-schedule}.ts`, `apps/web/src/components/money/{breakdown-*,fee-schedule}.tsx`, `apps/web/src/components/money/revenue.tsx`, `apps/web/src/routes/_studio/revenue.tsx`, `apps/web/src/routes/_app/settings.subscriptions.tsx`, `apps/web/src/components/support/support-dialog.tsx`, `packages/email/src/templates/payments.tsx` | PaymentMeta v1/v2, `money.paymentBreakdown(s)`, `transparency.feeSchedule` | property sum test (v1 and v2); int manual + stripe-mock   | `e4b-money` breakdown and reconciliation assertions pass     |
| W1-calm-chat                                | `apps/web/src/chat/calm/**`, `apps/web/src/chat/{chat-panel.tsx,view.ts,state.ts}`                                                                                                                                                                                                                                                                                                                                                                                                                | `ServerFrame`, `message_set` report subject, Spine queue export            | reducer/governor unit; axe; stories                       | `e2e-social` flood step passes                               |
| W1-spine [W0-clock merged]                  | `apps/web/src/player/controller.ts` (seam), `apps/web/src/chat/presentation.ts` (new), `apps/web/src/chat/connection.ts`, `services/chat/src/{clamp,persistence}.ts`, `services/api/src/chat-replay/**`                                                                                                                                                                                                                                                                                           | `mediaTs`/`playbackMode`, `media_ts` migration, `KEYS.chatLatency`         | clamp unit; replay exclusion int; seam unit               | `timeline-sync` passes; seam API documented in selectors doc |
| W1-watch-gate [flag; GA after W0-integrity] | `services/chat/src/{rules,cache}.ts`, `services/worker/src/integrity/verified-watch.ts`, `services/worker/src/jobs/chat-surge-guard.ts`, `apps/web/src/components/studio/chat-gate-settings.tsx`, mod banner component                                                                                                                                                                                                                                                                            | `ChannelChatSettings`, KEYS, `chat.surge.*`                                | hysteresis unit; Valkey int                               | `surge-guard` passes, including CDN-bot and per-IP cases     |
| W1-fraud-floor                              | `packages/integrity/src/payments/**` (new; not `signals/`), `packages/ledger/src/payouts.ts` (release eligibility hook), treasurer flag UI in `apps/web/src/components/money/treasury.tsx`                                                                                                                                                                                                                                                                                                        | payment fraud flags (migration in contract step)                           | velocity and payer-diversity unit tests; payout-block int | a flagged payee's payout is held in `e4b-money`              |
| W0-sor continues if not merged              | (see Wave 0)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |                                                                            |                                                           |                                                              |
| W1b-data-mode [W1-spine merged]             | `apps/web/src/player/{budget,stats,source}.ts`, `packages/integrity/src/allowance.ts`, `services/api/src/playback/**` (claim minting), `services/origin/src/auth.ts`                                                                                                                                                                                                                                                                                                                              | `dataMode` claim (TS, Go, vectors)                                         | budget unit; bound unit; vector tests                     | throttled-viewer harness step stays verified                 |

**Parallel safety.**

- Breakdown and fraud-floor share no files. Breakdown edits `components/money/revenue.tsx`, fraud-floor edits `treasury.tsx`.
- Calm-chat owns `state.ts` and wires in the Spine's exported queue.
- Spine and watch-gate split `services/chat` by file, with shared plumbing landed in the contract step.
- W1b-data-mode starts after W0-integrity merges (both touch `packages/integrity`) and after the Spine (it consumes the seam, not `controller.ts`).

### Wave 2 (at most 6 concurrent)

**Contract step:**

- ADR 0013 accepted; split tables, link table and trigger; `money.splits.*`.
- Caption settings and tables; the filter-pool extraction into `packages/chat-filter`.
- Analytics tables; `policy_rules`/`rule_ref`.
- `broadcasts.kind` with triggers and `KEYS.rehearsalArmed`.
- `PlaybackStart.dvrWindowSeconds`.
- An origin route-registration seam in `services/origin/src/handler.ts`.

| Unit                                            | Owner paths                                                                                                                                                                                                                                                                | Contracts                                                        | Done when                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| W2-splits [ADR 0013; W1-fraud-floor]            | `packages/ledger/src/{rules,reversals,math,holds,queries,locks,accounts}.ts`, `services/worker/src/money/holds.ts`, `services/api/src/money/splits.ts`, `apps/web/src/routes/_studio/crew.tsx`                                                                             | `money.splits.*`, split tables + trigger, `channel.split.update` | `e4b-money` per-recipient release, clawback and won-chargeback steps pass |
| W2-captions [ADR 0011; W1-spine]                | `services/media/src/captions/**`, `services/origin/src/playlist.ts`, `services/origin/src/captions.ts`, `scripts/fetch-model.ts`, sidecar compose service + `infra/image-licenses.json` entry, `apps/web/src/player/captions*`, `apps/web/src/routes/_studio/captions.tsx` | caption settings, `vods.captions.update`, tables                 | `captions` scenario (WER, cue timing, VOD)                                |
| W2-rollup-analytics                             | `services/worker/src/jobs/broadcast-rollup.ts`, `services/api/src/routes/integrity.ts`, `services/api/src/analytics/**`, `apps/web/src/routes/_studio/analytics.tsx`                                                                                                       | `analytics.*`, rollup tables, shared settle constant             | `integrity-basic` group assertion                                         |
| W2-enforcement-report                           | `apps/web/src/components/transparency/enforcement-report.tsx`, `services/api/src/transparency/enforcement.ts`, `packages/moderation/src/clauses.ts`                                                                                                                        | `policy_rules`, `rule_ref`, `transparency.enforcement`           | `trust-safety` report assertions                                          |
| W2-dvr [W1-spine; W0-media-exposure]            | `services/origin/src/dvr.ts`, `apps/web/src/player/dvr*`, `packages/integrity/src/concurrency.ts`                                                                                                                                                                          | `dvrWindowSeconds`, heartbeat `mode`                             | `live-dvr` passes (404 via `/media`, relay refusal, removal)              |
| W2-rehearsal                                    | `packages/sim/**`, `services/worker/src/jobs/rehearsal-driver.ts`, `apps/web/src/routes/_studio/rehearse.tsx`, rehearsal arming in `services/api/src/stream/rehearsal.ts`                                                                                                  | `stream.rehearsal.*`, `broadcasts.kind`                          | `rehearsal` passes                                                        |
| W2b-attestations [rollup merged; W0-integrity]  | `services/worker/src/jobs/integrity-attestation.ts`, `services/api/src/routes/integrity.ts` (handed over from rollup), verifier route, SDK helper. `packages/tokens/src/attestation.ts` + vectors are orchestrator-owned.                                                  | `integrity.attestations.*`, key env, append-only table           | `integrity-basic` signed + tamper steps                                   |
| W2b-group-appeals [rollup merged; W0-integrity] | `services/api/src/analytics/appeals.ts`, analytics route section                                                                                                                                                                                                           | new `APPEAL_SUBJECTS` value                                      | rate-limited group appeal harness step                                    |

**Conflicts to watch.**

- Captions owns `origin/playlist.ts`. DVR registers through the route seam and never edits `playlist.ts` or `handler.ts`.
- No Wave 2 unit edits `controller.ts`: captions, DVR and (later) rooms use the seam.
- `services/api/src/routes/integrity.ts` is handed from rollup to attestations, and that ordering is enforced.
- W2-splits and W2-dvr both touch `packages/integrity`? No: splits uses `packages/integrity/src/payments/**` read-only, and DVR owns `concurrency.ts`.

### Wave 3 (after E5, E6 and 3D)

- **W3-watch-rooms:** ADR 0017 accepted; on the seam.
- **W3-portability:** links, then grants and email, then the bundle and import.
- **W3-giveaways:** after 3D interact.
- **W3-jury:** advisory, after E5 membership.
- **W3-surge-raids:** after `interact.raids`.
- **W3-fair-predictions:** channel points only.
- **W3-dvr-relay:** signed relay purge, then relay-eligible DVR.

Each phase ends with `bun run verify:full`.

## 6. Metrics

All metrics are first-party: Prometheus counters in `services/chat`, `services/origin` and `services/worker` (and the new `services/api/src/metrics.ts` from the Wave 1 contract step), plus SQL aggregates. No third-party scripts, no per-user tracking, no ids or IPs in labels. Integrity heartbeats carry no UI-preference fields.

| Feature            | Landed when                                                                                                 | Source                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Payment Breakdown  | ≥ 25% of payments' breakdowns opened within 7 days; zero reconciliation mismatches                          | api `payment_breakdown_views_total`; nightly SQL invariant     |
| Calm Chat          | zero dropped mentions in harness; axe clean. No adoption telemetry in v1 (cut per review)                   | harness                                                        |
| Spine              | ≥ 95% of web chat messages carry `media_ts`; replay order error < 1 s; skew within W0 targets               | SQL on `chat_messages`; `clock-skew` harness; media skew gauge |
| Watch gate         | hate-raid reports per gated channel fall against their own baseline; false-positive appeals < 2% of denials | `reports`, `appeals`, chat denial counter                      |
| Captions           | % of opted-in live minutes captioned; fixture WER; queue wait p95; cue-before-playhead rate                 | media metrics, `broadcast_caption_tracks`                      |
| Any-Connection     | audio-only sessions that stay verified ≥ 98%                                                                | verdicts by `dataMode`                                         |
| SoR (compliance)   | 100% of platform T1/T2/NCII actions have a statement                                                        | `audit_log` join                                               |
| Enforcement report | median time-to-decision published monthly                                                                   | `audit_log`                                                    |
| Attestations       | exactly 1 per ended broadcast; well-known key fetches                                                       | `integrity_attestations`, origin counter                       |
| Analytics          | group-appeal overturn rate (2b)                                                                             | `appeals`                                                      |
| Splits             | active splits; zero stuck holds (holds past due with no release); zero reversal imbalances                  | SQL; balance trigger                                           |
| Fraud floor        | payouts held for review and their outcomes                                                                  | worker money metrics                                           |
| Rehearsal          | rehearsals that precede a first live broadcast                                                              | `broadcasts.kind`                                              |
| DVR                | catching-up share of viewer-minutes; DVR origin egress                                                      | integrity counts, `egress_samples`                             |
| Watch Rooms        | rooms per 1k live sessions; reports per room-hour                                                           | chat counters, `reports`                                       |
| Portability        | move-link conversions; portable followers                                                                   | `follows.source`, grants                                       |

## 7. Decisions needed

**ADRs (continuing from 0010):**

- **0011** Caption models: whisper.cpp plus the exact weights at the pinned digest; CC-BY weight policy before translation; caption word-masking is creator-configurable masking, not removal.
- **0012** Media clock and Timeline Spine: the clock-alignment method; the `media_ts` clamp (`startedAt` bound, DVR null); presentation defaults; IRC behaviour; **chat retention and replay** (exclusions, blocks, disclosure).
- **0013** Ledger Splits: per-recipient memo and idempotency keys; PaymentMeta v2 with v1 back-compat and a migration plan for in-flight payments; sorted-lock order; **recipient clawback and liability policy**; the suspense account and forfeit destination; the postings link table.
- **0014** Attestation key: worker-only key, `kid`, rotation history; threshold hash; the shared settle constant (also used by Analytics); supersede semantics; the advisory-lock chain.
- **0015** Verified-watch signal: Valkey key and TTL; fetch-unjudged = unverified; per-network cap; oracle hardening; fallback gate; flag-to-GA criteria.
- **0016** DVR: storage-backed, source-only v1; VOD visibility inheritance; private in-progress prefix; origin-only; relay purge as the v2 prerequisite; count semantics.
- **0017** Watch Rooms retention: a TTL'd table with deletion-worker coverage; the platform-moderation report route; the age-mixing rule.
- **0018** `dataMode` as a token claim (TS, Go, vectors; ADR 0005 caps untouched).
- **0019** Clause catalog and statement-of-reasons shape; platform versus channel-mod scoping.
- **ADR 0009 amendment:** the in-progress recording prefix, and whether `subscribers`/`private` VOD objects should leave the public `vods/` prefix.

**Governance (after E5):**

- The analytics cost model.
- The caption worker cap and "captions on by default".
- Viewer-membership bases stay protected proposals.

**Counsel:**

- DSA statement content for EU instances (W0-sor).
- Payee and contractor status for split recipients.
- Twitch Developer Agreement and trademark terms.
- Sweepstakes rules for giveaways.

**Licensing:**

- whisper.cpp (MIT) and its weights.
- The sidecar base image in `infra/image-licenses.json`.
- The SDK verifier uses `packages/tokens` code, with no new dependency.
- `bun scripts/check-licenses.ts` runs per unit.

## 8. Pod debate log

1. **Paying mods (pm-1).** The PM pitched patronage weighted by presence-hours. The six other roles rejected it: there is no chat presence key (`packages/contracts/src/internal.ts`), idle tabs would earn, and volume weighting pays mods to act more. **Resolved:** a creator-funded crew split (4.10). The co-op component is parked, and if revived it pays flat eligibility.
2. **Binding versus advisory jury.** Finance wanted binding. T&S argued that DSA/OSA liability can't be delegated. **Resolved:** advisory jury in Wave 3. Binding outcomes are parked.
3. **DVR gap claim.** **Resolved by EM check:** Stream Rewind exists, gated. The feature was reframed to "free and ungated". The storage-backed v1 was chosen over the recorder buffer.
4. **P2P economics.** `bytesP2p: 0` is hardcoded (`controller.ts:180`). **Resolved:** no P2P claims in Waves 1–3. The browser client is an unscheduled prerequisite.
5. **arch-4, paying viewers for P2P bytes.** **Killed.**
6. **Watch Rooms ephemerality.** **Resolved:** retained for the report window. In review it became DB-backed under ADR 0017 and moved to Wave 3.
7. **Surge guard default.** **Resolved:** off by default. In review: behind an instance flag until W0-integrity, with the override held as TTL'd Valkey state.
8. **Patronage estimate on receipts.** **Resolved:** dropped until E5.
9. **Fee line.** In the draft, the processor fee was shown inside the co-op slice. **Revised in review** (Finance): separate co-op share, fee and co-op net lines. Co-op net can be negative at the 10% cut. The dispute fee sits outside gross.
10. **Chat hold-back.** **Resolved:** overlays only by default. Own messages echo instantly.
11. **Timed cues (rt-5).** **Resolved:** standard SUBTITLES now. The cue model is parked until 3D.
12. **Participatory budget enforcement.** **Parked** as advisory.
13. **Membership by watch hours.** **Removed.**
14. **Pricing (fin-5).** **Parked** with card-testing conditions.
15. **Simulcast.** Already built (`services/media/src/simulcast.ts`). Inbound chat aggregation is parked as an optional adapter.
16. **Signed proofs scope.** PDF, badge and country data are cut.
17. **Public cost cards.** **Resolved:** owner-private, with a public instance rollup.
18. **(Review) Splits in Wave 1.** The Architect, Finance and T&S each found the hold, reversal and chargeback paths single-recipient. **EM verified** in `holds.ts:48-55` (memo grouping, scalar `creatorUserId`, `hold-release:<paymentId>` key) and `rules.ts:188/333-382`. **Resolved:** size L, Wave 2, behind ADR 0013 and W1-fraud-floor. Finance's clawback-fairness concern is a required ADR section, and the proposed default is that the owner absorbs shortfalls.
19. **(Review) One media clock.** The Architect and Realtime both showed per-path PDT stamping. **EM verified** that `mediamtx.yml` has `hlsVariant: lowLatency` and no `useAbsoluteTimestamp`, and that `args.ts:169` is the recorder. **Resolved:** W0-clock unit, harness `clock-skew`, and the Spine resized to L. The PDT passthrough tests already exist and were cut as deliverables.
20. **(Review) Where the integrity gate applies.** The draft gated only attestations. T&S argued the watch gate and group appeals depend on the same open items. **EM verified** that the items are at `PROGRESS.md:235` and that `HANDOFF.md` has no matching text; the draft's "HANDOFF" citation is corrected. **Resolved:** W0-integrity gates watch-gate GA, group appeals and attestations. CDN- and `no_accounting`-skipped sessions are unverified for gating (`signals/fetch.ts:107`).
21. **(Review) DVR exposure.** Realtime found `/media/vods` public with no checks. **EM verified** `media.ts:17`. ADR 0009 explicitly accepts that withheld VOD objects stay readable at unguessable URLs. **Resolved:** a W0-media-exposure triage unit, a private in-progress prefix, and an ADR 0009 amendment question about gated VODs. T&S added that the relay has no purge path. **Resolved:** DVR is origin-only in v1, and the "relays cache DVR" line is deleted.
22. **(Review) SoR as a feature versus compliance.** T&S argued that statements of reasons are owed now. **Resolved:** unscored W0-sor track. Channel-mod actions are excluded from platform statements and statistics.
23. **(Review) Public split card.** Finance (no information before splits) and T&S (crew income can be diffed after splits) both asked to cut it. **Cut**, revisit after Splits plus a privacy review. Finance's fee-schedule changelog was promoted in its place.
24. **(Review) Calm Chat metric.** All four reviewers flagged that it was a heartbeat contract change and UI telemetry in evidence. **Cut** for v1.
25. **(Review) Watch Rooms wave.** The Architect wanted it moved to Wave 3. Realtime accepted it in Wave 2 with a seam and tolerance fixes. **EM chose Wave 3.** It carries the highest T&S risk, it was the third parallel `controller.ts` consumer, and its retention design was not DB-backed.
26. **(Review) Naming.** Finance flagged the "receipt" collision with relay receipts. **Resolved:** `money.paymentBreakdown` and `integrity.attestations`.

**Review outcome.**

- **Staff Engineer / Architect: approve-with-changes, all blocking items resolved.**
  - Splits: L, Wave 2, holds and worker ownership added, per-recipient keys and PaymentMeta v2 in ADR 0013.
  - Clock: W0-clock spike and unit.
  - Token claim ownership corrected to contracts/Go/vectors, `services/api/src/playback` and `services/origin/src/auth.ts`.
  - Chat plumbing moved to the contract step. `rules.ts` stays pure, with `cache.ts` added.
  - `state.ts` assigned to calm-chat.
  - Replay moved to a new `services/api/src/chat-replay/`.
  - `packages/tokens` work is orchestrator-owned.
  - `broadcasts.kind` with arming.
  - Filter pool extracted to a package, sidecar infra owned.
  - DVR visibility inheritance and source-only decision; route seam in place of `handler.ts` edits.
  - Non-blocking items applied: HEAD re-stamped, DVR `media_ts` null, `KEYS.chatLatency`, signed-in-only gate with TTL, TTL'd surge override, shared settle constant, `watch-rooms.ts` plus DB retention, YouTube framing, ADR 0013 before receipts (v2 schema frozen in the contract step), AML in a payments module, link table, advisory lock.
  - Cuts and adds all accepted.
- **Senior Realtime & Media Engineer: approve-with-changes, all blocking items resolved.**
  - Clock-alignment unit with skew targets; the Spine resized to L.
  - Redundant PDT tests cut.
  - `watch-rooms.ts`, with the orchestrator handling dispatch.
  - Player seam API and origin route seam as done criteria.
  - DVR exposure fixed through W0-media-exposure.
  - DVR source-only, excluded from data mode.
  - `playbackMode` in the Wave 1 contract.
  - Replay handlers in new files.
  - Non-blocking items applied: `presentation.ts` labelled new, Safari path noted as existing, captions latency profile and cue-timing assertion, LL-HLS subtitle and relay URI tests, room target cap and `liveSyncDuration` steering, 1 s WebKit tolerance, recorder-clock clip replay, orchestrator-assigned migration numbers, split-graph registration outside `signals/`.
- **Billing & Co-op Finance Lead: approve-with-changes, all blocking items resolved.**
  - Hold-release keys, the grouping fix and `queries.ts`/`locks.ts` ownership.
  - Full N-way reversal scope with sorted locks and the chargeback vector.
  - Clawback policy as a required ADR section with a proposed default.
  - Router and barrel registrations moved to the contract step.
  - v1/v2 metadata frozen up front.
  - Fee lines and invariants rewritten.
  - Breakdown owner paths corrected (`revenue.tsx` ×2, `support-dialog.tsx`, `payments.tsx`).
  - Non-blocking items applied: `cutSource` resolution, seed fallback and `cutHistoryId`; renaming; split card cut; Twitch money claims softened; suspense account with the forfeit destination and audit; the payments-module fraud floor; link table; estimate range.
  - Adds accepted: fee-schedule changelog, chargeback timeline, ADR sections, release and won-chargeback harness steps, reconciliation invariant.
- **Trust & Safety / Integrity Lead: approve-with-changes, all blocking items resolved.**
  - Gate plumbing moved to the contract step.
  - CDN- and `no_accounting`-skipped sessions are unverified for gating.
  - The integrity gate extended to the watch gate and analytics appeals, with the citation corrected to `PROGRESS.md:235`.
  - Fraud floor as a Wave 1 prerequisite that blocks payouts, with a four-eyes flag and trigger or job enforcement.
  - Dual-format metadata.
  - DVR relay-ineligible.
  - SoR moved to Wave 0/1 compliance with channel-mod scoping.
  - Non-blocking items applied: `metrics.ts` facts corrected (api has none; added in the contract step); `broadcasts.kind`; directory exclusion stated as app-level; `message_set` report subject; replay exclusions and retention; `startedAt` clamp with receive time authoritative; per-network cap and i18n codes; room age-mixing, report routing and ban inheritance; Watch Parties stated as discontinued in April 2024; the `integrity.ts` handoff; anonymous payer masking; caption masking.
  - Cuts and adds all accepted, including abuse harness cases per surface.

## 9. Parked and killed

**Killed:**

- **arch-4 Viewers earn for P2P bytes.** There is no browser P2P client, residential proxy pairs defeat cross-attestation, and it would fund viewbot farms.
- **ux-4 membership by watch hours.** A Sybil route to votes.

**Parked, with the trigger to revisit:**

- **Public channel split card.** After Splits ships and a privacy review shows crew income can't be diffed.
- **Fast payouts (fin-3) and Chargeback Mutual (fin-4).** Risk-scaled `holdDaysFor()` comes first, as a pure `holds.ts` change after W2-splits. On-demand withdrawal needs a payout rail (Connect is deferred by ADR 0007, or a SEPA pain.001 exporter with four-eyes approval), the reserve, and the fraud floor, which is now scheduled.
- **Creator-set and PWYW pricing (fin-5).** After the fraud floor. The floor price must sit above card-testing economics, with per-card velocity limits.
- **Open Books Merkle proofs (fin-2).** After the Payment Breakdown.
- **Participatory Budget (fin-6).** Advisory, after E5.
- **Squad multiview (rt-4a)** after the Spine and the 3D collab entity. **Multi-angle and WHIP guests (rt-4b)** are deferred because of the credential surface and the per-angle transcode and T0 sampling cost.
- **Timed cue track (rt-5).** After 3D.
- **Hosted automations (dx-3).** Declarative 3D bot first, then recipes, then QuickJS-WASM behind an instance flag that defaults off.
- **Helix-compatible shim (dx-4).** After interact and developer leave 501, and after counsel review.
- **Mod Circles (tns-4).** Monitor-only until `chat.held.list/resolve` exist.
- **ActivityPub actor and Move.** With the federation unit and its T&S design.
- **Mod patronage component.** After E5, counsel review and overturn data.
- **Attendance stamps.** NFT optics. A studio "moment" button that creates a VOD chapter comes first.
- **DVR via relays and the recorder buffer.** After a signed relay purge (W3-dvr-relay) and a Valkey owner key.
- **Calm Chat adoption telemetry.** Only with a separate aggregated counter, never in heartbeats.
- **Ideas for a future pitch round:**
  - a browser P2P client on `services/tracker` under ADR 0005;
  - report-with-moment evidence (a Spine follow-on, using receive time as authoritative);
  - a server-side BRB slate and backup ingest;
  - a photosensitivity flash guard on frame sampling;
  - multi-audio tracks;
  - a schedule plus ICS feed;
  - channel-as-code export (shares the bundle schema);
  - a scorer ruleset changelog and red-team (required before attestations go public);
  - an age-assurance adapter seam (ADR 0006: self-declaration is insufficient under the OSA; it would strengthen Watch Rooms);
  - inbound simulcast chat aggregation as an optional adapter.
