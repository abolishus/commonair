// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The `group` step's pure checks (src/w2/rollup.ts). */
import { describe, expect, test } from "vite-plus/test";
import { expectedGroups, groupMismatches, leakedCodes } from "../../src/w2/rollup.ts";

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
