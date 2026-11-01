// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `federation` steps 1–8 (docs/testing/b7-selectors.md, "Scenarios"; ADR 0030) and their run
 * state, against the in-harness ActivityPub peer (`src/mocks/activitypub/`). With `via=web` the
 * steps that have a studio or admin page use `src/n4/web.ts` (N4-web). Stub: N4-delivery fills it
 * (and may split it into more modules in this directory, except `web.ts`).
 */
import type { Via } from "../money.ts";
import type { ScenarioContext } from "../scenario.ts";
import type { FederationStep } from "../w3/steps.ts";
import * as federationWeb from "./web.ts";

export interface FederationRun {
  ctx: ScenarioContext;
  via: Via;
  /** N4-web's studio and admin steps, for `via=web`. */
  web: typeof federationWeb;
}

/** Set up what the selected steps share. N4-delivery adds the peer, the streamer and the channel. */
export async function newFederationRun(ctx: ScenarioContext, opts: { via: Via }): Promise<FederationRun> {
  return { ctx, via: opts.via, web: federationWeb };
}

const notMerged = async (_run: FederationRun): Promise<void> => {
  throw new Error("N4-delivery not merged");
};

export const FEDERATION_STEP_RUNNERS: Readonly<Record<FederationStep, (run: FederationRun) => Promise<void>>> = {
  1: notMerged,
  2: notMerged,
  3: notMerged,
  4: notMerged,
  5: notMerged,
  6: notMerged,
  7: notMerged,
  8: notMerged,
};
