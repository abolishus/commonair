// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * W1, one media timeline for chat (docs/testing/w1-selectors.md, scenario `timeline-sync`; ADR
 * 0012 amendment 1):
 *
 * 1. Live media time (W1-spine): `mediaTs` clamping, DVR, IRC median, offline.
 * 2. Browser viewers at forced latencies (W1-player): markers replay in media-time order.
 * 3. Replay exclusions (W1-spine): deleted, held, cleared, banned and blocked lines; private VOD;
 *    `clips.chat`.
 * 4. Retention (W1-spine): the `chat-retention` ops tick on backdated rows.
 *
 * `--set steps=1,3` picks steps (`all` runs every step not pending); `--set via=api` drives the
 * web steps' setup through the API. Steps whose unit has not merged are pending
 * (`src/w1/steps.ts`) and run only when named. Owned by the orchestrator: units fill their step
 * modules in `src/w1/`.
 *
 * Needs `DATABASE_URL` (outbox and backdating), the ops hook (harness/compose.e6.yaml) and the
 * harness stack (harness/compose.w1.yaml).
 */
import { parseVia } from "../src/money.ts";
import { defineScenario } from "../src/scenario.ts";
import { type W1Run, newW1Run } from "../src/w1/kit.ts";
import {
  type TimelineStep,
  TIMELINE_STEP_PREREQUISITES,
  parseTimelineSteps,
  timelineTitle,
  withPrerequisites,
} from "../src/w1/steps.ts";
import { stepLiveMediaTime, stepReplayExclusions, stepRetention } from "../src/w1/timeline.ts";
import { stepForcedLatencies } from "../src/w1/timeline-web.ts";

const STEPS: Readonly<Record<TimelineStep, (run: W1Run) => Promise<void>>> = {
  1: stepLiveMediaTime,
  2: stepForcedLatencies,
  3: stepReplayExclusions,
  4: stepRetention,
};

export default defineScenario({
  name: "timeline-sync",
  description:
    "chat mediaTs clamped on the live media clock → browser viewers at forced latencies replay in media-time order → replay leaves out deleted, held, cleared, banned and blocked lines → chat retention on backdated rows",
  needs: ["api", "web", "chat", "irc", "mail", "media", "origin", "worker", "ffmpeg", "browser"],
  inFull: true,
  timeoutMs: 20 * 60_000,
  async run(ctx) {
    const selected = parseTimelineSteps(ctx.param("steps", "all"));
    const { steps, added } = withPrerequisites(selected, TIMELINE_STEP_PREREQUISITES);
    const via = parseVia(ctx.param("via", "web"));
    ctx.data("steps", { selected, run: steps, addedPrerequisites: added });
    ctx.data("via", via);
    if (steps.length === 0) {
      ctx.skipStep("timeline-sync", "every step is pending (no W1 unit merged yet); name one with --set steps=");
      return;
    }
    const run = await newW1Run(ctx, { via, prefix: "w1t" });
    for (const n of steps) await ctx.step(timelineTitle(n, "run"), () => STEPS[n](run));
  },
});
