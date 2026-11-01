// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `watch-room` steps 1–8 (docs/testing/b7-selectors.md, "Scenarios"; feature-wins §4.13) and their
 * run state. Stub: W3-watch-rooms fills it (and may split it into more modules in this directory).
 */
import type { Via } from "../../money.ts";
import type { ScenarioContext } from "../../scenario.ts";
import type { WatchRoomStep } from "../steps.ts";

export interface WatchRoomRun {
  ctx: ScenarioContext;
  via: Via;
}

/** Set up what the selected steps share. W3-watch-rooms adds the channel, members and sessions. */
export async function newWatchRoomRun(ctx: ScenarioContext, opts: { via: Via }): Promise<WatchRoomRun> {
  return { ctx, via: opts.via };
}

const notMerged = async (_run: WatchRoomRun): Promise<void> => {
  throw new Error("W3-watch-rooms not merged");
};

export const WATCH_ROOM_STEP_RUNNERS: Readonly<Record<WatchRoomStep, (run: WatchRoomRun) => Promise<void>>> = {
  1: notMerged,
  2: notMerged,
  3: notMerged,
  4: notMerged,
  5: notMerged,
  6: notMerged,
  7: notMerged,
  8: notMerged,
};
