// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The pure parts of the `flood` extension (src/w1/calm.ts): the plan, the sampling maths, the a11y rules. */
import { CHAT_LIMITS } from "@commonair/contracts/chat";
import { describe, expect, test } from "vite-plus/test";
import {
  FLOOD,
  a11yViolations,
  digestUpdates,
  firstSeen,
  floodPlan,
  maxNewRowsPerWindow,
  type A11yNode,
  type RowSample,
} from "../../src/w1/calm.ts";

describe("floodPlan", () => {
  const plan = floodPlan("fan_one", "abc123");

  test("50 messages a second for 10 seconds", () => {
    expect(plan).toHaveLength(FLOOD.ratePerSecond * FLOOD.seconds);
    expect(plan[0]?.at).toBe(0);
    expect(plan.at(-1)?.at).toBeLessThan(FLOOD.seconds * 1000);
    for (let i = 1; i < plan.length; i++) expect(plan[i]!.at).toBeGreaterThanOrEqual(plan[i - 1]!.at);
  });

  test("no bot exceeds chat's per-member limit or repeats a body (duplicates are refused)", () => {
    const perBot = new Map<number, string[]>();
    for (const l of plan) perBot.set(l.bot, [...(perBot.get(l.bot) ?? []), l.body]);
    expect(perBot.size).toBe(FLOOD.bots);
    for (const bodies of perBot.values()) {
      expect(bodies.length).toBeLessThanOrEqual(CHAT_LIMITS.user);
      expect(new Set(bodies).size).toBe(bodies.length);
    }
  });

  test("mixes repeated bodies, mentions of the fan and varied lines", () => {
    const mentions = plan.filter((l) => l.mention);
    expect(mentions).toHaveLength(FLOOD.mentions);
    expect(mentions.every((l) => l.body.startsWith("@fan_one "))).toBe(true);
    expect(new Set(mentions.map((l) => l.body)).size).toBe(FLOOD.mentions);
    for (const body of FLOOD.repeated) expect(plan.filter((l) => l.body === body).length).toBeGreaterThan(20);
    expect(plan.filter((l) => l.body.startsWith("line ")).length).toBeGreaterThan(300);
    // The mentions are spread over the whole flood.
    expect(mentions[0]!.at).toBeLessThan(1_500);
    expect(mentions.at(-1)!.at).toBeGreaterThan(8_000);
  });
});

const sample = (t: number, rows: string[], digest = ""): RowSample => ({ t, rows, digest });

describe("firstSeen and maxNewRowsPerWindow", () => {
  test("ignores rows that were there before and counts each row once", () => {
    const samples = [sample(0, ["old", "a"]), sample(250, ["old", "a", "b"]), sample(500, ["a", "b"])];
    expect([...firstSeen(samples, new Set(["old"]))]).toEqual([
      ["a", 0],
      ["b", 250],
    ]);
  });

  test("the most new rows within four consecutive samples (one second)", () => {
    const samples = [
      sample(0, ["a"]),
      sample(250, ["a", "b"]),
      sample(500, ["a", "b", "c"]),
      sample(750, ["a", "b", "c"]),
      sample(1000, ["a", "b", "c", "d"]),
      sample(1250, ["a", "b", "c", "d", "e", "f"]),
    ];
    expect(maxNewRowsPerWindow(samples, new Set(), new Set())).toEqual({ max: 4, at: 500 });
    expect(maxNewRowsPerWindow(samples, new Set(), new Set(["e"]))).toEqual({ max: 3, at: 0 });
    const burst = [sample(0, []), sample(250, ["a", "b", "c", "m"])];
    expect(maxNewRowsPerWindow(burst, new Set(), new Set()).max).toBe(4);
    expect(maxNewRowsPerWindow(burst, new Set(), new Set(["m"])).max).toBe(3);
    expect(maxNewRowsPerWindow([], new Set(), new Set())).toEqual({ max: 0, at: 0 });
  });
});

describe("digestUpdates", () => {
  test("change times and the shortest gap", () => {
    const samples = [
      sample(0, [], ""),
      sample(250, [], "3 new messages"),
      sample(500, [], "3 new messages"),
      sample(5_250, [], "40 new messages"),
      sample(10_500, [], "80 new messages"),
    ];
    expect(digestUpdates(samples)).toEqual({ times: [250, 5_250, 10_500], minGapMs: 5_000 });
    expect(digestUpdates([sample(0, [], "a")]).minGapMs).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("a11yViolations", () => {
  const node = (over: Partial<A11yNode>): A11yNode => ({
    tag: "div",
    testId: null,
    role: null,
    name: "",
    tabIndex: -1,
    ariaLive: null,
    labelled: false,
    hidden: false,
    ...over,
  });
  const good = [
    node({ role: "log", name: "Chat messages" }),
    node({ tag: "p", testId: "calm-digest", ariaLive: "polite" }),
    node({ tag: "button", name: "Calm Chat" }),
    node({ tag: "input", testId: "chat-input", labelled: true }),
    node({ tag: "article", testId: "chat-message", tabIndex: -1 }),
    node({ tag: "article", testId: "chat-wave", tabIndex: 0 }),
  ];

  test("a well-formed panel passes", () => {
    expect(a11yViolations(good, { calm: true })).toEqual([]);
  });

  test("names, labels, the log, the digest and roving focus", () => {
    const bad = [
      node({ role: "log", name: "" }),
      node({ tag: "button", testId: "x", name: " " }),
      node({ tag: "button", name: "", hidden: true }),
      node({ tag: "input", labelled: false }),
      node({ tag: "p", testId: "calm-digest", ariaLive: "assertive" }),
      node({ tag: "article", testId: "chat-message", tabIndex: 0 }),
      node({ tag: "article", testId: "chat-wave", tabIndex: 0 }),
    ];
    expect(a11yViolations(bad, { calm: true })).toEqual([
      "button[x] has no name",
      "input has no label",
      "the log has no name",
      "calm-digest aria-live is assertive",
      "2 chat rows are in the tab order (expected at most one)",
    ]);
    expect(a11yViolations([], { calm: true })).toEqual(["expected one log, found 0", "calm-digest is missing"]);
    expect(
      a11yViolations(
        good.filter((n) => n.testId !== "calm-digest"),
        { calm: false },
      ),
    ).toEqual([]);
  });
});
