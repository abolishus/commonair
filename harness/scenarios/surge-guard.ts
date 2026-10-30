// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * W1, the verified-watch gate and the surge guard (docs/testing/w1-selectors.md, scenario
 * `surge-guard`; ADR 0015 "Consequences"):
 *
 * 1. Fetch-less bots that chat are refused with `msg_verified_watch`.
 * 2. A bot assigned to the CDN path is refused.
 * 3. Six accounts behind one address leave exactly one refused.
 * 4. Real viewers chat after 60 s + jitter + a scoring pass.
 * 5. An audio-only screen-reader viewer verifies and chats.
 * 6. A scripted surge trips the guard, a moderator ends it, and it reverts.
 * 7. `/chat` and the `surge-banner` in the browser.
 *
 * All seven are W1-watch-gate's. `--set steps=1,3` picks steps (`all` runs every step not
 * pending); `--set via=api` drives the web steps' setup through the API. Steps whose unit has not
 * merged are pending (`src/w1/steps.ts`) and run only when named. Owned by the orchestrator: units
 * fill their step modules in `src/w1/`.
 *
 * Needs `DATABASE_URL` (outbox and audit rows), the ops hook (harness/compose.e6.yaml) and
 * `CHAT_WATCH_GATE` / `CHAT_SURGE_GUARD` on (harness/compose.w1.yaml).
 */
import { parseVia } from "../src/money.ts";
import { defineScenario } from "../src/scenario.ts";
import { type W1Run, newW1Run } from "../src/w1/kit.ts";
import {
  type SurgeStep,
  SURGE_STEP_PREREQUISITES,
  parseSurgeSteps,
  surgeTitle,
  withPrerequisites,
} from "../src/w1/steps.ts";
import {
  stepAudioOnlyViewer,
  stepBotsRefused,
  stepCdnBotRefused,
  stepPerAddressCap,
  stepRealViewersChat,
  stepStudioAndBanner,
  stepSurgeTripsAndReverts,
} from "../src/w1/surge.ts";

const STEPS: Readonly<Record<SurgeStep, (run: W1Run) => Promise<void>>> = {
  1: stepBotsRefused,
  2: stepCdnBotRefused,
  3: stepPerAddressCap,
  4: stepRealViewersChat,
  5: stepAudioOnlyViewer,
  6: stepSurgeTripsAndReverts,
  7: stepStudioAndBanner,
};

export default defineScenario({
  name: "surge-guard",
  description:
    "fetch-less and CDN bots refused by the verified-watch gate → one address, one refusal → real and audio-only viewers chat after verifying → a surge trips the guard, a moderator ends it, it reverts → /chat and the surge banner",
  needs: ["api", "web", "chat", "mail", "media", "origin", "worker", "ffmpeg", "browser"],
  // W1 milestone end: the orchestrator sets this true and adds it to FULL_REQUIRED and a shard.
  inFull: false,
  timeoutMs: 20 * 60_000,
  async run(ctx) {
    const selected = parseSurgeSteps(ctx.param("steps", "all"));
    const { steps, added } = withPrerequisites(selected, SURGE_STEP_PREREQUISITES);
    const via = parseVia(ctx.param("via", "web"));
    ctx.data("steps", { selected, run: steps, addedPrerequisites: added });
    ctx.data("via", via);
    if (steps.length === 0) {
      ctx.skipStep("surge-guard", "every step is pending (no W1 unit merged yet); name one with --set steps=");
      return;
    }
    const run = await newW1Run(ctx, { via, prefix: "w1s" });
    for (const n of steps) await ctx.step(surgeTitle(n, "run"), () => STEPS[n](run));
  },
});
