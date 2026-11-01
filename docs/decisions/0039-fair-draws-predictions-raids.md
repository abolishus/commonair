<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0039: Fair draws, fair predictions and surge raids

- Status: proposed (maintainer to accept; see [Decisions at acceptance](#decisions-at-acceptance))
- Date: 2026-11-01 (code checked at `3bb7af9b`)
- Gates: W3-giveaways, W3-fair-predictions and W3-surge-raids, and the jury draw of W3-jury
  ([batch 7 contract step](../../.claude/briefs/w3/contract-step.md) §2.1–§2.4, §3.1, §3.2, §4.1;
  briefs [giveaways](../../.claude/briefs/w3/W3-giveaways.md),
  [fair predictions](../../.claude/briefs/w3/W3-fair-predictions.md),
  [surge raids](../../.claude/briefs/w3/W3-surge-raids.md))

**No counsel retained; listed for post-launch review.** Sweepstakes law for giveaways and the
official-rules draft were decided by the maintainer with the conservative default (free entry,
shipped off; decisions (a), (h)) and are listed under "Post-launch review" in the batch 7 README.
This is not legal advice.

## Context

Feature-wins §4.13 (wave 3) asks for three interactivity features that are fair in a way a viewer
can check: giveaways whose draw anyone can re-run, predictions decided by what the viewer saw
rather than by connection speed, and raids that cannot be used to deliver a hate raid. ADR 0038's
jury needs the same kind of draw as giveaways.

What exists at `3bb7af9b`:

- **Predictions** (ADR 0026 decision 3): points only, never money; payouts by `largestRemainder`
  (`packages/ledger/src/math.ts:54`) ordered by user id; the lock is wall-clock (`locksAt`). Anyone
  can bet, including the channel's own team.
- **The media clock** (ADR 0012): every output's PDT equals the source PDT; the player exposes
  `playheadWallclock` and `playbackMode`, and heartbeats tell live from catching up (ADR 0016
  decision 6).
- **Verified watching** (ADR 0015): `KEYS.verifiedWatch(channelId, userId)` holds
  `{ b, s, f }` (live broadcast, gate-eligible seconds, privacy-relay fallback), written with
  `SET … EX 600` by `services/worker/src/integrity/verified-watch.ts`; chat ignores a value whose `b`
  is not the channel's live broadcast.
- **Surge guard** (ADR 0015 decision 6): `KEYS.surgeOverride` with `state: "on" | "suppressed"`,
  `until` and a TTL; behind `CHAT_SURGE_GUARD`; while on, chat requires
  `max(minVerifiedWatchSeconds, 60)` verified seconds.
- **Raids** (ADR 0026 decision 4) execute in `services/worker/src/interact/raids/execute.ts` and
  never touch the surge guard. The raid count is the verified count (`raidViewerCount`).
- No giveaway or draw code exists.

## Decisions

### 1. The fair draw: commit-reveal and HMAC-SHA256 with rejection sampling (decision (s))

`packages/draw` (new, AGPL, Web Crypto only, no dependency) is the one draw for giveaways and the
jury. Its vectors (`packages/draw/vectors.json`) are normative; the description below matches them.

- **Seed and commitment.** The seed is 32 bytes from the CSPRNG. `commit(seed)` is the lowercase
  hex SHA-256 of the seed bytes. The commitment is published when the draw opens (a giveaway opens;
  a jury panel is created), **before** any entry or candidate exists, and an `audit_log` row records
  it. The seed is revealed when the draw closes, with a second audit row; `verifyReveal` checks it
  against the commitment. A trigger makes the commitment immutable and lets the seed be set once,
  only if `sha256(seed) = seed_commitment` (`giveaways`, `jury_panels`).
- **Draw.** `draw(seed, entries, count)` takes the entry list **sorted** (byte order of the
  identifiers the caller publishes: pseudonyms for giveaways, user ids or case ids for the jury) and
  returns `min(count, n)` distinct indices into it, in rank order. It is a partial Fisher-Yates
  shuffle driven by HMAC-SHA256 keyed with the seed: for pick `j` (range `m = n − j`) and attempt
  `c = 0, 1, …`, take the first 4 bytes of `HMAC-SHA256(seed, uint32be(j) ‖ uint32be(c))` as an
  unsigned big-endian integer `r`; accept when `r < 2³² − (2³² mod m)` and use `r mod m`, else try
  `c + 1`. Rejection sampling removes modulo bias. `count ≥ n` returns every entry in a random
  order; `n = 0` or `count = 0` returns nothing.
- **Domain separation.** A caller that draws twice from one seed (the jury: seats, then cases)
  separates the draws with a fixed domain label, as `packages/draw` and its vectors define it, so the
  two draws are independent.
- **Pseudonyms.** `pseudonym(salt, userId)` is the lowercase hex `HMAC-SHA256(salt, utf8(userId))`.
  The salt is 32 random bytes, kept with the seed and revealed with it.
- **What it guarantees.** Once the commitment is published, no one can change the seed, so no one
  can pick winners after seeing the entries; anyone with the revealed seed, salt and published list
  can re-run the draw. The instance holds the seed between open and close (encrypted at rest with
  `encryptSecret`), and a streamer never sees it. An instance operator who reads the seed and
  injects entries could steer a result; eligibility (decision 2) makes injected entries cost real,
  verified accounts. The operator is trusted for that, as for the rest of the platform.

### 2. Giveaways (decision (t))

- **Off by default.** `GIVEAWAYS_ENABLED` (api, worker, chat) defaults false and is published as
  `instance.info().features.giveaways`. While false, every procedure answers `FORBIDDEN` and the
  chat plugin does nothing. Turning it on is the maintainer's call (decision (a)).
- **Free entry.** No payment, subscription or points entry, ever. Eligibility may use only account
  age, follow age and verified-watch seconds (ADR 0015); the eligibility schema cannot express any
  other criterion. One entry per account (primary key `(giveaway, user)`), by a button or by a chat
  message equal to the keyword.
- **Limits.** One open giveaway per channel (a partial unique index); at most
  `GIVEAWAY_RULES.maxWinners` (10) winners; an optional timed close at most
  `GIVEAWAY_RULES.maxDurationMinutes` (1,440) after opening. A trigger refuses an entry after
  `closes_at` or once the status is not `open`; winners are append-only.
- **The draw.** At draw, entrants are sorted by pseudonym and `draw` picks the winners. A winner
  who is ineligible at draw time (banned or deleted) is skipped and the next index is drawn and
  recorded, so the verify page reproduces the skip.
- **Public verification.** `interact.giveaways.verify` (public) returns the commitment, the
  revealed seed and salt, the sorted pseudonyms and the winners' indices and pseudonyms. A winner's
  username appears only if that winner allows it (default: the pseudonym only). The verify page
  re-runs the draw in the browser with `packages/draw` and shows whether it matches.
- **Records.** Open, close, draw and cancel each write an `audit_log` row; `channel.giveaway.begin`
  and `channel.giveaway.end` go through the outbox. Winners get an in-app notification. **The
  platform handles no prize**: the prize is the streamer's text and the streamer's obligation.

### 3. Fair predictions (decision (v))

Predictions stay points-only (ADR 0026 decision 3). Three rules make them fair:

- **Who may bet.** The bettor needs verified-watch standing on the channel (a current
  `KEYS.verifiedWatch` for the live broadcast) at bet time. The owner, channel moderators and
  editors cannot bet; a trigger on `prediction_bets` refuses them as the backstop.
- **The lock is by media time.** `lock` (and the auto-lock at `locksAt`) stores `lock_media_ts`, the
  broadcast's media-clock edge at lock time, read as the chat clamp reads it (ADR 0012). A bet
  carries `mediaTs` (the player's `playheadWallclock`) and `playbackMode`, and:
  - a bet whose `playbackMode` is `dvr` (catching up) is refused;
  - before the lock, `mediaTs` must be within **30 s** of the server's current media edge;
  - after the lock, a bet is accepted only if `mediaTs < lock_media_ts` **and** the wall clock is
    within **30 s** of the lock (the grace);
  - a missing `mediaTs` is treated as the wall clock now, so it is refused after the lock;
  - a trigger refuses `media_ts >= lock_media_ts`.

  The two 30 s bounds cap what a client that lies about its delay can gain: it can claim to be at
  most 30 s behind live, and only for 30 s after the lock. An honest far viewer (the
  `timeline-sync` scenario's sits about 9 s back) still bets on what they saw.

- **An audited result.** Resolve and cancel record `resolved_by` and write an `audit_log` row
  (prediction id, outcome, resolver id) in the same transaction. The public result card holds the
  pool, the winner count and `payoutSum`; the service asserts `payoutSum = pool` (or a full refund)
  before commit.

### 4. Surge raids (decision (w))

- **When.** When a raid executes, if the instance surge guard is on (`CHAT_SURGE_GUARD`) and the
  target has `surgeGuard.enabled` and `surgeGuard.onRaid` (new, default true), a surge opens with
  `trigger: "raid"` for `RAID_RULES.surgeMinutes` (10), through the guard's own state machine: an
  open surge is extended, never shortened; a moderator's `suppressed` override still wins; a target
  with the guard off, and a cancelled or refused raid, open nothing. Begin and end write
  `chat.surge.begin` / `chat.surge.end` with an `audit_log` row, as the guard does today.
- **Carry-over.** Raiders who were verified watchers of the source carry that standing to the
  target for the surge. For each user with a current source `KEYS.verifiedWatch` value for the
  source's live broadcast (the key's 600 s TTL is `RAID_RULES.carryMinutes`, 10, so its existence
  means "verified in the last 10 minutes"), the worker writes the target's
  `KEYS.verifiedWatch(target, user)` with `b` set to the target's live broadcast and `s` and `f`
  copied from the source value, with a TTL equal to the surge's remaining time, and never lowers
  an existing target value. Unverified raiders get nothing.
- **Chat is unchanged.** Chat already reads `KEYS.verifiedWatch` and applies the surge threshold;
  the carry is only a key write, so a friend's real raid chats at once and a botted raid stays quiet.
- **The mod banner** names the source channel and its verified count
  (`chat.surge.state.raid`: `fromChannel` and `verifiedCount`).

## Consequences

- Giveaway winners and jury seats can be checked by anyone; a streamer cannot pick a friend.
- Predictions can no longer be won by low latency or by the channel's own team; a viewer far
  behind live (over 30 s) cannot bet, which is the price of bounding a lying client.
- Raids into a protected channel are quiet for ten minutes except for the source's verified
  audience.
- **Writer interaction (to settle in the contract step).** The integrity writer
  (`verified-watch.ts`) sets `KEYS.verifiedWatch` unconditionally with `SET … EX 600`. Once a raider's
  target session becomes gate-eligible, its next pass would overwrite the carried value with the
  raider's (small) target seconds, and they would lose the carry until they reach the surge
  threshold on the target. The writer must keep the larger `s` for the same `b` (and the longer
  TTL) rather than overwrite; that file is outside W3-surge-raids' paths, so the change is a
  contract request.

## Alternatives considered

- **A server-only random draw.** Rejected: nobody can check it, which is the complaint about
  giveaway bots elsewhere.
- **A public randomness beacon (drand, a block hash).** Rejected: a third-party service on the
  draw path (AGENTS.md rule 3), and it does not remove the need to fix the entry list.
- **Modulo reduction without rejection.** Rejected: biased toward low indices whenever the range
  does not divide 2³².
- **Paid or points entry for giveaways.** Rejected (decision (a)): it turns a giveaway into a
  lottery.
- **A wall-clock lock with a latency allowance.** Rejected: it rewards whoever is closest to the
  origin.
- **Rejecting all raids during a surge.** Rejected: it punishes friendly raids; the carry keeps
  them.

## Decisions at acceptance

For the maintainer. Each item is the recommended default; accepting this ADR accepts them.

1. **Draw (s):** `packages/draw`, SHA-256 commit-reveal, HMAC-SHA256 with rejection sampling over a
   sorted list; commitment and reveal audited; one draw for giveaways and the jury.
2. **Giveaways (t):** off by default; free entry; eligibility by account age, follow age and
   verified watching only; one open per channel; up to 10 winners and 24 hours; salted pseudonyms
   revealed with the seed; in-app winner notice; no prize handling. Post-launch review of
   sweepstakes rules and the official-rules draft.
3. **Predictions (v):** verified bettors only; no owner, moderator or editor bets; media-time lock
   with the 30 s edge bound and 30 s grace; resolver audited; payouts proven to sum to the pool.
4. **Surge raids (w):** a raid opens a 10-minute surge when the target's guard and `onRaid` are on;
   verified watchers of the source carry their standing; chat unchanged.
5. **Trust in the operator:** the instance holds the seed until reveal; accepted as for the rest of
   the platform.
