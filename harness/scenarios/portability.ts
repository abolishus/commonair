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
 * B8 extension (`--set b8=`, `src/b8/steps.ts`): `incoming-cleanup` (B8-server,
 * `src/b8/server.ts`) runs after the steps.
 *
 * Runs in the `w3` shard, on the harness stack with the batch 7 overrides
 * (`bun scripts/infra.ts stack --harness --w3`).
 */
import type { PortabilityB8Extension } from "../src/b8/kit.ts";
import { stepIncomingCleanup } from "../src/b8/server.ts";
import { type B8Extension, b8ExtensionTitle, b8Extensions, withB8Steps } from "../src/b8/steps.ts";
import { parseVia } from "../src/money.ts";
import { defineScenario } from "../src/scenario.ts";
import { PORTABILITY_STEP_RUNNERS, newPortabilityRun } from "../src/w3/portability/index.ts";
import {
  PORTABILITY_STEP_PREREQUISITES,
  parsePortabilitySteps,
  portabilityTitle,
  withPrerequisites,
} from "../src/w3/steps.ts";

const B8_STEPS: Readonly<Record<B8Extension<"portability">, (run: PortabilityB8Extension) => Promise<void>>> = {
  "incoming-cleanup": stepIncomingCleanup,
};

export default defineScenario({
  name: "portability",
  description:
    "a move link converts a follow → a grant and a move send one notice → a bundle round-trips into another channel → a T0 emote and a suspended channel's bundle are refused",
  needs: ["api", "web", "mail", "worker", "browser"],
  inFull: true,
  timeoutMs: 20 * 60_000,
  async run(ctx) {
    const selected = parsePortabilitySteps(ctx.param("steps", "all"));
    // `--set b8=` names a pending extension; by default only merged ones run (src/b8/steps.ts).
    const b8 = b8Extensions("portability", ctx.param("b8", ""));
    const forB8 = withB8Steps(selected, b8.run);
    const prerequisites = withPrerequisites(forB8.steps, PORTABILITY_STEP_PREREQUISITES);
    const steps = prerequisites.steps;
    const added = [...new Set([...forB8.added, ...prerequisites.added])].sort((a, b) => a - b);
    const via = parseVia(ctx.param("via", "web"));
    ctx.data("steps", { selected, run: steps, addedPrerequisites: added });
    ctx.data("via", via);
    ctx.data("b8.extensions", b8);
    if (steps.length === 0 && b8.run.length === 0) {
      ctx.skipStep("portability", "every step is pending (W3-portability not merged yet); name one with --set steps=");
      return;
    }
    const run = await newPortabilityRun(ctx, { via });
    for (const n of steps) await ctx.step(portabilityTitle(n, "run"), () => PORTABILITY_STEP_RUNNERS[n](run));
    for (const name of b8.run) await ctx.step(b8ExtensionTitle(name, "run"), () => B8_STEPS[name](run));
  },
});
