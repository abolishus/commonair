// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `live-dvr` steps 1–7 (docs/testing/w2-selectors.md, "Scenarios"; ADR 0016) and their run state.
 * Stub: W2-dvr fills it (and may split it into more modules in this directory).
 */
import type { Via } from "../../money.ts";
import type { ScenarioContext } from "../../scenario.ts";
import type { DvrStep } from "../steps.ts";

export interface DvrRun {
  ctx: ScenarioContext;
  via: Via;
}

/** Set up what the selected steps share. W2-dvr adds the streamer, viewers and hooks. */
export async function newDvrRun(ctx: ScenarioContext, opts: { via: Via }): Promise<DvrRun> {
  return { ctx, via: opts.via };
}

const notMerged = async (_run: DvrRun): Promise<void> => {
  throw new Error("W2-dvr not merged");
};

export const DVR_STEP_RUNNERS: Readonly<Record<DvrStep, (run: DvrRun) => Promise<void>>> = {
  1: notMerged,
  2: notMerged,
  3: notMerged,
  4: notMerged,
  5: notMerged,
  6: notMerged,
  7: notMerged,
};
