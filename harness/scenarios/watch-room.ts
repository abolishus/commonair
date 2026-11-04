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
 * `--set via=api` drives the create, join and report setup through the API (the sync steps still
 * play in browsers). Steps listed in `PENDING_WATCH_ROOM_STEPS` (`src/w3/steps.ts`) run only when
 * named. The steps live in `src/w3/watch-rooms/`; they need `DATABASE_URL` (the direct insert and
 * row checks) and the b7 test hooks (`OPS_TEST_HOOKS=true`) for retention.
 *
 * B8 extension (`--set b8=`, `src/b8/steps.ts`): `edge-sync` (B8-player, `src/b8/player.ts`) runs
 * after the steps.
 *
 * Runs in the `w3` shard, on the harness stack with the batch 7 overrides
 * (`bun scripts/infra.ts stack --harness --w3`).
 */
import type { WatchRoomB8Extension } from "../src/b8/kit.ts";
import { stepEdgeSync } from "../src/b8/player.ts";
import { type B8Extension, b8ExtensionTitle, b8Extensions, withB8Steps } from "../src/b8/steps.ts";
import { parseVia } from "../src/money.ts";
import { defineScenario } from "../src/scenario.ts";
import { WATCH_ROOM_STEP_RUNNERS, newWatchRoomRun } from "../src/w3/watch-rooms/index.ts";
import {
  WATCH_ROOM_STEP_PREREQUISITES,
  parseWatchRoomSteps,
  watchRoomTitle,
  withPrerequisites,
} from "../src/w3/steps.ts";

const B8_STEPS: Readonly<Record<B8Extension<"watch-room">, (run: WatchRoomB8Extension) => Promise<void>>> = {
  "edge-sync": stepEdgeSync,
};

export default defineScenario({
  name: "watch-room",
  description:
    "four Chromium members in sync → a WebKit member in sync → mixed ages, a minor on a mature channel, a channel ban and a blocked pair refused → a report keeps the transcript → retention removes old rooms",
  needs: ["api", "web", "chat", "media", "origin", "worker", "ffmpeg", "browser"],
  inFull: true,
  timeoutMs: 20 * 60_000,
  async run(ctx) {
    const selected = parseWatchRoomSteps(ctx.param("steps", "all"));
    // `--set b8=` names a pending extension; by default only merged ones run (src/b8/steps.ts).
    const b8 = b8Extensions("watch-room", ctx.param("b8", ""));
    const forB8 = withB8Steps(selected, b8.run);
    const prerequisites = withPrerequisites(forB8.steps, WATCH_ROOM_STEP_PREREQUISITES);
    const steps = prerequisites.steps;
    const added = [...new Set([...forB8.added, ...prerequisites.added])].sort((a, b) => a - b);
    const via = parseVia(ctx.param("via", "web"));
    ctx.data("steps", { selected, run: steps, addedPrerequisites: added });
    ctx.data("via", via);
    ctx.data("b8.extensions", b8);
    if (steps.length === 0 && b8.run.length === 0) {
      ctx.skipStep("watch-room", "every step is pending (W3-watch-rooms not merged yet); name one with --set steps=");
      return;
    }
    const run = await newWatchRoomRun(ctx, { via });
    for (const n of steps) await ctx.step(watchRoomTitle(n, "run"), () => WATCH_ROOM_STEP_RUNNERS[n](run));
    if (b8.run.length > 0 && steps.length > 0) {
      // The extensions measure sync on their own channel and members: the steps' are let go first.
      const released = await run.release();
      ctx.log.info("released the steps' browsers and encoders before the B8 extensions", { released });
    }
    for (const name of b8.run) await ctx.step(b8ExtensionTitle(name, "run"), () => B8_STEPS[name](run));
  },
});
