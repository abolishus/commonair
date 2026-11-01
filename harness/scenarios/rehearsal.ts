// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * W2, rehearsal mode (docs/testing/w2-selectors.md, scenario `rehearsal`; feature-wins §4.11,
 * batch 6 decisions (f), (g)):
 *
 * 1. Arm a rehearsal and publish with the normal stream key.
 * 2. Invisible downstream: no directory entry, no `stream.online` (outbox, EventSub delivery,
 *    go-live inbox, Discord).
 * 3. Nothing counts: no `stream_hours` or ledger row, no goal progress; direct inserts refused.
 * 4. Simulated chat and a spam burst are filtered or held and appear in the report.
 * 5. An invitee plays; a signed-out viewer, a non-invitee and the embed are refused.
 * 6. The rehearsal VOD is not public and expires at 24 h.
 * 7. Audit rows for the arm and the invitee.
 *
 * `--set steps=1,3` picks steps (`all` runs every step not pending; steps 2–7 add step 1);
 * `--set via=api` drives the web setup through the API. Steps whose unit has not merged are
 * pending (`src/w2/steps.ts`) and run only when named. W2-rehearsal fills this file and
 * `src/w2/rehearsal/`.
 *
 * W3 extension (`--set w3=`, `src/w3/steps.ts`): `moderation-samples` (B7-followups,
 * `src/w2/rehearsal/index.ts`: the report counts moderation samples) after the steps; it adds step 1.
 */
import { parseVia } from "../src/money.ts";
import { defineScenario } from "../src/scenario.ts";
import { REHEARSAL_STEP_RUNNERS, newRehearsalRun, stepModerationSamples } from "../src/w2/rehearsal/index.ts";
import {
  REHEARSAL_STEP_PREREQUISITES,
  parseRehearsalSteps,
  rehearsalTitle,
  withPrerequisites,
} from "../src/w2/steps.ts";
import type { RehearsalW3Extension } from "../src/w3/kit.ts";
import { type W3Extension, w3ExtensionTitle, w3Extensions, withW3Steps } from "../src/w3/steps.ts";

const W3_STEPS: Readonly<Record<W3Extension<"rehearsal">, (run: RehearsalW3Extension) => Promise<void>>> = {
  "moderation-samples": stepModerationSamples,
};

export default defineScenario({
  name: "rehearsal",
  description:
    "arm and publish on the normal key → nothing downstream sees it → nothing counts → simulated chat filtered and reported → invitees only → private VOD expiring in 24 h → audit rows",
  needs: ["api", "web", "chat", "mail", "media", "origin", "worker", "ffmpeg", "browser"],
  inFull: true,
  timeoutMs: 20 * 60_000,
  async run(ctx) {
    const selected = parseRehearsalSteps(ctx.param("steps", "all"));
    // `--set w3=` names a pending extension; by default only merged ones run (src/w3/steps.ts).
    const w3 = w3Extensions("rehearsal", ctx.param("w3", ""));
    const forW3 = withW3Steps(selected, w3.run);
    const prerequisites = withPrerequisites(forW3.steps, REHEARSAL_STEP_PREREQUISITES);
    const steps = prerequisites.steps;
    const added = [...new Set([...forW3.added, ...prerequisites.added])].sort((a, b) => a - b);
    const via = parseVia(ctx.param("via", "web"));
    ctx.data("steps", { selected, run: steps, addedPrerequisites: added });
    ctx.data("w3.extensions", w3);
    ctx.data("via", via);
    if (steps.length === 0) {
      ctx.skipStep("rehearsal", "every step is pending (W2-rehearsal not merged yet); name one with --set steps=");
      return;
    }
    const run = await newRehearsalRun(ctx, { via });
    for (const n of steps) await ctx.step(rehearsalTitle(n, "run"), () => REHEARSAL_STEP_RUNNERS[n](run));
    for (const name of w3.run) await ctx.step(w3ExtensionTitle(name, "run"), () => W3_STEPS[name](run));
  },
});
