// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `captions` steps 1–8 (docs/testing/w2-selectors.md, "Scenarios"; ADR 0011) and their run state.
 * Stub: W2-captions fills it (and may split it into more modules in this directory).
 */
import type { Via } from "../../money.ts";
import type { ScenarioContext } from "../../scenario.ts";
import type { CaptionsStep } from "../steps.ts";

export interface CaptionsRun {
  ctx: ScenarioContext;
  via: Via;
}

/** Set up what the selected steps share. W2-captions adds the streamer, fixture and viewers. */
export async function newCaptionsRun(ctx: ScenarioContext, opts: { via: Via }): Promise<CaptionsRun> {
  return { ctx, via: opts.via };
}

const notMerged = async (_run: CaptionsRun): Promise<void> => {
  throw new Error("W2-captions not merged");
};

export const CAPTIONS_STEP_RUNNERS: Readonly<Record<CaptionsStep, (run: CaptionsRun) => Promise<void>>> = {
  1: notMerged,
  2: notMerged,
  3: notMerged,
  4: notMerged,
  5: notMerged,
  6: notMerged,
  7: notMerged,
  8: notMerged,
};
