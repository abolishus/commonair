// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `rehearsal` steps 1–7 (docs/testing/w2-selectors.md, "Scenarios"; feature-wins §4.11) and their
 * run state. Stub: W2-rehearsal fills it (and may split it into more modules in this directory).
 */
import type { Via } from "../../money.ts";
import type { ScenarioContext } from "../../scenario.ts";
import type { RehearsalStep } from "../steps.ts";

export interface RehearsalRun {
  ctx: ScenarioContext;
  via: Via;
}

/** Set up what the selected steps share. W2-rehearsal adds the streamer, invitees and hooks. */
export async function newRehearsalRun(ctx: ScenarioContext, opts: { via: Via }): Promise<RehearsalRun> {
  return { ctx, via: opts.via };
}

const notMerged = async (_run: RehearsalRun): Promise<void> => {
  throw new Error("W2-rehearsal not merged");
};

export const REHEARSAL_STEP_RUNNERS: Readonly<Record<RehearsalStep, (run: RehearsalRun) => Promise<void>>> = {
  1: notMerged,
  2: notMerged,
  3: notMerged,
  4: notMerged,
  5: notMerged,
  6: notMerged,
  7: notMerged,
};
