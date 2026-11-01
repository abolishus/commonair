<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W3-surge-raids: target-side surge protection for raids

You are implementing unit W3-surge-raids for CommonAir (repo: /Users/joshe/Repos/bcon). Read these
first:

- AGENTS.md, PLAN.md and docs/architecture.md.
- `.claude/briefs/batch7/README.md`. Decisions (w), (ac), path ownership and shared rules are
  binding.
- `.claude/briefs/w3/contract-step.md`:
  - §2.1 `RAID_RULES.surgeMinutes` / `carryMinutes` and the `raid` surge trigger
  - §2.2 `surgeGuard.onRaid`
  - §2.4 `chat.surge.state.raid`
- `docs/product/feature-wins.md` §4.4 (surge guard v1).
- ADR 0026 decision 4 (raids).
- ADR 0015 (verified watch).
- ADR 0039 (written by the contract step).
- `docs/testing/w1-selectors.md` (surge banner) and `docs/testing/b7-selectors.md`.
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. **Wave 1**: own git worktree, branch `w3/surge-raids` from
the contract step's sha.

## Why

A hate raid arrives as a raid. Today a raid lands with no guard, because raids
(`services/worker/src/interact/raids/execute.ts`) and the surge guard
(`services/worker/src/chat-gate/surge.ts`) are not connected. With this unit, a raid can open the
target's surge mode (watchers-only chat) for 10 minutes. Raiders who were really watching the
source carry that standing over, so a friend's real raid chats at once and a botted raid stays
quiet.

## You own (write only these)

- `services/worker/src/interact/raids/execute.ts`, `services/worker/src/chat-gate/{surge,raid}*.ts`
- `packages/interact/src/raids.ts`
- `apps/web/src/components/chat-gate/**` (banner, settings toggle),
  `apps/web/src/components/interact-studio/raid-panel.tsx`
- `apps/web/src/i18n/locales/{en,es}/w3-surge-raids.json`, `keys/w3-surge-raids.gen.ts`
- `harness/src/w3/surge-raids.ts`, `harness/tests/w3/surge-raids*`

**Read-only:**

- `services/worker/src/chat-gate/{hysteresis,state}.ts`
- `services/worker/src/integrity/verified-watch.ts`
- `services/chat/src/**` (no chat change: decision (w))
- `services/api/src/chat/surge.ts`, `services/api/src/interact/raids/**`
- `packages/integrity/src/channel.ts` (`raidIntegrity` `:151`)
- `packages/{contracts,db,config}/**`

Anything else is a **contract request**.

## Contracts you must honor

- **Surge events:** `chat.surge.begin {trigger: "raid"}` and `chat.surge.end`, written through
  the outbox with an `audit_log` row, as the guard does today.
- **Keys:** `KEYS.surgeOpen` (`internal.ts:263`), `KEYS.surgeOverride`, and `KEYS.verifiedWatch`
  (its shape is documented by the contract step).
- **Raid rules and policy:** `RAID_RULES.{countdownSeconds, cooldownSeconds, surgeMinutes, carryMinutes}`;
  `channels.raidPolicy`.
- **Settings and API:** `ChannelChatSettings.surgeGuard.{enabled, onRaid}`; `chat.surge.state.raid`.
- **Raid counts:** `raidViewerCount` (`packages/interact/src/raids.ts:112`) stays the verified
  count.

## Build

1. **At raid execute.** Execute is the `executeDueRaids` path in `execute.ts:104`. When the raid
   completes:
   - **If the target has `surgeGuard.enabled` and `onRaid`:** open a surge with
     `trigger: "raid"` for `surgeMinutes`, through the same state machine as the guard
     (`surge.ts`). This is the case whether or not a surge is already open; an open surge is
     extended, never shortened. Record `{fromChannel, verifiedCount}` for `chat.surge.state`.
   - **Carry-over.** For each raider who was a verified watcher of the source within
     `carryMinutes` (from the source's `verifiedWatch` state), write a TTL'd
     `KEYS.verifiedWatch` entry for the target that lasts the surge. Unverified raiders get
     nothing.
   - **Edge cases:**
     - a moderator override (`surgeOverride`) still wins;
     - a target with the guard off gets no surge;
     - a cancelled or refused raid opens nothing.
2. **The surge ends** by its cooldown, as today. A raid surge's end writes `chat.surge.end` with
   `reason: "expired"`.
3. **Web.**
   - **Mod banner** (`components/chat-gate/**`): "Raid from {channel}: {n} verified viewers.
     Chat is watchers-only until {time}", with the existing override control.
   - **Studio toggle:** "Protect raids". Under it, the note that raiders who watched the source
     can chat right away.
   - **`raid-panel.tsx`:** the outgoing raid panel tells the source streamer that the target may
     have raid protection on.
   - Strings go in `w3-surge-raids`, `en` and `es`.

## Tests you must add

- **Unit (pure, `packages/interact/src/raids.ts` and `chat-gate/raid*`):**
  - opening versus extending a surge
  - carry selection at the `carryMinutes` edges
  - override precedence
  - guard off
  - `onRaid` off
- **Worker integration** (real Valkey and Postgres):
  - A real raid from verified viewers lets those raiders chat at once on the target (a check
    against the chat gate's key reads) while a fresh unverified account cannot.
  - A botted raid opens the surge, carries nothing, and the bots cannot chat.
  - The surge ends after `surgeMinutes` with an audit row and an outbox event.
  - A suspended source or target opens nothing.
- **Web unit:** the banner content, and the toggle.
- **Harness `interact` extension step `surge-raid`**, reusing the `integrity-basic` bots as the
  `surge-guard` scenario does:
  1. The target turns the guard on, with protect raids on.
  2. A source with three verified viewers and a viewbot swarm raids the target.
  3. The surge opens with `trigger: "raid"`.
  4. The three verified raiders chat. The bots are rejected with the surge notice.
  5. A moderator override ends the surge.

## Done means

Follow `.claude/briefs/_done-means.md`:

- `bun run test` and `test:int` in `services/worker` and `packages/interact`
- `bunx tsc -p` in each
- `bun --bun vp test run` in `apps/web` and `harness`
- `vp build` in `apps/web`
- `vp lint --deny-warnings` and `vp fmt`
- the i18n check
- `reuse lint`

`git status` shows only your paths. Commit with `git commit -s`.

Then tell the user to run `bun harness/src/cli.ts run interact --set w3=surge-raid`, and to check
the banner and the toggle by hand under `en`, `es` and `en-XA`, at 320 px, in dark and light.
