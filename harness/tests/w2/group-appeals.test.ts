// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The `group-appeal` step's pure helpers (`src/w2/group-appeals.ts`). */
import { describe, expect, it } from "vite-plus/test";
import {
  expectedAfterOverturn,
  groupDropped,
  latestFor,
  newSupersede,
  noisyOr,
  overturnOutcome,
  type OverturnWeights,
  pickGroup,
  pickThresholdGroup,
  stillInGroup,
  underThreshold,
} from "../../src/w2/group-appeals.ts";

const B = "01900000-0000-7000-8000-0000000000b1";
const OTHER = "01900000-0000-7000-8000-0000000000b2";
const entry = (o: { seq: number; kind?: string; broadcastId?: string; entryHash?: string }) => ({
  kind: o.kind ?? "broadcast",
  broadcastId: o.broadcastId ?? B,
  entryHash: o.entryHash ?? `h${o.seq}`,
  supersedes: null,
  seq: o.seq,
  envelope: { payload: "p", signature: "s" },
});

describe("pickGroup", () => {
  it("datacenter when shown", () => {
    expect(
      pickGroup(
        [
          { category: "automation", sessions: 40 },
          { category: "datacenter", sessions: 5 },
        ],
        { automation: 40 },
      ),
    ).toBe("datacenter");
  });
  it("otherwise the shown group the swarm filled most, then the largest", () => {
    const shown = [
      { category: "concurrency" as const, sessions: 9 },
      { category: "automation" as const, sessions: 6 },
    ];
    expect(pickGroup(shown, { automation: 6, concurrency: 2 })).toBe("automation");
    expect(pickGroup(shown, {})).toBe("concurrency");
  });
  it("null when nothing is shown", () => {
    expect(pickGroup([], { datacenter: 3 })).toBeNull();
  });
});

describe("stillInGroup", () => {
  it("excluded sessions whose first reason is the category", () => {
    expect(
      stillInGroup(
        [
          { id: "a", verdict: "excluded", reasons: ["datacenter_ip"] },
          { id: "b", verdict: "verified", reasons: ["allowed_on_appeal"] },
          { id: "c", verdict: "excluded", reasons: ["headless", "allowed_on_appeal"] },
          { id: "d", verdict: "pending", reasons: ["allowed_on_appeal", "insufficient_heartbeats"] },
        ],
        "datacenter",
      ),
    ).toEqual(["a"]);
  });
});

describe("expectedAfterOverturn", () => {
  it("no other signal left: restored (null), whatever non-signal reasons remain", () => {
    expect(expectedAfterOverturn(["datacenter_ip"], "datacenter")).toBeNull();
    expect(
      expectedAfterOverturn(["datacenter_ip", "fetch_unjudged", "insufficient_heartbeats"], "datacenter"),
    ).toBeNull();
    expect(expectedAfterOverturn(["device_concurrency", "account_concurrency"], "concurrency")).toBeNull();
    expect(expectedAfterOverturn([], "datacenter")).toBeNull();
    expect(expectedAfterOverturn(null, "datacenter")).toBeNull();
  });

  it("another category's signal left: the group of the first one (CI run 41305101320's viewbots)", () => {
    expect(expectedAfterOverturn(["device_concurrency", "headless", "fetch_pattern"], "concurrency")).toBe(
      "automation",
    );
    expect(expectedAfterOverturn(["datacenter_ip", "fetch_pattern", "headless"], "datacenter")).toBe(
      "playback_pattern",
    );
  });
});

