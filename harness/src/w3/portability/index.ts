// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `portability` steps 1–5 (docs/testing/b7-selectors.md, "Scenarios"; ADR 0037) and their run
 * state. Stub: W3-portability fills it (and may split it into more modules in this directory).
 */
import type { Via } from "../../money.ts";
import type { ScenarioContext } from "../../scenario.ts";
import type { PortabilityStep } from "../steps.ts";

export interface PortabilityRun {
  ctx: ScenarioContext;
  via: Via;
}

/** Set up what the selected steps share. W3-portability adds the channels and followers. */
export async function newPortabilityRun(ctx: ScenarioContext, opts: { via: Via }): Promise<PortabilityRun> {
  return { ctx, via: opts.via };
}

const notMerged = async (_run: PortabilityRun): Promise<void> => {
  throw new Error("W3-portability not merged");
};

export const PORTABILITY_STEP_RUNNERS: Readonly<Record<PortabilityStep, (run: PortabilityRun) => Promise<void>>> = {
  1: notMerged,
  2: notMerged,
  3: notMerged,
  4: notMerged,
  5: notMerged,
};
