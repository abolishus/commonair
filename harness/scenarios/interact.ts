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
 * W3 extensions (`--set w3=`, `src/w3/steps.ts`) run after the selected steps: `giveaway`
 * (`src/w3/giveaways.ts`), `surge-raid` (`src/w3/surge-raids.ts`) and `fair-prediction`
 * (`src/w3/predictions.ts`). Each sets up what it needs on the shared run.
 *
 * Needs `DATABASE_URL` (outbox checks, the role CLI) and the harness stack (harness/compose.e8.yaml;
 * the W3 extensions also harness/compose.w3.yaml, `stack --harness --w3`).
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
import { stepGiveaway } from "../src/w3/giveaways.ts";
import type { InteractW3Extension } from "../src/w3/kit.ts";
import { stepFairPrediction } from "../src/w3/predictions.ts";
import { type W3Extension, w3ExtensionTitle, w3Extensions } from "../src/w3/steps.ts";
import { stepSurgeRaid } from "../src/w3/surge-raids.ts";

const STEPS: Readonly<Record<InteractStep, (run: E8Run) => Promise<void>>> = {
  1: stepPoll,
  2: stepPrediction,
  3: stepRaid,
  4: stepGoal,
  5: stepInteractStudio,
  6: stepViewer,
};

const W3_STEPS: Readonly<Record<W3Extension<"interact">, (run: InteractW3Extension) => Promise<void>>> = {
  giveaway: stepGiveaway,
  "surge-raid": stepSurgeRaid,
  "fair-prediction": stepFairPrediction,
};

export default defineScenario({
  name: "interact",
  description:
    "Poll votes and end → prediction bets, lock, payouts and refunds → raid countdown, execute and follow, policy and cooldown refusals → goal overlay advances and ends → the same from /interact → a viewer votes, bets and follows the raid in the chat panel",
  needs: ["api", "web", "chat", "mail", "media", "origin", "worker", "ffmpeg", "browser"],
  inFull: true,
  timeoutMs: 20 * 60_000,
  async run(ctx) {
    const selected = parseInteractSteps(ctx.param("steps", "all"));
    const { steps, added } = withPrerequisites(selected, INTERACT_STEP_PREREQUISITES);
    const via = parseVia(ctx.param("via", "web"));
    ctx.data("steps", { selected, run: steps, addedPrerequisites: added });
    ctx.data("via", via);
    // `--set w3=` names a pending extension; by default only merged ones run (src/w3/steps.ts).
    const w3 = w3Extensions("interact", ctx.param("w3", ""));
    ctx.data("w3.extensions", w3);
    if (steps.length === 0 && w3.run.length === 0) {
      ctx.skipStep("interact", "every step is pending (no E8 unit merged yet); name one with --set steps=");
      return;
    }
    const run = await newE8Run(ctx, { via, prefix: "e8i" });
    for (const n of steps) await ctx.step(interactTitle(n, "run"), () => STEPS[n](run));
    for (const name of w3.run) await ctx.step(w3ExtensionTitle(name, "run"), () => W3_STEPS[name](run));
  },
});
