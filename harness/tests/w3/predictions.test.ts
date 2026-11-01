// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The `fair-prediction` step's pure helpers (src/w3/predictions.ts). */
import { describe, expect, test } from "vite-plus/test";
import { FORCED_LATENCIES } from "../../src/w1/timeline-web.ts";
import {
  FAIR_PREDICTION_IDS,
  FAR_BET_DEADLINE_MS,
  apiNow,
  playheadAt,
  reasonOf,
  resultProblems,
} from "../../src/w3/predictions.ts";

describe("the API clock and the playheads", () => {
  test("apiNow adds the harness's elapsed time to the API's stamp, never going back", () => {
    expect(apiNow("2026-11-01T12:00:00.000Z", 1_000, 3_500).toISOString()).toBe("2026-11-01T12:00:02.500Z");
    expect(apiNow("2026-11-01T12:00:00.000Z", 1_000, 900).toISOString()).toBe("2026-11-01T12:00:00.000Z");
  });

  test("a player latency seconds behind reports that much earlier", () => {
    const now = new Date("2026-11-01T12:00:10.000Z");
    expect(playheadAt(now, FORCED_LATENCIES.far).toISOString()).toBe("2026-11-01T12:00:01.000Z");
    expect(playheadAt(now, 0)).toEqual(now);
  });

  test("the far viewer bets before its delay runs out (so its playhead is before the lock)", () => {
    expect(FAR_BET_DEADLINE_MS).toBeLessThan(FORCED_LATENCIES.far * 1000);
    expect(FORCED_LATENCIES.near).toBeLessThan(FORCED_LATENCIES.far);
  });
});

describe("resultProblems", () => {
  test("a card that adds up has none", () => {
    expect(resultProblems({ pool: 500, winners: 1, payoutSum: 500 }, { pool: 500, winners: 1 })).toEqual([]);
  });

  test("names a missing card, a wrong pool, wrong winners and payouts off the pool", () => {
    expect(resultProblems(null, { pool: 1, winners: 1 })).toEqual(["no result card"]);
    expect(resultProblems(undefined, { pool: 1, winners: 1 })).toEqual(["no result card"]);
    expect(resultProblems({ pool: 400, winners: 2, payoutSum: 399 }, { pool: 500, winners: 1 })).toEqual([
      "pool 400, want 500",
      "winners 2, want 1",
      "payouts 399 do not sum to the pool 400",
    ]);
  });
});

describe("reasonOf and the ids", () => {
  test("reads a FORBIDDEN refusal's reason", () => {
    expect(reasonOf({ code: "FORBIDDEN", data: { reason: "staff" } })).toBe("staff");
    expect(reasonOf({ code: "FORBIDDEN" })).toBeNull();
    expect(reasonOf(new Error("x"))).toBeNull();
    expect(reasonOf(null)).toBeNull();
  });

  test("the ids are the b7-selectors.md ones", () => {
    expect(Object.values(FAIR_PREDICTION_IDS)).toEqual([
      "chat-prediction-locks-note",
      "chat-prediction-refused",
      "chat-prediction-result",
      "prediction-resolved-by",
      "prediction-team-note",
    ]);
  });
});
