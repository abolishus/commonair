// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The `group-appeal` step's pure helpers (`src/w2/group-appeals.ts`). */
import { describe, expect, it } from "vite-plus/test";
import {
  expectedAfterOverturn,
  groupDropped,
  latestFor,
  newSupersede,
  overturnOutcome,
  pickGroup,
  stillInGroup,
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
