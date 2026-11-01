<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W3-fair-predictions: fair predictions (media-time lock, conflict-of-interest, audited results)

You are implementing unit W3-fair-predictions for CommonAir (repo: /Users/joshe/Repos/bcon). Read
these first:

- AGENTS.md, PLAN.md and docs/architecture.md.
- `.claude/briefs/batch7/README.md`. Decisions (v), (ac), the path ownership and the shared rules
  are binding.
- `.claude/briefs/w3/contract-step.md`:
  - §2.4: the `bet` input `mediaTs` / `playbackMode`; `Prediction.lockMediaTs` / `resolvedBy` /
    `result`.
  - §3.1–3.2: the prediction columns and the bet trigger.
  - §5.4: the interact web client passes `mediaTs`.
- `docs/decisions/0026-interactivity-policies.md` decision 3 (points only, the payout rules).
- ADR 0012 (the media clock and `mediaTs`).
- ADR 0015 (verified watch).
- ADR 0016 decision 6 (catching up).
- ADR 0039 (written by the contract step).
- `docs/testing/b7-selectors.md`.
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 1**. Work in your own git worktree on branch
`w3/predictions`, cut from the contract step's sha.

## Why

A prediction should be decided by what the viewer saw, not by how fast their connection is.
Today the lock is wall-clock, so a viewer with low latency (or someone watching a restream) can
bet after the outcome is visible to them, before others see it. The streamer's own team can also
bet on results they control. Fair predictions:

- lock by media time;
- keep the channel's team out of the pool;
- require verified watching to bet;
- publish an audited result whose payouts provably sum to the pool.

Points only, as before (ADR 0026).

## You own (write only these)

- `packages/interact/src/predictions.ts`
- `services/api/src/interact/predictions/**`
- `services/api/src/routes/interact/predictions.ts`
- `apps/web/src/components/interact-studio/prediction-panel.tsx`
- `apps/web/src/chat/interact/prediction-card.tsx`
- `apps/web/src/i18n/locales/{en,es}/w3-predictions.json` and `keys/w3-predictions.gen.ts`
- `harness/src/w3/predictions.ts` and `harness/tests/w3/predictions*`

**Read-only:**

- `packages/ledger/src/math.ts` (`largestRemainder` `:54`)
- `services/api/src/points/service.ts`
- `services/worker/src/integrity/verified-watch.ts`
- `apps/web/src/chat/interact/{state,client,use-chat-interact}.ts`
- `apps/web/src/player/controller.ts`
- `packages/{contracts,db,config}/**`

Anything else is a **contract request**.

## Contracts you must honor

- `interact.predictions.{current, create, bet, lock, resolve, cancel}`, with the new fields.
- The columns `predictions.lock_media_ts` and `predictions.resolved_by`, and
  `prediction_bets.media_ts`.
- The bet trigger: it refuses `media_ts >= lock_media_ts`, and it refuses the owner, moderators
  and editors.
- The points protections (`0034_e8_protections.sql`): append-only, trigger-maintained balance,
  no overdraw.
- The `prediction_bet` / `prediction_payout` / `prediction_refund` reasons.

## Build

1. **Bet rules**, in `packages/interact/src/predictions.ts` (pure) and the API service:
   - The bettor needs verified-watch standing on the channel (the ADR 0015 key) at bet time.
   - The owner, channel moderators and editors are refused, with a clear code. The trigger is
     the backstop.
   - A bet carries `mediaTs` (the player's `playheadWallclock`) and `playbackMode`. A `dvr` or
     catching-up session is refused.
   - Before lock, `mediaTs` must be within 30 s of the server's current media edge. That bounds
     what a client lying about being far behind can gain (the `timeline-sync` far viewer sits
     about 9 s back).
   - After lock, a bet is accepted only if `mediaTs < lock_media_ts` **and** wall-clock is
     within 30 s of the lock (the grace, the same bound). Otherwise it is refused.
   - Missing `mediaTs` is treated as wall-clock now, so the bet is refused after the lock.
2. **Lock.** `lock` stores `lock_media_ts` as the broadcast's media-clock edge at lock time (the
   media clock of ADR 0012; read it the way the chat clamp does). An auto-lock at `locksAt` does
   the same.
3. **Resolve and cancel.** These store `resolved_by` and write an `audit_log` row (prediction id,
   outcome, resolver id) in the same transaction. Payouts stay `largestRemainder`, ordered by user
   id (ADR 0026). The `result` card holds the pool, the winner count and `payoutSum`, and the
   service asserts `payoutSum === pool` (or a full refund) before commit.
4. **Web.**
   - The viewer card shows "locks at what you see", the reason a bet was refused (not watching
     live, team member, not verified yet), and the result card after resolve.
   - The studio panel shows who resolved, and a note that the team cannot bet.
   - Strings go in `w3-predictions`, `en` and `es`.

## Tests you must add

- **Unit (exhaustive):**
  - lock and grace edges (exactly at `lock_media_ts`, 1 ms before, grace ±1 ms);
  - DVR and catching-up refusals;
  - the edge-distance check;
  - missing `mediaTs`;
  - the team refusal for each role;
  - `payoutSum` equals the pool across random pools (a property test), including ties and a
    single winner;
  - an outcome with no bets refunds.
- **API integration:**
  - a low-latency bettor and a high-latency bettor both bet with `mediaTs` before the lock; after
    the lock only the one whose `mediaTs` is before `lock_media_ts` is accepted;
  - a moderator's bet is refused (by the API and by the trigger on a direct insert);
  - an unverified viewer is refused;
  - resolve writes an audit row and `resolved_by`;
  - an overdraw still maps to the contract error.
- **Web unit:** the card refusal messages, and the result card.
- **Harness `interact` extension step `fair-prediction`:**
  1. Two viewers at different latencies (the `timeline-sync` far-viewer helper).
  2. The streamer creates a prediction and locks it.
  3. The far viewer's bet placed just after the wall-clock lock (but before the lock in media time)
     is accepted.
  4. The near viewer's later bet is refused.
  5. A moderator's bet is refused.
  6. Resolve. The result card's payouts sum to the pool, and the audit row exists.

## Done means

Follow `.claude/briefs/_done-means.md`:

- `bun run test` / `test:int` in `packages/interact` and `services/api` (one `test:int` at a
  time).
- `bunx tsc -p` for each.
- `bun --bun vp test run` in `apps/web` and `harness`.
- `vp build` in `apps/web`.
- `vp lint --deny-warnings` and `vp fmt`.
- The i18n check.
- `reuse lint`.

`git status` shows only your paths. Commit with `git commit -s`.

Then tell the user to run `bun harness/src/cli.ts run interact --set w3=fair-prediction`, and to
check the card and the studio panel by hand under `en`, `es` and `en-XA`, at 320 px, dark and
light.
