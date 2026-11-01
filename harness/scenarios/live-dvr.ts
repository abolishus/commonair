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
 * `--set steps=1,3` picks steps (`all` runs every step not pending); `--set via=api` drives the
 * web setup through the API. Steps whose unit has not merged are pending (`src/w2/steps.ts`) and
 * run only when named. W2-dvr fills this file and `src/w2/dvr/`.
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
