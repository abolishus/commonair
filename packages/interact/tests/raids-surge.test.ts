// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Surge raids' shared rules (batch 7 decision (w), ADR 0039 §4): who opens a surge, the carry and its window. */
import { describe, expect, test } from "vite-plus/test";
import { RAID_RULES } from "@commonair/contracts/enums";
import { SurgeState } from "@commonair/contracts/dto";
import { VerifiedWatchValue } from "@commonair/contracts/internal";
import {
  RAID_SURGE_GATE_SECONDS,
  carryWindowStart,
  inCarryWindow,
  raidCarrySeconds,
  raidCarryTtlSeconds,
  raidCarryValue,
  raidOpensSurge,
  raidSurgeUntil,
  surgeRaidOf,
} from "../src/raids.ts";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const SRC_B = "0190f0aa-0000-7000-8000-0000000000b1";
const DST_B = "0190f0aa-0000-7000-8000-0000000000b2";
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe("raidOpensSurge", () => {
  test.each([
    [true, true, true, true],
    [true, true, false, false],
    [true, false, true, false],
    [true, false, false, false],
    [false, true, true, false],
    [false, false, false, false],
  ] as const)("instance %s, guard %s, onRaid %s → %s", (instance, enabled, onRaid, opens) => {
    expect(raidOpensSurge(instance, { enabled, onRaid })).toBe(opens);
  });
});

describe("the surge's length", () => {
  test("RAID_RULES.surgeMinutes from the execute time", () => {
    expect(RAID_RULES.surgeMinutes).toBe(10);
    expect(raidSurgeUntil(NOW).toISOString()).toBe("2026-11-01T12:10:00.000Z");
  });
});

describe("the carry window (RAID_RULES.carryMinutes)", () => {
  const edge = RAID_RULES.carryMinutes * 60_000;
  test("starts carryMinutes before now", () => {
    expect(RAID_RULES.carryMinutes).toBe(10);
    expect(carryWindowStart(NOW).toISOString()).toBe("2026-11-01T11:50:00.000Z");
  });
  test.each([
    ["now", 0, true],
    ["a second ago", -1_000, true],
    ["exactly carryMinutes ago", -edge, true],
    ["one millisecond past the edge", -edge - 1, false],
    ["an hour ago", -3_600_000, false],
    ["just after now (clock skew)", 2_000, true],
  ] as const)("last seen %s → %s", (_name, offset, carries) => {
    expect(inCarryWindow(at(offset), NOW)).toBe(carries);
  });
});

describe("raidCarrySeconds: the target's surge gate", () => {
  test.each([
    [0, 60],
    [30, 60],
    [60, 60],
    [61, 61],
    [300, 300],
    [3600, 3600],
    [-5, 60],
    [90.7, 90],
  ])("minVerifiedWatchSeconds %s → %s", (own, s) => {
    expect(raidCarrySeconds(own)).toBe(s);
    expect(raidCarrySeconds(own)).toBeGreaterThanOrEqual(RAID_SURGE_GATE_SECONDS);
  });
});

describe("raidCarryValue", () => {
  test("a current source value carries: the target's broadcast, its surge gate, the source's fallback flag", () => {
    for (const f of [0, 1] as const) {
      const v = raidCarryValue({ b: SRC_B, s: 12, f }, SRC_B, DST_B, 0);
      expect(v).toEqual({ b: DST_B, s: 60, f });
      expect(VerifiedWatchValue.parse(v)).toEqual(v);
    }
  });
  test("never below the target's own gate", () => {
    expect(raidCarryValue({ b: SRC_B, s: 4000, f: 0 }, SRC_B, DST_B, 300)).toEqual({ b: DST_B, s: 300, f: 0 });
  });
  test("an unverified raider (no source value) carries nothing", () => {
    expect(raidCarryValue(null, SRC_B, DST_B, 0)).toBeNull();
  });
  test("a value for another source broadcast is stale and carries nothing", () => {
    expect(raidCarryValue({ b: DST_B, s: 600, f: 0 }, SRC_B, DST_B, 0)).toBeNull();
  });
});

describe("raidCarryTtlSeconds", () => {
  test("the surge's remaining time plus the override's 60 s grace", () => {
    expect(raidCarryTtlSeconds(raidSurgeUntil(NOW), NOW)).toBe(RAID_RULES.surgeMinutes * 60 + 60);
    expect(raidCarryTtlSeconds(at(1_500), NOW)).toBe(62);
  });
  test("an extended surge carries for its whole length", () => {
    expect(raidCarryTtlSeconds(at(25 * 60_000), NOW)).toBe(25 * 60 + 60);
  });
  test("at least one second", () => {
    expect(raidCarryTtlSeconds(at(-120_000), NOW)).toBe(1);
  });
});

describe("surgeRaidOf", () => {
  const override = { state: "on", since: NOW.toISOString(), until: at(600_000).toISOString(), by: null };
  test("reads the raid beside the override's fields, and fits chat.surge.state.raid", () => {
    const raid = surgeRaidOf(JSON.stringify({ ...override, raid: { fromChannel: "src", verifiedCount: 3 } }));
    expect(raid).toEqual({ fromChannel: "src", verifiedCount: 3 });
    expect(
      SurgeState.parse({ state: "on", since: null, until: null, by: null, unavailable: false, raid }).raid,
    ).toEqual(raid);
  });
  test.each([
    ["absent", null],
    ["not JSON", "{"],
    ["a scalar", "3"],
    ["no raid", JSON.stringify(override)],
    ["raid null", JSON.stringify({ ...override, raid: null })],
    ["empty slug", JSON.stringify({ ...override, raid: { fromChannel: "", verifiedCount: 1 } })],
    ["negative count", JSON.stringify({ ...override, raid: { fromChannel: "s", verifiedCount: -1 } })],
    ["fractional count", JSON.stringify({ ...override, raid: { fromChannel: "s", verifiedCount: 1.5 } })],
    ["count as text", JSON.stringify({ ...override, raid: { fromChannel: "s", verifiedCount: "3" } })],
  ])("%s → null", (_name, raw) => {
    expect(surgeRaidOf(raw)).toBeNull();
  });
  test("zero verified viewers is a raid", () => {
    expect(surgeRaidOf(JSON.stringify({ raid: { fromChannel: "s", verifiedCount: 0 } }))).toEqual({
      fromChannel: "s",
      verifiedCount: 0,
    });
  });
});
