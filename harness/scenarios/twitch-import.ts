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
 * Needs `oauth` (the fake `OAUTH_TWITCH_*` of harness/compose.n3.yaml), so `--profile
 * no-proprietary` skips it. Runs in the `w3` shard, on the harness stack with the batch 7
 * overrides (`bun scripts/infra.ts stack --harness --w3`).
 */
import { parseVia } from "../src/money.ts";
import { TWITCH_IMPORT_STEP_RUNNERS, newTwitchImportRun } from "../src/n3/index.ts";
import { defineScenario } from "../src/scenario.ts";
import {
  TWITCH_IMPORT_STEP_PREREQUISITES,
  parseTwitchImportSteps,
  twitchImportTitle,
  withPrerequisites,
} from "../src/w3/steps.ts";

export default defineScenario({
  name: "twitch-import",
  description:
    "connect through the Twitch mock → preview → import title, tags, category, description and emotes → the channel page and chat show them, the T0 emote is refused → schedule carried → panels pasted → token revoked",
  needs: ["api", "web", "chat", "worker", "oauth", "browser"],
  inFull: true,
  timeoutMs: 20 * 60_000,
  async run(ctx) {
    const selected = parseTwitchImportSteps(ctx.param("steps", "all"));
    const { steps, added } = withPrerequisites(selected, TWITCH_IMPORT_STEP_PREREQUISITES);
    const via = parseVia(ctx.param("via", "web"));
    ctx.data("steps", { selected, run: steps, addedPrerequisites: added });
    ctx.data("via", via);
    if (steps.length === 0) {
      ctx.skipStep("twitch-import", "no step selected; name one with --set steps=");
      return;
    }
    const run = await newTwitchImportRun(ctx, { via });
    for (const n of steps) await ctx.step(twitchImportTitle(n, "run"), () => TWITCH_IMPORT_STEP_RUNNERS[n](run));
  },
});
