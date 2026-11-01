// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * W2, open live captions (docs/testing/w2-selectors.md, scenario `captions`; ADR 0011):
 *
 * 1. Subtitles advertised: the master playlist carries a SUBTITLES group once captions start.
 * 2. Word error rate below 0.25 against the fixture's reference transcript.
 * 3. Cue timing: every cue is available before the playhead's PDT reaches it at 8–10 s latency
 *    (subtitle playlist first-seen times, and a Chromium viewer's `video.textTracks`).
 * 4. VOD captions present after the broadcast ends.
 * 5. A second stream is queued at `CAPTIONS_MAX_STREAMS` and starts when the first ends.
 * 6. A channel that keeps no VODs keeps no transcript.
 * 7. A rehearsal gets no caption track.
 * 8. A mask word is masked in the cues.
 *
 * `--set steps=1,3` picks steps (`all` runs every step not pending); `--set via=api` drives the
 * web setup through the API. Steps whose unit has not merged are pending (`src/w2/steps.ts`) and
 * run only when named. W2-captions fills this file and `src/w2/captions/`.
 *
 * Runs in its own CI shard (`captions`, batch 6 decision (c)): on pushes that reach captions,
 * media or origin code, and nightly. Needs the whisper sidecar and the captions weights
 * (`bun scripts/fetch-model.ts`, W2-captions).
 */
import { parseVia } from "../src/money.ts";
import { defineScenario } from "../src/scenario.ts";
import { CAPTIONS_STEP_RUNNERS, newCaptionsRun } from "../src/w2/captions/index.ts";
import { CAPTIONS_STEP_PREREQUISITES, captionsTitle, parseCaptionsSteps, withPrerequisites } from "../src/w2/steps.ts";

export default defineScenario({
  name: "captions",
  description:
    "subtitles advertised → WER below 0.25 → cues ahead of the playhead → VOD captions → queued at the cap → no transcript without VODs → none for a rehearsal → mask words masked",
  needs: ["api", "web", "media", "origin", "worker", "ffmpeg", "browser"],
  inFull: true,
  timeoutMs: 20 * 60_000,
  async run(ctx) {
    const selected = parseCaptionsSteps(ctx.param("steps", "all"));
    const { steps, added } = withPrerequisites(selected, CAPTIONS_STEP_PREREQUISITES);
    const via = parseVia(ctx.param("via", "web"));
    ctx.data("steps", { selected, run: steps, addedPrerequisites: added });
    ctx.data("via", via);
    if (steps.length === 0) {
      ctx.skipStep("captions", "every step is pending (W2-captions not merged yet); name one with --set steps=");
      return;
    }
    const run = await newCaptionsRun(ctx, { via });
    for (const n of steps) await ctx.step(captionsTitle(n, "run"), () => CAPTIONS_STEP_RUNNERS[n](run));
  },
});
