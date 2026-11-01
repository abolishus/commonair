<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W3-watch-rooms: watch rooms (synced players, side chat, strict age bands, 30-day retention)

You are implementing unit W3-watch-rooms for CommonAir (repo: /Users/joshe/Repos/bcon). Read
these first:

- AGENTS.md, PLAN.md and docs/architecture.md.
- `.claude/briefs/batch7/README.md`. Decisions (q), (r), (ac), (ad), the path ownership and the
  shared rules are binding.
- `.claude/briefs/w3/contract-step.md`:
  - §2.1 `ROOM_*`;
  - §2.4 `watchRooms.*`;
  - §2.5 room frames;
  - §3.1 room tables;
  - §3.2 the age-band trigger;
  - §5.1 the evidence, deletion and export stubs;
  - §5.4 chat dispatch.
- `docs/product/feature-wins.md` §4.13.
- `docs/decisions/0017-watch-rooms.md`: decisions 1–4 are your spec.
- ADR 0012 part 2 (the media clock).
- `docs/testing/w1-selectors.md` "Player seam" and `docs/testing/b7-selectors.md`.
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 1**: work in your own git worktree on branch
`w3/rooms`, cut from the contract step's sha (run `git merge main` first if main moved). Paths
were checked at `b37203c4`; recheck line numbers against your base.

## Why

Twitch has no friends-sync on a live channel. Up to 8 friends should be able to watch one live
channel locked together, with a side chat. This is the riskiest feature on the list, so the
safety rules come first: strict age bands, block and ban checks, platform-only reports, and a
transcript kept 30 days so late reports have evidence.

## You own (write only these)

- `services/chat/src/watch-rooms.ts` (fill the stub) and `services/chat/src/watch-rooms/**`
- `services/api/src/watch-rooms/**` (including `evidence.ts`), `services/api/src/routes/watch-rooms.ts`
- `services/worker/src/watch-rooms/**`, `services/worker/src/jobs/watch-room-retention.ts`,
  `services/worker/src/deletion/watch-rooms.ts`, `services/worker/src/exports/watch-rooms.ts`
- `apps/web/src/components/watch-room/**` (the drawer behind the `WatchRoomDrawer` slot),
  `apps/web/src/player/room-sync*`, `apps/web/src/components/safety/watch-room-evidence*`
- `apps/web/src/i18n/locales/{en,es}/w3-watch-rooms.json`, `keys/w3-watch-rooms.gen.ts`
- `harness/scenarios/watch-room.ts` (fill the stub), `harness/src/w3/watch-rooms/**`, `harness/tests/w3/watch-rooms*`
- The tests named after your files

**Read-only:**

- `services/chat/src/{server,core,socket,rooms,pipeline}.ts`
- `services/api/src/routes/{safety,me-blocks}.ts`, `services/api/src/auth/identity.ts` (`isAdult`, `ageOn`)
- `apps/web/src/player/controller.ts` (frozen), `apps/web/src/chat/**`
- `packages/{contracts,db,config}/**`

Anything else is a **contract request**.

## Contracts you must honor

- **Shapes and limits:** `watchRooms.{create,get,invite,join,leave,close,mine}`; the `room.*`
  client and server frames; `NOTICE_CODES` `room_*`; `ROOM_AGE_BANDS`; `ROOM_LIMITS`
  (8 members, 10 min empty end, 30 days retention, 5 s edge cap).
- **Tables:** `watch_rooms`, `watch_room_members`, `watch_room_messages`, and the age-band
  trigger (which also enforces mature confirmation and the 8-member cap).
- **Reports:** the `watch_room` report subject, with `reports.channel_id` null.
- **Keys and jobs:** `KEYS.roomPresence` / `roomSync`; `WATCH_ROOM_JOBS.retention`; bus control
  ops `room.close` / `room.kick`.
- **Player seam:** `setTargetLatency` (`controller.ts:334`, range 1–60 s), `seekToWallclock`
  (`:305`), `playheadWallclock` (`:286`), `playbackMode` (`:372`).
- **Blocks:** `user_blocks` (`schema/chat.ts:89-105`).
- **Bans:** `chat_bans` (`schema/chat.ts:40-62`), `users.banned`, suspension (`lib/access.ts:82-84`).

## Build

1. **API (`services/api/src/watch-rooms/**`).**
   - **Create.** The host must be signed in, have a valid birth date and not be banned or
     suspended. The room's band comes from the host's age on the day. A broadcast that is
     mature-labelled (channel, broadcast or category) makes the room `adult` only, and the host
     must have confirmed mature viewing; a minor gets a clear refusal. The broadcast must be live
     and `kind = 'live'`. Create returns an invite nonce (stored as its hash).
   - **Join.** Join takes the nonce. The API checks the band, mature confirmation, the platform
     ban and suspension, an active `chat_bans` row on the host channel, **blocks in either
     direction with any current member**, and room capacity. Each refusal returns a distinct
     i18n code. The trigger is the backstop: map its refusal to the same codes, never a 500.
   - **Leave, close and mine.** A host leaving ends the room. Rooms the user hosts or belongs
     to are listed in `mine`. Every refusal is logged without PII.
   - **Watch the room's state.** Use the bus or outbox, not polling:
     - the broadcast ends → end the room;
     - the broadcast becomes mature → end its `minor` rooms;
     - a member is banned on the channel or platform during the room → kick them through the
       `room.kick` control op.
