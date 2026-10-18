// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  initialHysteresis,
  stepHysteresis,
  type HysteresisAction,
  type HysteresisState,
} from "../src/transcode/hysteresis.ts";

const cfg = { threshold: 50, startAfterMs: 30_000, stopAfterMs: 120_000, stopFraction: 0.8 };

/** Feed (timeMs, viewers) samples; return the actions in order with their times. */
function run(samples: [number, number][], state: HysteresisState = initialHysteresis()) {
  const actions: [number, HysteresisAction][] = [];
  let s = state;
  for (const [t, v] of samples) {
    const r = stepHysteresis(s, v, t, cfg);
    s = r.state;
    if (r.action) actions.push([t, r.action]);
  }
  return { actions, state: s };
}

describe("transcode hysteresis", () => {
  test("starts only after viewers stay above the threshold for 30 s", () => {
    const { actions, state } = run([
      [0, 51],
      [10_000, 60],
      [29_999, 70],
      [30_000, 70],
    ]);
    expect(actions).toEqual([[30_000, "start"]]);
    expect(state.active).toBe(true);
  });

  test("exactly the threshold does not count as exceeding it", () => {
    expect(
      run([
        [0, 50],
        [60_000, 50],
      ]).actions,
    ).toEqual([]);
  });

  test("a dip below the threshold resets the start timer", () => {
    const { actions } = run([
      [0, 60],
      [20_000, 60],
      [25_000, 40],
      [30_000, 60],
      [55_000, 60],
      [60_000, 60],
    ]);
    expect(actions).toEqual([[60_000, "start"]]);
  });

  test("keeps running between 80% and 100% of the threshold (no flapping)", () => {
    const active: HysteresisState = { active: true, since: null };
    const { actions, state } = run(
      [
        [0, 45],
        [200_000, 40],
        [400_000, 41],
      ],
      active,
    );
    expect(actions).toEqual([]);
    expect(state.active).toBe(true);
  });

  test("stops after viewers stay below 80% for 2 minutes", () => {
    const active: HysteresisState = { active: true, since: null };
    const { actions, state } = run(
      [
        [0, 39],
        [60_000, 10],
        [119_999, 0],
        [120_000, 0],
      ],
      active,
    );
    expect(actions).toEqual([[120_000, "stop"]]);
    expect(state).toEqual({ active: false, since: null });
  });

  test("recovering above the stop level cancels a pending stop", () => {
    const active: HysteresisState = { active: true, since: null };
    const { actions } = run(
      [
        [0, 10],
        [100_000, 10],
        [110_000, 40],
        [200_000, 10],
        [310_000, 10],
        [320_000, 10],
      ],
      active,
    );
    expect(actions).toEqual([[320_000, "stop"]]);
  });

  test("full cycle: start, sustain, stop, start again", () => {
    const { actions } = run([
      [0, 100],
      [30_000, 100],
      [60_000, 5],
      [180_000, 5],
      [200_000, 100],
      [230_000, 100],
    ]);
    expect(actions).toEqual([
      [30_000, "start"],
      [180_000, "stop"],
      [230_000, "start"],
    ]);
  });

  test("zero delays act on the first qualifying sample", () => {
    const fast = { ...cfg, startAfterMs: 0, stopAfterMs: 0 };
    expect(stepHysteresis(initialHysteresis(), 51, 0, fast).action).toBe("start");
    expect(stepHysteresis({ active: true, since: null }, 1, 0, fast).action).toBe("stop");
  });
});
