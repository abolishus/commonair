<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# seed-media: broadcasts, VODs, clips, health, egress, simulcast, relays and `seed live`

You are implementing unit seed-media for CommonAir (repo: /Users/joshe/Repos/bcon).

Read these first:

- AGENTS.md, PLAN.md and docs/architecture.md.
- `.claude/briefs/seed-full/README.md`.
- `.claude/briefs/seed-full/common.md`: the shared rules, the read-only contract and the tests every
  unit adds. All of it applies here.

Do not look outside the repository.

- Branch: `seed/media`, from `main` after seed-social merges.
- Wave 1. seed-safety depends on your clips and VODs, so publish them early.

## You own (write only these)

- `harness/src/seed/media.ts` and `harness/src/seed/media/**`.
- `harness/src/seed/live.ts` (new), plus the body of `runSeedLive` in `harness/src/seed/run.ts`.
  That one function is all you may touch in run.ts; its signature and `SeedLiveOptions` stay as
  they are.
- `harness/tests/seed/media*.test.ts` and `harness/tests/seed/live*.test.ts`.

## Contracts you must honor (read-only for you)

- `harness/src/streamer.ts` (`Streamer`, `rtmpPublishUrl`, `whipPublishTarget`).
- `harness/src/ffmpeg.ts` and `harness/src/hls.ts`.
- `harness/src/http-viewer.ts`, `harness/src/chat-client.ts` and `harness/src/relay.ts`.
- `harness/src/safety-io.ts` (`mediaBucketConfig`, `mediaKeyExists`).
- `@commonair/tokens`.
- The media, clips, simulcast and relay procedures in `@commonair/contracts`.
- `store.extra.social.chatWindows`. Align backdated broadcasts to those windows.

## Build

1. **Broadcast history.** Backdate `broadcasts` and `stream_hours` for every streamer across
   `historyDays`, using social's chat windows.
   - Add `broadcast_health_samples` for a sample of them; streamer1 gets every health state.
   - Add `egress_samples` so that `/admin/egress` has a chart.
   - All four tables are plain, so write them directly.
2. **Real recordings (protected `vods` and `clips`).** For streamer1, streamer2, council1 and a few
   bulk streamers:
   - Publish a short test-pattern stream with `Streamer`. Keep it about 20–40 s, and run at most
     3 at once.
   - Watch it with `http-viewer`, so that `playback_sessions` exist.
   - Stop it, and wait until the VOD is recorded in Garage.
   - Create clips through the API.
   - Mark one VOD private and delete one clip, if the API allows it.

   streamer3 gets exactly one recorded broadcast; its purpose is its first broadcast. Publish
   `store.extra.media` with:
   - `vodsByChannel` and `clipsByChannel` (id lists);
   - `recordedWindow` (`{ channelId, start, end }[]`);
   - `liveWindow`, set while each recording is live, if seed-interact or seed-safety ask for it.

3. **Simulcast.** Give streamer1 `simulcast_targets` that point at a local RTMP sink only, never
   a real platform. Add one `simulcast_sessions` row from a recording run, if the sink can be
   started locally. If not, insert the target only and note it.
4. **Relays.** Use a real relay where possible: one relay node through the relay registration
   path that `harness/src/relay.ts` drives, with issuance and receipts from a recording it served.
   If no relay can run in the stack, leave these tables pending with a contract request. Don't
   forge signed rows.
5. **`seed live --channels K`** (`live.ts`):
   - Keep K seeded channels live: the fixed streamers first, then bulk streamers.
   - Run harness chat clients as seeded bulk viewers. They talk at a rate that is realistic but
     bounded, and their content comes from the PRNG.
   - Sign them in with `DEMO_SEED_PASSWORD`.
   - Run until SIGINT or `--duration`.
   - Refuse unless the database already holds a full seed (fixed logins present), and refuse
     unless `DEMO_SEED_FULL=true`.
   - Restart a publisher that dies.
   - Print the watch URLs.
   - Exit codes: 0 clean, 1 failure, 2 refused.

## Tests you must add

These come on top of the tests in common.md.

- Backdated broadcasts don't overlap per channel, and every chat window has a covering broadcast.
- Health samples cover every state.
- Planned recording concurrency is at most 3.
- `live.ts`:
  - its plan picks channels and viewers deterministically;
  - it refuses without a seed or without the flag;
  - abort stops every child process. Test this with a fake process runner.

## Routes you fill

- `/content`, `/relays` and `/admin/egress`.
- The health part of `/dashboard`.
- VODs and clips on `/$channel`.
- `/embed/$channel` (a VOD, or live during `seed live`).
- Every live surface while `seed live` runs.

## Done means

See "Done means" in common.md. Also report:

- the wall-clock time at `small`;
- the ffmpeg and Garage flags needed;
- the exact `seed live` command.
