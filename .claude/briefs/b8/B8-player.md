<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# B8-player: watch-room edge from players, and moving DVR off a departed relay

You are implementing unit B8-player for CommonAir (repo: /Users/joshe/Repos/bcon). Before you
start, read:

- AGENTS.md, PLAN.md and docs/architecture.md.
- `.claude/briefs/batch8/README.md`. The follow-ups table, the path ownership and the shared rules
  are binding.
- `.claude/briefs/b8/contract-step.md`: §3.2 (`RoomSyncReport.edgeWallclock`, the `room.sync`
  field, and the heartbeat's `dvrSwitchTo`) and §4.3 (`relay-dvr-switch`, `edge-sync`).
- ADR 0016 Amendment 1 (relay DVR, batch 7 decision (x)), ADR 0012 (media clock) and ADR 0017
  (watch rooms).
- `.claude/briefs/w3/W3-watch-rooms.md` and `W3-dvr-relay.md`, with their review notes:
  W3-watch-rooms review MEDIUM 1, and W3-dvr-relay request 8.
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 2**: work in your own git worktree, on branch
`b8/player`, cut from `main` after wave 1 merged. B8-harness runs beside you. It owns the scenario
files that run your steps, and it creates the `relay-dvr` scenario.

## Why

1. **Room sync guesses the live edge.** Chat is never told the live edge, so the sync tick
   estimates it from the most advanced member and remembers it between ticks
   (`services/chat/src/watch-rooms/sync.ts:13-19`). That is the contract request the W3 review
   left open. With `edgeWallclock` in each report, the target can use `max(edgeWallclock)` of live
   members, capped as today.
2. **A relay that leaves the active set strands DVR.** A relay-assigned session's DVR playlist is on
   the relay (`services/api/src/routes/playback.ts:260-264`). When the relay leaves, its DVR URL
   answers 403 until the next start. It fails safe, but the viewer loses DVR. The heartbeat already
   moves the live source (`switchTo`). `dvrSwitchTo` does the same for DVR, **towards the origin
   only**.

## You own (write only these)

- `apps/web/src/player/room-sync*` and `apps/web/src/player/dvr*` (`dvr.ts`, `dvr-controls.tsx`).
- The `switchTo`/`dvrSwitchTo` handling in `apps/web/src/player/heartbeat.ts`. Nothing else
  touches that file in wave 2.
- `services/chat/src/watch-rooms/**` and `services/chat/src/watch-rooms.ts`.
- The DVR lines of `services/api/src/routes/playback.ts` (the DVR section from `:179`, and the
  heartbeat answer's `dvrSwitchTo`).
- `harness/src/w3/{watch-rooms,dvr-relay}/**`, and `harness/src/b8/player.ts` (new) for your
  extension steps.
- Tests named after these files.

**Read-only:** `apps/web/src/player/{controller,player,source,lifecycle,media-clock}.ts*`,
`relay/**`, `services/origin/**`, `packages/contracts/**`, and `harness/scenarios/**` (B8-harness's).
Anything else is a **contract request**.

## Build

1. **`edgeWallclock` from players.**
   - `room-sync.ts` reports the player's live edge as a wall-clock instant in `live` mode, using the
     media clock the player already has (ADR 0012). In `dvr` mode it sends null.
   - Chat stores it in `RoomSyncReport`. The sync target becomes `max(edgeWallclock)` of the
     members reporting it in the last tick window, minus nothing.
   - Then, as today: the slowest live member's playhead, never more than `ROOM_LIMITS.edgeCapSeconds`
     behind that edge.
   - When no member reports an edge (an old client, or everyone in `dvr`), keep today's remembered
     estimate as the fallback, so mixed rooms still work.
   - Drop an edge that is ahead of the server's own wall clock by more than a small skew allowance:
     a lying client must not drag the room forward.
2. **`dvrSwitchTo` on the heartbeat.**
   - When a session's DVR grant is relay-assigned and the relay is no longer in the active set (the
     same check `switchTo` uses for live), the heartbeat answer carries `dvrSwitchTo`: an
     origin-served DVR playlist URL with a fresh origin DVR token (`dvrToken`).
   - The grant's source becomes origin for the rest of the session.
   - **Never** relay → relay, and never origin → relay. Moving DVR to a relay stays a start-time
     decision.
   - The player swaps its DVR source at the current DVR position, with no seek to live.
3. **DVR is never served by a CDN.** The origin URL is `PLAYBACK_PUBLIC_URL`'s DVR route. Assert that
   in a test (ADR 0016).

## Edge cases

- **A room with one member:** the target is that member's own edge-capped playhead, with no
  oscillation.
- **Members with different source latencies** (relay against origin): `max(edgeWallclock)` is
  right, because the players report wall-clock edges, not offsets.
- **A relay leaves and comes back** within one heartbeat: no switch if it is active again when the
  heartbeat is answered.
- **A `dvrSwitchTo` while the viewer is paused:** the swap waits for resume, or swaps silently and
  keeps the paused position. Pick one, document it, and test it.
- **A heartbeat rate floor** (`router.ts:880`, the ignored-beat answer): no switch on an ignored
  beat.

## Tests you must add

- **Chat unit** (`watch-rooms/sync.ts`, pure, exhaustive): an edge from reports, the fallback,
  mixed old and new clients, the skew drop, a single member, and the cap.
- **API integration:**
  - `dvrSwitchTo` appears once after the relay leaves the active set, and points at the origin;
  - never for an origin session;
  - never relay → relay;
  - none on an ignored beat;
  - the fresh DVR token is an origin token.
- **Web unit:** reporting the edge in `live`, null in `dvr`; the DVR swap keeps position.
- **Harness:**
  - `watch-room`: `edge-sync` (`harness/src/b8/player.ts`). Two members on different sources sync
    within today's targets (Chromium under 500 ms, WebKit under 1 s).
  - `relay-dvr`: `relay-dvr-switch`. In the scenario B8-harness splits out of `e2e-relay`, stop
    the relay mid-DVR session and check that the player keeps DVR from the origin with no 403.
  - Write the step functions in your files. B8-harness and the orchestrator wire them.

## Reviewer focus

- The room-sync targets are unchanged: Chromium under 500 ms, WebKit under 1 s.
- `dvrSwitchTo` never moves origin → relay or relay → relay.
- DVR is still never served by a CDN.
- A client cannot push the room past the live edge.

## Done means

Follow `.claude/briefs/_done-means.md`:

- `bun run test` and `test:int` in `services/chat` and `services/api`, one at a time;
- `bunx tsc -p` for each;
- `bun --bun vp test run` in `apps/web` and `harness`, and `vp build`;
- `vp lint --deny-warnings` and `vp fmt`;
- `reuse lint`.

`git status` shows only your paths. Commit with `git commit -s`.

Then tell the user to run these once B8-harness is merged:

```bash
bun harness/src/cli.ts run watch-room --set b8=edge-sync
```

```bash
bun harness/src/cli.ts run relay-dvr --set b8=relay-dvr-switch
```