describe("overturnOutcome", () => {
  const s = (id: string, verdict: string, reasons: string[]) => ({ id, verdict, reasons });

  it("restored and moved sessions are both as expected", () => {
    const before = [s("a", "excluded", ["datacenter_ip"]), s("b", "excluded", ["datacenter_ip", "headless"])];
    const after = [s("a", "verified", ["allowed_on_appeal"]), s("b", "excluded", ["headless", "allowed_on_appeal"])];
    expect(overturnOutcome(before, after, "datacenter")).toEqual({
      notRestored: [],
      notMoved: [],
      restorable: 1,
      restored: 1,
      moved: 1,
      underThreshold: 0,
      underThresholdRestored: 0,
    });
  });

  it("pending counts as restored", () => {
    const o = overturnOutcome(
      [s("a", "excluded", ["datacenter_ip"])],
      [s("a", "pending", ["allowed_on_appeal", "insufficient_heartbeats"])],
      "datacenter",
    );
    expect(o).toMatchObject({ notRestored: [], restored: 1 });
  });

  it("a group where every session carries another signal: none restored, all moved, nothing wrong", () => {
    const reasons = ["device_concurrency", "headless", "fetch_pattern"];
    const before = ["a", "b", "c"].map((id) => s(id, "excluded", reasons));
    const after = ["a", "b", "c"].map((id) => s(id, "excluded", ["headless", "fetch_pattern", "allowed_on_appeal"]));
    expect(overturnOutcome(before, after, "concurrency")).toEqual({
      notRestored: [],
      notMoved: [],
      restorable: 0,
      restored: 0,
      moved: 3,
      underThreshold: 0,
      underThresholdRestored: 0,
    });
  });

  it("flags a session left excluded without another signal, one restored that should move, and a missing one", () => {
    const before = [
      s("a", "excluded", ["datacenter_ip"]),
      s("b", "excluded", ["datacenter_ip", "headless"]),
      s("c", "excluded", ["datacenter_ip", "headless"]),
      s("d", "excluded", ["datacenter_ip"]),
    ];
    const after = [
      s("a", "excluded", ["datacenter_ip"]),
      s("b", "verified", ["allowed_on_appeal"]),
      s("c", "excluded", ["datacenter_ip", "headless"]),
    ];
    expect(overturnOutcome(before, after, "datacenter")).toMatchObject({
      notRestored: ["a", "d"],
      notMoved: ["b", "c"],
    });
  });
});

describe("groupDropped", () => {
  it("dropped when no appealed session is back and nothing is counted", () => {
    expect(groupDropped(["a", "b"], { sessionIds: [], counted: 0 })).toEqual({ ok: true, newcomers: [], returned: [] });
  });

  it("tolerates sessions excluded after the overturn, up to their number", () => {
    expect(groupDropped(["a", "b"], { sessionIds: ["c"], counted: 1 })).toMatchObject({ ok: true, newcomers: ["c"] });
    expect(groupDropped(["a", "b"], { sessionIds: ["c"], counted: 2 }).ok).toBe(false);
  });

  it("fails when an appealed session is back in the group", () => {
    expect(groupDropped(["a", "b"], { sessionIds: ["b"], counted: 1 })).toMatchObject({ ok: false, returned: ["b"] });
  });
});

describe("attestation chain helpers", () => {
  it("finds a new supersede entry of the broadcast, newest first", () => {
    const chain = [
      entry({ seq: 1 }),
      entry({ seq: 2, broadcastId: OTHER }),
      entry({ seq: 3, kind: "supersede" }),
      entry({ seq: 4, kind: "supersede", broadcastId: OTHER }),
      entry({ seq: 5, kind: "supersede" }),
    ];
    expect(newSupersede(chain, B, new Set(["h1", "h2"]))?.seq).toBe(5);
    expect(newSupersede(chain, B, new Set(["h3", "h5"]))).toBeNull();
    expect(latestFor(chain, B)?.seq).toBe(5);
    expect(latestFor(chain, "01900000-0000-7000-8000-0000000000ff")).toBeNull();
  });
});

