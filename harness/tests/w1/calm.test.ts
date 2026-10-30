// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The pure parts of the `flood` extension (src/w1/calm.ts): the plan, the window maths, the a11y rules. */
import { CHAT_LIMITS } from "@commonair/contracts/chat";
import { describe, expect, test } from "vite-plus/test";
import {
  FLOOD,
  a11yViolations,
  RENDER_TOLERANCE_MS,
  digestUpdates,
  floodPlan,
  maxNewRowsPerWindow,
  type A11yNode,
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

const row = (id: string, t: number) => ({ id, t });

describe("maxNewRowsPerWindow", () => {
  test("a sliding one-second window over the recorded times", () => {
    // The governor's pattern: 3 rows at one tick, the next 3 a second later.
    const steady = [row("a", 100), row("b", 101), row("c", 102), row("d", 1_100), row("e", 1_101), row("f", 1_102)];
    expect(maxNewRowsPerWindow(steady, new Set())).toEqual({ max: 3, at: 100, times: [100, 101, 102] });
    // One batch rendered late by less than the tolerance still reads as separate seconds.
    const late = [row("a", 130), row("b", 131), row("c", 132), row("d", 1_100)];
    expect(maxNewRowsPerWindow(late, new Set()).max).toBe(3);
    // CI: a batch committed ~300 ms late next to an on-time one is still two seconds of rows.
    const lagged = [row("a", 300), row("b", 301), row("c", 302), row("d", 1_000), row("e", 1_001), row("f", 1_002)];
    expect(maxNewRowsPerWindow(lagged, new Set()).max).toBe(3);
    // A governor with no window at all (every 250 ms tick admits 3) is caught.
    const unlimited = [0, 250, 500, 750].flatMap((t) => [row(`a${t}`, t), row(`b${t}`, t), row(`c${t}`, t)]);
    expect(maxNewRowsPerWindow(unlimited, new Set()).max).toBeGreaterThan(3);
    // A real overflow inside the window is caught wherever it starts.
    const over = [row("a", 0), row("b", 300), row("c", 400), row("d", 500), row("e", 2_000)];
    expect(maxNewRowsPerWindow(over, new Set())).toEqual({ max: 4, at: 0, times: [0, 300, 400, 500] });
    expect(maxNewRowsPerWindow([row("a", 1_000 - RENDER_TOLERANCE_MS - 1), row("b", 0)], new Set()).max).toBe(2);
  });

  test("mentions are exempt; nothing recorded is zero", () => {
    const burst = [row("a", 0), row("b", 0), row("c", 0), row("m", 1)];
    expect(maxNewRowsPerWindow(burst, new Set()).max).toBe(4);
    expect(maxNewRowsPerWindow(burst, new Set(["m"])).max).toBe(3);
    expect(maxNewRowsPerWindow([], new Set())).toEqual({ max: 0, at: 0, times: [] });
  });
});

describe("digestUpdates", () => {
  test("change times and the shortest gap", () => {
    const changes = [
      { text: "3 new messages", t: 250 },
      { text: "40 new messages", t: 5_252 },
      { text: "80 new messages", t: 10_500 },
    ];
    expect(digestUpdates(changes)).toEqual({ times: [250, 5_252, 10_500], minGapMs: 5_002 });
    expect(digestUpdates([{ text: "a", t: 0 }]).minGapMs).toBe(Number.POSITIVE_INFINITY);
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
