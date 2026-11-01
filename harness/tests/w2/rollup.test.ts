// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The `group` step's pure checks (src/w2/rollup.ts). */
import { describe, expect, test } from "vite-plus/test";
import {
  categoriesOf,
  expectedGroups,
  firstReasonCategory,
  groupMismatches,
  leakedCodes,
  swarmShortfalls,
} from "../../src/w2/rollup.ts";

describe("swarm categories", () => {
  test("a session's category is its first signal reason's; none is other", () => {
    expect(firstReasonCategory(["device_concurrency", "headless", "datacenter_ip"])).toBe("concurrency");
    expect(firstReasonCategory(["insufficient_heartbeats", "headless"])).toBe("automation");
    expect(firstReasonCategory(["insufficient_heartbeats"])).toBe("other");
    expect(firstReasonCategory(null)).toBe("other");
    expect(categoriesOf([["datacenter_ip"], ["headless"], ["headless", "datacenter_ip"]])).toEqual({
      datacenter: 1,
      automation: 2,
    });
  });
  test("shortfalls name categories the rollup holds fewer of than the swarm", () => {
    expect(swarmShortfalls({ automation: 3, concurrency: 2 }, { automation: 5, concurrency: 2 })).toEqual([]);
    expect(swarmShortfalls({ automation: 3 }, { datacenter: 3 })).toEqual(["automation: swarm 3, rollup 0"]);
    expect(swarmShortfalls({}, {})).toEqual([]);
  });
});

describe("expectedGroups", () => {
  test("shows groups of 5 or more in category order and counts the rest", () => {
    expect(
      expectedGroups(
        { automation: 4, datacenter: 12, playback_pattern: 5, other: 0 },
        { datacenter: 600, automation: 9 },
      ),
    ).toEqual({
      shown: [
        { category: "datacenter", sessions: 12, viewerSeconds: 600 },
        { category: "playback_pattern", sessions: 5, viewerSeconds: 0 },
      ],
      hidden: 1,
    });
    expect(expectedGroups({}, {})).toEqual({ shown: [], hidden: 0 });
  });
});

describe("groupMismatches", () => {
  const g = (sessions: number) => ({ category: "datacenter" as const, sessions, viewerSeconds: 60 });
  test("empty when equal, whatever the order", () => {
    expect(
      groupMismatches([g(5), { ...g(6), category: "automation" }], [{ ...g(6), category: "automation" }, g(5)]),
    ).toEqual([]);
  });
  test("names what is missing and what is unexpected", () => {
    expect(groupMismatches([g(6)], [g(5)])).toEqual(["missing datacenter:5:60", "unexpected datacenter:6:60"]);
  });
});

describe("leakedCodes", () => {
  test("finds signal codes but not category names", () => {
    expect(leakedCodes({ exclusions: [{ category: "privacy_relay" }, { category: "datacenter" }] })).toEqual([]);
    expect(leakedCodes({ reasons: ["datacenter_ip", "fetch_unjudged"] })).toEqual(["datacenter_ip", "fetch_unjudged"]);
  });
});
