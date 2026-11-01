// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * W3, watch rooms (docs/testing/b7-selectors.md, scenario `watch-room`; feature-wins §4.13):
 *
 * 1. Four Chromium members in one room; playhead delta under 500 ms after 30 s.
 * 2. A WebKit member joins; delta under 1 s.
 * 3. A mixed-age join is refused, through the API and by a direct insert.
 * 4. A minor cannot join a room on a mature channel.
 * 5. A channel-banned user cannot join.
 * 6. A blocked pair cannot share a room.
 * 7. A report captures the transcript in `reports.evidence` with `channel_id` null.
 * 8. The retention hook ages a room past 30 days and it is gone.
 *
 * `--set steps=1,3` picks steps (`all` runs every step not pending; step 2 adds step 1);
 * `--set via=api` drives the web setup through the API. Steps whose unit has not merged are
 * pending (`src/w3/steps.ts`) and run only when named. W3-watch-rooms fills this file and
 * `src/w3/watch-rooms/`.
 *
 * Runs in the `w3` shard, on the harness stack with the batch 7 overrides
 * (`bun scripts/infra.ts stack --harness --w3`).
 */
import { parseVia } from "../src/money.ts";
import { defineScenario } from "../src/scenario.ts";
import { WATCH_ROOM_STEP_RUNNERS, newWatchRoomRun } from "../src/w3/watch-rooms/index.ts";
import {
  WATCH_ROOM_STEP_PREREQUISITES,
  parseWatchRoomSteps,
  watchRoomTitle,
  withPrerequisites,
} from "../src/w3/steps.ts";

export default defineScenario({
  name: "watch-room",
  description:
    "four Chromium members in sync → a WebKit member in sync → mixed ages, a minor on a mature channel, a channel ban and a blocked pair refused → a report keeps the transcript → retention removes old rooms",
  needs: ["api", "web", "chat", "media", "origin", "worker", "ffmpeg", "browser"],
  inFull: true,
  timeoutMs: 20 * 60_000,
  async run(ctx) {
    const selected = parseWatchRoomSteps(ctx.param("steps", "all"));
    const { steps, added } = withPrerequisites(selected, WATCH_ROOM_STEP_PREREQUISITES);
    const via = parseVia(ctx.param("via", "web"));
    ctx.data("steps", { selected, run: steps, addedPrerequisites: added });
    ctx.data("via", via);
    if (steps.length === 0) {
      ctx.skipStep("watch-room", "every step is pending (W3-watch-rooms not merged yet); name one with --set steps=");
      return;
    }
    const run = await newWatchRoomRun(ctx, { via });
    for (const n of steps) await ctx.step(watchRoomTitle(n, "run"), () => WATCH_ROOM_STEP_RUNNERS[n](run));
  },
});
