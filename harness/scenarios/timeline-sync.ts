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
 * W2 extension (`--set w2=`, `src/w2/steps.ts`): `replay-panel` (W2-vod-watch) after the steps; it
 * brings its own broadcast, VOD, clip and marker lines.
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
import { stepReplayPanel } from "../src/w2/replay.ts";
import { type W2Extension, w2ExtensionTitle, w2Extensions, withW2Steps } from "../src/w2/steps.ts";

const STEPS: Readonly<Record<TimelineStep, (run: W1Run) => Promise<void>>> = {
  1: stepLiveMediaTime,
  2: stepForcedLatencies,
  3: stepReplayExclusions,
  4: stepRetention,
};

const W2_STEPS: Readonly<Record<W2Extension<"timeline-sync">, (run: W1Run) => Promise<void>>> = {
  "replay-panel": stepReplayPanel,
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
    // `--set w2=` names a pending extension; by default only merged ones run (src/w2/steps.ts).
    const w2 = w2Extensions("timeline-sync", ctx.param("w2", ""));
    const forW2 = withW2Steps(selected, w2.run);
    const { steps, added } = withPrerequisites(forW2.steps, TIMELINE_STEP_PREREQUISITES);
    const via = parseVia(ctx.param("via", "web"));
    ctx.data("steps", { selected, run: steps, addedPrerequisites: [...forW2.added, ...added].sort((a, b) => a - b) });
    ctx.data("w2.extensions", w2);
    ctx.data("via", via);
    if (steps.length === 0 && w2.run.length === 0) {
      ctx.skipStep("timeline-sync", "every step is pending (no W1 unit merged yet); name one with --set steps=");
      return;
    }
    const run = await newW1Run(ctx, { via, prefix: "w1t" });
    for (const n of steps) await ctx.step(timelineTitle(n, "run"), () => STEPS[n](run));
    for (const name of w2.run) await ctx.step(w2ExtensionTitle(name, "run"), () => W2_STEPS[name](run));
  },
});
