// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the `d-surfaces` scenario hands each D unit's steps (.claude/briefs/d/D0-contract-step.md):
 * the seeded store and one signed-in browser page per role. Each unit owns its own step file in
 * this directory and exports one `DSteps` function; this file and the scenario are D0's.
 */
import type { Page } from "playwright";
import type { ScenarioContext } from "../scenario.ts";
import type { SeedStore } from "../seed/types.ts";

export interface DContext {
  scenario: ScenarioContext;
  /** The seed run's store (`seed full`), for handles, slugs and ids. */
  store: SeedStore;
  /** Not signed in. */
  anonymous: Page;
  /** The seeded viewer (`viewer1`). */
  viewer: Page;
  /** The seeded streamer with data (`streamer1`, live in Art under `seed live`). */
  streamer: Page;
}

export type DSteps = (ctx: DContext) => Promise<void>;
