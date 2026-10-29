// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Pure helpers of the `interact` viewer step (harness/src/e8/viewer.ts). */
import { describe, expect, test } from "vite-plus/test";
import { E8_ID_PATTERNS, e8tid } from "../../src/e8/selectors.ts";
import { VIEWER_BET, VIEWER_GRANT, onChannelPage, pathAndQuery } from "../../src/e8/viewer.ts";

describe("pathAndQuery", () => {
  test("keeps the overlay token in the query, drops the origin", () => {
    expect(pathAndQuery("https://commonair.example/overlay/goals?token=abc_123")).toBe("/overlay/goals?token=abc_123");
    expect(pathAndQuery("http://localhost:3000/overlay/goals")).toBe("/overlay/goals");
  });
});

describe("onChannelPage", () => {
  test("the target's channel page, any query or trailing slash, case-insensitive", () => {
    expect(onChannelPage("http://web.test/mothwing", "mothwing")).toBe(true);
    expect(onChannelPage("http://web.test/mothwing/?x=1", "mothwing")).toBe(true);
    expect(onChannelPage("http://web.test/Mothwing", "mothwing")).toBe(true);
  });

  test("not the source, not a sub-page, not a prefix", () => {
    expect(onChannelPage("http://web.test/rivertide", "mothwing")).toBe(false);
    expect(onChannelPage("http://web.test/mothwing/videos", "mothwing")).toBe(false);
    expect(onChannelPage("http://web.test/mothwing2", "mothwing")).toBe(false);
  });
});

describe("step constants and selectors", () => {
  test("the bet fits the grant and leaves a visible drop", () => {
    expect(VIEWER_BET).toBeGreaterThan(0);
    expect(VIEWER_GRANT - VIEWER_BET).toBeGreaterThan(0);
  });

  test("the per-outcome bet button id and data-constrained selectors", () => {
    expect(E8_ID_PATTERNS.chatPredictionBet.id("o1")).toBe("chat-prediction-bet-o1");
    expect(e8tid("chat-points", { points: "900" })).toBe('[data-testid="chat-points"][data-points="900"]');
    expect(e8tid("overlay-goal", { "goal-id": "g", current: "1" })).toBe(
      '[data-testid="overlay-goal"][data-goal-id="g"][data-current="1"]',
    );
  });
});
