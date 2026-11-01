// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * W2, free live DVR (docs/testing/w2-selectors.md, scenario `live-dvr`; ADR 0016):
 *
 * 1. DVR heartbeats verify but are not counted as live viewers (the catching-up count is).
 * 2. An in-progress segment is refused through `/media`.
 * 3. After a removal or a T0 hit, `/dvr/` answers 404 within 5 s.
 * 4. A relay request for a DVR path is refused.
 * 5. A `subscribers` VOD's DVR refuses a non-subscriber.
 * 6. A data-mode (`dm`) token is refused.
 * 7. VODs off ⇒ `dvrWindowSeconds` 0.
 *
 * `--set steps=1,3` picks steps (`all` runs every step not pending); `--set via=api` skips the
 * browser parts (step 1's scrubber and "back to live", step 7's `data-dvr-window="0"`). Steps 1,
 * 2, 4 and 6 share one live channel; 3, 5 and 7 each start their own (`src/w2/dvr/`). Step 1 takes
 * `--set dvrWatchSeconds=120 --set dvrVerifySeconds=300 --set dvrBehindSeconds=60`. Step 4 needs
 * no relay: it checks the origin's relay and CDN pull routes and, with `PLAYBACK_SIGNING_KEY` in
 * the repo `.env`, a relay-sourced DVR token (the relay's own path binding is covered by its Go
 * tests).
 */
import { parseVia } from "../src/money.ts";
import { defineScenario } from "../src/scenario.ts";
import { DVR_STEP_RUNNERS, newDvrRun } from "../src/w2/dvr/index.ts";
import { DVR_STEP_PREREQUISITES, dvrTitle, parseDvrSteps, withPrerequisites } from "../src/w2/steps.ts";

export default defineScenario({
  name: "live-dvr",
  description:
    "DVR viewers verify but are not live → in-progress segments refused → removal closes the window within 5 s → relays refuse DVR → subscribers-only and data-mode refusals → VODs off means no DVR",
  needs: ["api", "web", "media", "origin", "worker", "ffmpeg", "browser"],
  inFull: true,
  timeoutMs: 20 * 60_000,
  async run(ctx) {
    const selected = parseDvrSteps(ctx.param("steps", "all"));
    const { steps, added } = withPrerequisites(selected, DVR_STEP_PREREQUISITES);
    const via = parseVia(ctx.param("via", "web"));
    ctx.data("steps", { selected, run: steps, addedPrerequisites: added });
    ctx.data("via", via);
    if (steps.length === 0) {
      ctx.skipStep("live-dvr", "every step is pending (W2-dvr not merged yet); name one with --set steps=");
      return;
    }
    const run = await newDvrRun(ctx, { via });
    for (const n of steps) await ctx.step(dvrTitle(n, "run"), () => DVR_STEP_RUNNERS[n](run));
  },
});
