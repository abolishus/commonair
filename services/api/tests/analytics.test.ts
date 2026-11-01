// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Creator Analytics' pure rules: the 24 h display delay, small-group suppression, ranges, the delivery mix. */
import { ANALYTICS_RULES } from "@commonair/contracts/enums";
import { describe, expect, test } from "vite-plus/test";
import {
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
  addInto,
  deliveryMix,
  displayAvailableAt,
  displayable,
  groupsOf,
  periodOf,
  shownFollowCount,
  sumGroups,
  suppressGroups,
} from "../src/analytics/rules.ts";

const DAY = 86_400_000;
const ended = new Date("2026-10-01T12:00:00.000Z");

describe("display delay", () => {
  test("a broadcast shows exactly 24 h after it ends", () => {
    expect(ANALYTICS_RULES.displayDelaySeconds).toBe(86_400);
    expect(displayAvailableAt(ended).toISOString()).toBe("2026-10-02T12:00:00.000Z");
    expect(displayable(ended, new Date(ended.getTime() + DAY - 1), false)).toBe(false);
    expect(displayable(ended, new Date(ended.getTime() + DAY), false)).toBe(true);
    expect(displayable(ended, new Date(ended.getTime() + DAY + 1), false)).toBe(true);
  });

  test("the test bypass shows an ended broadcast at once, never a live one", () => {
    expect(displayable(ended, ended, true)).toBe(true);
    expect(displayable(null, new Date(ended.getTime() + 10 * DAY), true)).toBe(false);
    expect(displayable(null, new Date(ended.getTime() + 10 * DAY), false)).toBe(false);
  });
});

describe("small-group suppression", () => {
  const g = (sessions: number) => ({ category: "datacenter" as const, sessions, viewerSeconds: sessions * 60 });

  test("4 is hidden, 5 and 6 are shown", () => {
    expect(ANALYTICS_RULES.minGroupSessions).toBe(5);
    expect(suppressGroups([g(4)])).toEqual({ shown: [], hidden: 1 });
    expect(suppressGroups([g(5)])).toEqual({ shown: [g(5)], hidden: 0 });
    expect(suppressGroups([g(6), g(4), g(1)])).toEqual({ shown: [g(6)], hidden: 2 });
    expect(suppressGroups([])).toEqual({ shown: [], hidden: 0 });
  });

  test("excluded follows under the threshold show as 0", () => {
    expect([0, 1, 4, 5, 6].map((n) => shownFollowCount(n))).toEqual([0, 0, 0, 5, 6]);
  });

  test("groups come from a broadcast's totals in category order, empty ones left out", () => {
    expect(
      groupsOf({
        excludedSessionsByCategory: { other: 2, datacenter: 7, automation: 0 },
        excludedSecondsByCategory: { other: 30, datacenter: 4200 },
      }),
    ).toEqual([
      { category: "datacenter", sessions: 7, viewerSeconds: 4200 },
      { category: "other", sessions: 2, viewerSeconds: 30 },
    ]);
  });

  test("shown groups sum by category across broadcasts", () => {
    expect(
      sumGroups([
        { category: "automation", sessions: 5, viewerSeconds: 10 },
        { category: "datacenter", sessions: 6, viewerSeconds: 20 },
        { category: "automation", sessions: 9, viewerSeconds: 1 },
      ]),
    ).toEqual([
      { category: "datacenter", sessions: 6, viewerSeconds: 20 },
      { category: "automation", sessions: 14, viewerSeconds: 11 },
    ]);
  });
});

describe("ranges", () => {
  const now = new Date("2026-10-31T00:00:00.000Z");

  test("defaults to the last 30 days", () => {
    expect(periodOf({}, now)).toEqual({ from: new Date(now.getTime() - DEFAULT_RANGE_DAYS * DAY), to: now });
    const to = "2026-10-15T00:00:00.000Z";
    expect(periodOf({ to }, now)?.from).toEqual(new Date(Date.parse(to) - DEFAULT_RANGE_DAYS * DAY));
  });

  test("refuses an empty, reversed or too long range", () => {
    expect(periodOf({ from: "2026-10-02T00:00:00Z", to: "2026-10-02T00:00:00Z" }, now)).toBeNull();
    expect(periodOf({ from: "2026-10-03T00:00:00Z", to: "2026-10-02T00:00:00Z" }, now)).toBeNull();
    const from = new Date(now.getTime() - MAX_RANGE_DAYS * DAY).toISOString();
    expect(periodOf({ from, to: now.toISOString() }, now)).not.toBeNull();
    const longer = new Date(now.getTime() - MAX_RANGE_DAYS * DAY - 1).toISOString();
    expect(periodOf({ from: longer, to: now.toISOString() }, now)).toBeNull();
  });
});

describe("delivery mix", () => {
  test("sources in contract order; a source with neither bytes nor verified seconds is left out", () => {
    expect(deliveryMix({ cdn: 5, origin: 10 }, { origin: 60, relay: 30 })).toEqual([
      { source: "origin", bytes: 10, verifiedViewerSeconds: 60 },
      { source: "relay", bytes: 0, verifiedViewerSeconds: 30 },
      { source: "cdn", bytes: 5, verifiedViewerSeconds: 0 },
    ]);
    expect(deliveryMix({}, {})).toEqual([]);
  });

  test("addInto sums maps", () => {
    const into: Partial<Record<"a" | "b", number>> = { a: 1 };
    addInto(into, { a: 2, b: 3 });
    expect(into).toEqual({ a: 3, b: 3 });
  });
});
