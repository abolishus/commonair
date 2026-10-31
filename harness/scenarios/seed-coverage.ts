// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * After `seed full --scale small`, every web route as its role (`SEED_ROUTES`) must render seeded
 * data: no empty state, no error boundary, no error response. Not in `full`: it needs a database
 * the full seed just filled, and `full` shares one with users in it. The milestone wiring builds
 * the visits; until then every route is reported as a pending step.
 */
import { defineScenario } from "../src/scenario.ts";
import { SEED_ROUTES } from "../src/seed/routes.ts";

export default defineScenario({
  name: "seed-coverage",
  description: "after `seed full`: every web route as its role shows seeded data (no empty state, no error)",
  needs: ["api", "web", "browser"],
  inFull: false,
  timeoutMs: 20 * 60_000,
  async run(ctx) {
    for (const path of Object.keys(SEED_ROUTES)) ctx.skipStep(path, "pending: seed-full milestone wiring");
  },
});
