// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * W3, audience portability (docs/testing/b7-selectors.md, scenario `portability`; ADR 0037):
 *
 * 1. A move link converts: a follow with `source = move_link`, and the follower count rises.
 * 2. A grant, then a move: Mailpit receives exactly one moved notice and the channel page shows it.
 * 3. A bundle round-trips into a second channel.
 * 4. A T0 fixture emote in the bundle is refused.
 * 5. A suspended channel's bundle is refused at import.
 *
 * `--set steps=1,3` picks steps (`all` runs every step not pending; step 2 adds 1, step 4 adds 3);
 * `--set via=api` drives the web setup through the API. Steps whose unit has not merged are
 * pending (`src/w3/steps.ts`) and run only when named. W3-portability fills this file and
 * `src/w3/portability/`.
 *
 * Runs in the `w3` shard, on the harness stack with the batch 7 overrides
 * (`bun scripts/infra.ts stack --harness --w3`).
 */
import { parseVia } from "../src/money.ts";
import { defineScenario } from "../src/scenario.ts";
import { PORTABILITY_STEP_RUNNERS, newPortabilityRun } from "../src/w3/portability/index.ts";
import {
  PORTABILITY_STEP_PREREQUISITES,
  parsePortabilitySteps,
  portabilityTitle,
  withPrerequisites,
} from "../src/w3/steps.ts";

export default defineScenario({
  name: "portability",
  description:
    "a move link converts a follow → a grant and a move send one notice → a bundle round-trips into another channel → a T0 emote and a suspended channel's bundle are refused",
  needs: ["api", "web", "mail", "worker", "browser"],
  inFull: true,
  timeoutMs: 20 * 60_000,
  async run(ctx) {
    const selected = parsePortabilitySteps(ctx.param("steps", "all"));
    const { steps, added } = withPrerequisites(selected, PORTABILITY_STEP_PREREQUISITES);
    const via = parseVia(ctx.param("via", "web"));
    ctx.data("steps", { selected, run: steps, addedPrerequisites: added });
    ctx.data("via", via);
    if (steps.length === 0) {
      ctx.skipStep("portability", "every step is pending (W3-portability not merged yet); name one with --set steps=");
      return;
    }
    const run = await newPortabilityRun(ctx, { via });
    for (const n of steps) await ctx.step(portabilityTitle(n, "run"), () => PORTABILITY_STEP_RUNNERS[n](run));
  },
});