/** Batch 7 decision (g): what is left is weighed against the scorer's threshold (seeded 0.7). */
describe("the threshold rule", () => {
  const flags = { device_concurrency: 0.9, headless: 0.8, datacenter_ip: 0.6, fetch_pattern: 0.5 };
  const w = (threshold = 0.7) => ({ threshold, flags });

  it("noisyOr mirrors the scorer's combination, rounded at 1e-6", () => {
    expect(noisyOr([])).toBe(0);
    expect(noisyOr([0.6, 0.5])).toBe(0.8);
    expect(noisyOr([0.1, 0.2, 0.3])).toBe(0.496);
    expect(noisyOr([1.5, -1])).toBe(1);
  });

  it("a remainder at or under the threshold is restored; over it, the session moves", () => {
    expect(expectedAfterOverturn(["datacenter_ip", "fetch_pattern"], "datacenter", w())).toBeNull();
    expect(expectedAfterOverturn(["device_concurrency", "datacenter_ip"], "concurrency", w(0.6))).toBeNull();
    expect(expectedAfterOverturn(["device_concurrency", "datacenter_ip"], "concurrency", w(0.59))).toBe("datacenter");
    // Two signals left combine: 0.8 > 0.7.
    expect(expectedAfterOverturn(["device_concurrency", "datacenter_ip", "fetch_pattern"], "concurrency", w())).toBe(
      "datacenter",
    );
    // The seeded viewbots: headless (0.8) left crosses it.
    expect(expectedAfterOverturn(["device_concurrency", "headless", "fetch_pattern"], "concurrency", w())).toBe(
      "automation",
    );
  });

  it("a signal left with no flag keeps the session excluded (the re-score fails closed)", () => {
    expect(expectedAfterOverturn(["datacenter_ip", "fetch_pattern"], "datacenter", { threshold: 0.7, flags: {} })).toBe(
      "playback_pattern",
    );
    // Without weights: the batch 6 rule (any other signal keeps it excluded).
    expect(expectedAfterOverturn(["datacenter_ip", "fetch_pattern"], "datacenter")).toBe("playback_pattern");
  });

  const weights = (byId: Record<string, Record<string, number>>, threshold = 0.7): OverturnWeights => ({
    threshold,
    flags: new Map(Object.entries(byId)),
  });
  const s = (id: string, verdict: string, reasons: string[]) => ({ id, verdict, reasons });

  it("underThreshold: only sessions the threshold (not the plain rule) restores", () => {
    const sessions = [
      s("only", "excluded", ["datacenter_ip"]),
      s("under", "excluded", ["datacenter_ip", "fetch_pattern"]),
      s("over", "excluded", ["datacenter_ip", "headless"]),
    ];
    const ws = weights({ only: { datacenter_ip: 0.6 }, under: flags, over: flags });
    expect(underThreshold(sessions, "datacenter", ws)).toEqual(["under"]);
  });

  it("overturnOutcome by the threshold: restored under it, moved over it, and the sub-threshold ones counted", () => {
    const before = [
      s("under", "excluded", ["datacenter_ip", "fetch_pattern"]),
      s("over", "excluded", ["datacenter_ip", "headless"]),
    ];
    const ws = weights({ under: flags, over: flags });
    const good = [
      s("under", "verified", ["fetch_pattern", "allowed_on_appeal"]),
      s("over", "excluded", ["headless", "allowed_on_appeal"]),
    ];
    expect(overturnOutcome(before, good, "datacenter", ws)).toEqual({
      notRestored: [],
      notMoved: [],
      restorable: 1,
      restored: 1,
      moved: 1,
      underThreshold: 1,
      underThresholdRestored: 1,
    });
    // The batch 6 behaviour (the sub-threshold session kept excluded) is now a failure.
    const old = [s("under", "excluded", ["fetch_pattern", "allowed_on_appeal"]), good[1]!];
    expect(overturnOutcome(before, old, "datacenter", ws)).toMatchObject({
      notRestored: ["under"],
      underThreshold: 1,
      underThresholdRestored: 0,
    });
  });

  it("pickThresholdGroup: the shown group the threshold decides most often, else null", () => {
    const sessions = [
      s("a", "excluded", ["datacenter_ip", "fetch_pattern"]),
      s("b", "excluded", ["device_concurrency", "headless"]),
      s("c", "excluded", ["device_concurrency", "fetch_pattern"]),
      s("d", "excluded", ["device_concurrency", "datacenter_ip"]),
    ];
    const ws = weights({ a: flags, b: flags, c: flags, d: flags });
    const shown = [{ category: "datacenter" as const }, { category: "concurrency" as const }];
    expect(pickThresholdGroup(shown, sessions, ws)).toBe("concurrency");
    expect(pickThresholdGroup([{ category: "datacenter" }], sessions, ws)).toBe("datacenter");
    // A threshold under every remainder: nothing for the rule to decide.
    expect(pickThresholdGroup(shown, sessions, weights({ a: flags, b: flags, c: flags, d: flags }, 0.1))).toBeNull();
    expect(pickThresholdGroup([], sessions, ws)).toBeNull();
  });
});
