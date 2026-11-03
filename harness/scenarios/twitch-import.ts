// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * N3, import from Twitch (docs/testing/b7-selectors.md, scenario `twitch-import`; ADR 0031),
 * against the in-harness Twitch mock, never the real Twitch API:
 *
 * 1. Connect through the mock.
 * 2. The preview shows the fixture channel.
 * 3. Import title, tags, category, description and emotes, with the assertion.
 * 4. The channel page shows the title.
 * 5. Accepted emotes work in chat; the T0 emote is rejected and the T0 job ran.
 * 6. The schedule is shown as carried, not applied.
 * 7. Paste panels and see them on the channel page.
 * 8. The mock recorded the token's revocation.
 *
 * The flag-off page (`TWITCH_IMPORT_ENABLED` false: the unavailable state) is not a step: the `w3`
 * stack forces the flag on everywhere, so the API's integration tests and the web unit tests cover it.
 *
 * `--set steps=1,3` picks steps (`all` runs every step not pending; each step adds the ones it
 * reads, `src/w3/steps.ts`); `--set via=api` drives the web setup through the API. The steps live
 * in `src/n3/`, the mock in `src/mocks/twitch/` (on `TWITCH_MOCK_PORT`, reached by the containers
 * as `host.containers.internal`).
 *
 * B8 extensions (`--set b8=`, `src/b8/steps.ts`) run after the steps: `field-choices` and
 * `import-expiry` (B8-server, `src/b8/server.ts`; `import-expiry` adds step 3) and
 * `channel-panels-banner` (B8-web, `src/b8/web.ts`; adds steps 3 and 7).
 *
 * Needs `oauth` (the fake `OAUTH_TWITCH_*` of harness/compose.n3.yaml), so `--profile
 * no-proprietary` skips it. Runs in the `w3` shard, on the harness stack with the batch 7
 * overrides (`bun scripts/infra.ts stack --harness --w3`).
 */
import type { TwitchImportB8Extension } from "../src/b8/kit.ts";
import { stepFieldChoices, stepImportExpiry } from "../src/b8/server.ts";
import { type B8Extension, b8ExtensionTitle, b8Extensions, withB8Steps } from "../src/b8/steps.ts";
import { stepChannelPanelsBanner } from "../src/b8/web.ts";
import { parseVia } from "../src/money.ts";
import { TWITCH_IMPORT_STEP_RUNNERS, newTwitchImportRun } from "../src/n3/index.ts";
import { defineScenario } from "../src/scenario.ts";
import {
  TWITCH_IMPORT_STEP_PREREQUISITES,
  parseTwitchImportSteps,
  twitchImportTitle,
  withPrerequisites,
} from "../src/w3/steps.ts";

const B8_STEPS: Readonly<Record<B8Extension<"twitch-import">, (run: TwitchImportB8Extension) => Promise<void>>> = {
  "field-choices": stepFieldChoices,
  "channel-panels-banner": stepChannelPanelsBanner,
  "import-expiry": stepImportExpiry,
};

export default defineScenario({
  name: "twitch-import",
  description:
    "connect through the Twitch mock → preview → import title, tags, category, description and emotes → the channel page and chat show them, the T0 emote is refused → schedule carried → panels pasted → token revoked",
  needs: ["api", "web", "chat", "worker", "oauth", "browser"],
  inFull: true,
  timeoutMs: 20 * 60_000,
  async run(ctx) {
    const selected = parseTwitchImportSteps(ctx.param("steps", "all"));
    // `--set b8=` names a pending extension; by default only merged ones run (src/b8/steps.ts).
    const b8 = b8Extensions("twitch-import", ctx.param("b8", ""));
    const forB8 = withB8Steps(selected, b8.run);
    const prerequisites = withPrerequisites(forB8.steps, TWITCH_IMPORT_STEP_PREREQUISITES);
    const steps = prerequisites.steps;
    const added = [...new Set([...forB8.added, ...prerequisites.added])].sort((a, b) => a - b);
    const via = parseVia(ctx.param("via", "web"));
    ctx.data("steps", { selected, run: steps, addedPrerequisites: added });
    ctx.data("via", via);
    ctx.data("b8.extensions", b8);
    if (steps.length === 0 && b8.run.length === 0) {
      ctx.skipStep("twitch-import", "no step selected; name one with --set steps=");
      return;
    }
    const run = await newTwitchImportRun(ctx, { via });
    for (const n of steps) await ctx.step(twitchImportTitle(n, "run"), () => TWITCH_IMPORT_STEP_RUNNERS[n](run));
    for (const name of b8.run) await ctx.step(b8ExtensionTitle(name, "run"), () => B8_STEPS[name](run));
  },
});
