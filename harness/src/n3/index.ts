// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `twitch-import` steps 1–9 (docs/testing/b7-selectors.md, "Scenarios"; ADR 0031) and their run
 * state, against the in-harness Twitch mock (`src/mocks/twitch/`). Stub: N3-import fills it (and
 * may split it into more modules in this directory).
 */
import type { Via } from "../money.ts";
import type { ScenarioContext } from "../scenario.ts";
import type { TwitchImportStep } from "../w3/steps.ts";

/**
 * The port the Twitch mock listens on, on this machine. `harness/compose.n3.yaml` points
 * `TWITCH_API_BASE_URL` and `TWITCH_AUTH_BASE_URL` at `host.containers.internal:<this>` (a test
 * keeps them in step), so it is fixed, not ephemeral.
 */
export const TWITCH_MOCK_PORT = 4791;

export interface TwitchImportRun {
  ctx: ScenarioContext;
  via: Via;
}

/** Set up what the selected steps share. N3-import adds the mock, the streamer and the channel. */
export async function newTwitchImportRun(ctx: ScenarioContext, opts: { via: Via }): Promise<TwitchImportRun> {
  return { ctx, via: opts.via };
}

const notMerged = async (_run: TwitchImportRun): Promise<void> => {
  throw new Error("N3-import not merged");
};

export const TWITCH_IMPORT_STEP_RUNNERS: Readonly<Record<TwitchImportStep, (run: TwitchImportRun) => Promise<void>>> = {
  1: notMerged,
  2: notMerged,
  3: notMerged,
  4: notMerged,
  5: notMerged,
  6: notMerged,
  7: notMerged,
  8: notMerged,
  9: notMerged,
};
