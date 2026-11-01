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
   - `liveWindow`, set while each recording is live, if seed-interact or seed-safety ask for it;
   - `vodId` and `clipId`: one ready public VOD and one clip of it (batch 6 §5), which the W2
     `SEED_ROUTES` rows (`harness/src/seed/routes.ts`, the VOD and clip watch pages) read.

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

## Batch 5–7 additions (checked at `fc1fc4ff`)

These tables and routes were added to your stub after this brief was first written. The three
`watch_room*` tables moved here from seed-social, because rooms open on a live broadcast.

1. **Chat inside recordings.** The VOD and clip watch pages have a chat replay panel, so harness
   chat clients must talk during each recording (`harness/src/chat-client.ts`). Seed-social's
   backdated chat doesn't cover these windows.
2. **Watch rooms** (protected).
   - During streamer1's recording, viewer1 opens a room, invites viewer2 and a bulk viewer, and
     they chat in it. Then the host closes it.
   - Don't age the rooms: the retention job would delete them.
3. **Captions** (ADR 0011).
   - One recording uses the speaking publisher (`harness/src/w2/captions/publisher.ts`, with its
     speech fixture) and the whisper sidecar, which gives `broadcast_caption_tracks`.
   - streamer1 then corrects a cue through the API (`caption_edits`).
4. **Rehearsal.**
   - streamer2 arms a rehearsal, invites `chanmod` (`rehearsal_invitees`), publishes briefly and
     ends it.
   - Never backdate rehearsals into `stream_hours`; the trigger refuses them.
   - `/rehearse` stays idle afterwards.
5. **Audience rollups and costs** (protected).
   - After each recording ends, run `broadcast-rollup` through the `OPS_TEST_HOOKS` analytics tick
     (settle override). This gives `broadcast_audience_minutes`, `broadcast_audience_totals` and
     `broadcast_costs` (a non-zero `INFRA_COST_MODEL`).
   - Set the display bypass for the fixed channels.
   - streamer1 creates an `analytics_share_links` row.
   - Note that `/analytics` only covers the recorded broadcasts, not the backdated history.
6. **One swarm recording.** Run one recording with a small viewbot swarm (`harness/src/integrity-viewers.ts`)
   beside real HTTP viewers. That fills the excluded groups on `/analytics` and the
   `integrity_flags` that seed-safety reads.
7. **Relay purge.** If a relay runs, streamer1 removes a recording mid-stream (`relay_purges`,
   signed by the API); `harness/src/w3/dvr-relay/` has the call shapes. If no relay runs, leave it
   pending with the relay tables.
8. **Store.** Also publish `store.extra.media.recordedBroadcasts` (`{ channelId, broadcastId }[]`),
   for seed-safety's attestations.
9. **Budget.** Your small budget is 8 minutes now. Run recordings 3 at a time and fold the
   features above into the same recordings wherever they fit.

## Tests you must add

These come on top of the tests in common.md.

- Backdated broadcasts don't overlap per channel, and every chat window has a covering broadcast.
- Health samples cover every state.
- Planned recording concurrency is at most 3.
- `live.ts`:
  - its plan picks channels and viewers deterministically;
  - it refuses without a seed or without the flag;
  - abort stops every child process. Test this with a fake process runner.
- The test checks:
  - every recording window has planned chat;
  - the caption, rehearsal, swarm and watch-room plans fit inside the recording plan;
  - `recordedBroadcasts` covers every recording.

## Routes you fill

- `/content`, `/relays` and `/admin/egress`.
- The health part of `/dashboard`.
- VODs and clips on `/$channel`.
- `/embed/$channel` (a VOD, or live during `seed live`).
- Every live surface while `seed live` runs.
- `/$channel/vods/$vodId` and `/$channel/clips/$clipId` (`vodId`, `clipId`), with chat replay
- `/captions` and `/analytics`
- `/rehearse`: checked for errors only

## Done means

See "Done means" in common.md. Also report:

- the wall-clock time at `small`;
- the ffmpeg and Garage flags needed;
- the exact `seed live` command.