2. **Chat (`services/chat/src/watch-rooms.ts`).**
   - Room membership is presence in Valkey (`KEYS.roomPresence`). Re-check the band at every
     (re)connect: a member whose band changed is removed.
   - `room.send` runs the host channel's word filter and the platform filter (the pipeline, read
     only). Persist to `watch_room_messages` and fan out to members only.
   - A room never touches `rooms.ts` channel fan-out.
   - Rate limits come from `CHAT_LIMITS.room`.
   - `room.sync` collects members' wall-clock playheads. Every 2 s it sends `room.sync {target}`
     = the slowest member's playhead, capped at `ROOM_LIMITS.edgeCapSeconds` behind the edge.
   - DVR-mode members are not part of the target (they rejoin live first).
3. **Player sync (`apps/web/src/player/room-sync*`).**
   - hls.js: steer with `setTargetLatency` toward the target. Seek only when the drift is over
     2 s.
   - WebKit native (`prefersNativeHls`): seek-only correction with about 1 s tolerance.
   - Unit-test the drift controller (pure function): convergence, overshoot, the cap, a member
     joining or leaving, and reduced motion.
4. **Web drawer (`components/watch-room/**`).**
   - Controls: create, the copy-invite link, a join landing that comes from the invite (a query
     on the channel page; ask for a contract request if you need a route), the member list with
     `<ChannelAvatar>`, and the side chat reusing the chat-panel blocks.
   - Leave and close use `<ConfirmDialog>`. Room messages offer a report action.
   - Show the age-band and "mature content: adults only" notices.
   - Keyboard navigable and reduced-motion safe. Strings go in `w3-watch-rooms`, `en` and `es`.
5. **Reports (`evidence.ts`).** At report time, copy the room's messages (author ids, body, time)
   and the member list (ids, joined and left times) into `reports.evidence`. The report goes to the
   platform queue only. `watch-room-evidence.tsx` renders it in the mod queue: authors by
   username via the existing user lookup, never stored in the report.
6. **Retention, deletion and export.**
   - **Retention:** the daily `watch-room-retention` job deletes rooms (members and messages
     cascade) ended more than 30 days ago, and ends rooms that have been empty for 10 minutes.
   - **Deletion:** `deleteRoomData` removes the user's messages and memberships and ends rooms
     they host, in the deletion transaction.
   - **Export:** `exports/watch-rooms.ts` exports the user's own rooms and messages that still
     exist.
   - Never write room content to `audit_log` or any append-only column (ADR 0017 decision 4).
     Audit rows for moderation of a room carry ids only.

## Tests you must add

- **API integration** (real Postgres and Valkey):
  - the refusal matrix: a minor host or joiner across bands; null birth date; mature content
    with a minor; an adult without mature confirmation; a channel ban; a platform ban; a
    suspension; a block in either direction; a full room; an ended broadcast; a rehearsal
    broadcast;
  - a band change between joins;
  - a mid-room ban kicks the member; a broadcast turning mature ends minor rooms.
- **Trigger integration:** a direct insert of a mixed-age member, an unknown age, or a 9th member
  is refused.
- **Chat integration:** messages reach only members; they are filtered; they are persisted; the
  sync target is computed and capped.
- **Retention and deletion integration:** a room ended 31 days ago is deleted; one ended 29 days
  ago is kept; deletion removes the user's room data; a report's evidence survives retention.
- **Web unit:** drift controller; drawer (create, join refusal messages, keyboard, the
  report action).
- **Harness `watch-room`** (fill the pending steps):
  1. Four Chromium viewers in a room; playhead delta under 500 ms after 30 s.
  2. One WebKit member; delta under 1 s.
  3. A mixed-age join is refused through the API, and by a direct insert.
  4. A minor cannot join a room on a mature channel.
  5. A channel-banned user cannot join.
  6. A blocked pair cannot share a room.
  7. A report captures the transcript in `reports.evidence` with `channel_id` null.
  8. The retention hook ages a room past 30 days and it is gone.

## Done means

Follow `.claude/briefs/_done-means.md`:

- `bun run test` and `test:int` in `services/chat`, `services/api` and `services/worker` (one
  `test:int` at a time); `bunx tsc -p` each.
- `bun --bun vp test run` in `apps/web` and `harness`; `vp build` in `apps/web`.
- `vp lint --deny-warnings` and `vp fmt` on your paths; the i18n check and
  `tests/i18n.test.ts`; `reuse lint`.
- `git status` shows only your paths. Commit with `git commit -s`.

Then tell the user to run `bun scripts/infra.ts stack --harness` and
`bun harness/src/cli.ts run watch-room`, then check by hand:

- open a room with a second browser and watch both players converge;
- try a minor account and a blocked account;
- report a message;
- all of it under `en`, `es` and `en-XA`, at 320 px, dark and light, keyboard only.
