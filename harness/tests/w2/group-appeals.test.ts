// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The `group-appeal` step's pure helpers (`src/w2/group-appeals.ts`). */
import { describe, expect, it } from "vite-plus/test";
import { groupDropped, latestFor, newSupersede, pickGroup, stillInGroup } from "../../src/w2/group-appeals.ts";

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
