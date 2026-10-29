// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Milestone E8, interactivity (docs/testing/e8-selectors.md, scenario `interact`; ADR 0026):
 *
 * 1. Poll (E8-polls): a 20 s poll, three viewers vote, `interact-tick` ends it; votes and outbox.
 * 2. Prediction (E8-polls): bets, lock, resolve with `largestRemainder` payouts; a resolve nobody
 *    bet on refunds.
 * 3. Raid (E8-raids-goals): countdown, `raids-execute`, the `raid` frame and `channel.raid`; the
 *    target's policy and the cooldown refuse.
 * 4. Goal overlay (E8-raids-goals): a followers goal advances on the overlay stream and ends.
 * 5. Studio (E8-studio): steps 1 and 3 and a goal driven from `/interact`.
 * 6. Viewer (E8-viewer): vote, bet, the points chip, the raid banner and follow, the goal overlay.
 *
 * `--set steps=1,3` picks steps (`all` runs every step not pending); `--set via=api` drives the
 * web steps' setup through the API. Steps whose unit has not merged are pending (`src/e8/steps.ts`)
 * and run only when named. Owned by the orchestrator: units fill their step modules in `src/e8/`.
 *
 * Needs `DATABASE_URL` (outbox checks, the role CLI) and the harness stack (harness/compose.e8.yaml).
 */
import { parseVia } from "../src/money.ts";
import {
  type InteractStep,
  INTERACT_STEP_PREREQUISITES,
  interactTitle,
  parseInteractSteps,
  withPrerequisites,
} from "../src/e8/steps.ts";
import { type E8Run, newE8Run } from "../src/e8/kit.ts";
import { stepGoal } from "../src/e8/goals.ts";
import { stepPoll } from "../src/e8/polls.ts";
import { stepPrediction } from "../src/e8/predictions.ts";
import { stepRaid } from "../src/e8/raids.ts";
import { stepInteractStudio } from "../src/e8/studio.ts";
import { stepViewer } from "../src/e8/viewer.ts";
import { defineScenario } from "../src/scenario.ts";

const STEPS: Readonly<Record<InteractStep, (run: E8Run) => Promise<void>>> = {
  1: stepPoll,
  2: stepPrediction,
  3: stepRaid,
  4: stepGoal,
  5: stepInteractStudio,
  6: stepViewer,
};

export default defineScenario({
  name: "interact",
  description:
    "Poll votes and end → prediction bets, lock, payouts and refunds → raid countdown, execute and follow, policy and cooldown refusals → goal overlay advances and ends → the same from /interact → a viewer votes, bets and follows the raid in the chat panel",
  needs: ["api", "web", "chat", "mail", "media", "origin", "worker", "ffmpeg", "browser"],
  // The milestone's end adds it to FULL_REQUIRED and the `interact` shard (contract step §9).
  inFull: false,
  timeoutMs: 20 * 60_000,
  async run(ctx) {
    const selected = parseInteractSteps(ctx.param("steps", "all"));
    const { steps, added } = withPrerequisites(selected, INTERACT_STEP_PREREQUISITES);
    const via = parseVia(ctx.param("via", "web"));
    ctx.data("steps", { selected, run: steps, addedPrerequisites: added });
    ctx.data("via", via);
    if (steps.length === 0) {
      ctx.skipStep("interact", "every step is pending (no E8 unit merged yet); name one with --set steps=");
      return;
    }
    const run = await newE8Run(ctx, { via, prefix: "e8i" });
    for (const n of steps) await ctx.step(interactTitle(n, "run"), () => STEPS[n](run));
  },
});
