// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Surge guard trigger and hysteresis (ADR 0015 decision 6). Pure, with the clock passed in. */
import { describe, expect, test } from "vite-plus/test";
import type { SurgeOverride } from "@commonair/contracts/internal";
import {
  decide,
  newSessionThreshold,
  overrideTtlSeconds,
  type SurgeCounts,
  surgeTrigger,
} from "../src/chat-gate/hysteresis.ts";

const NOW = new Date("2026-10-30T12:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
const counts = (over: Partial<SurgeCounts> = {}): SurgeCounts => ({
  newSessions: 0,
  trailingSessions: 0,
  judged: 0,
  unverified: 0,
  followBurst: false,
  ...over,
});
const on = (until: number, since = -5): SurgeOverride => ({
  state: "on",
  since: at(since),
  until: at(until),
  by: null,
});

describe("trigger", () => {
  test("threshold: max(20, 3 × the trailing rate per 2 minutes)", () => {
    expect(newSessionThreshold(0)).toBe(20);
    expect(newSessionThreshold(45)).toBe(20); // 6 per 2 min → 18
    expect(newSessionThreshold(75)).toBe(30); // 10 per 2 min → 30
    expect(newSessionThreshold(76)).toBe(31);
  });

  test("enough new sessions and enough of the judged ones unverified", () => {
    expect(surgeTrigger(counts({ newSessions: 20, judged: 10, unverified: 5 }), 0.5)).toBe("new_sessions");
    expect(surgeTrigger(counts({ newSessions: 19, judged: 10, unverified: 10 }), 0.5)).toBeNull();
    expect(surgeTrigger(counts({ newSessions: 40, judged: 10, unverified: 4 }), 0.5)).toBeNull();
    // Nothing old enough to judge yet: no trigger on the ratio.
    expect(surgeTrigger(counts({ newSessions: 40, judged: 0, unverified: 0 }), 0.5)).toBeNull();
    // A busy channel needs a bigger burst.
    expect(
      surgeTrigger(counts({ newSessions: 25, trailingSessions: 150, judged: 10, unverified: 10 }), 0.5),
    ).toBeNull();
  });

  test("a follow burst trips it alone", () => {
    expect(surgeTrigger(counts({ followBurst: true }), 0.5)).toBe("follow_burst");
  });
});

describe("hysteresis", () => {
  test("not active + trigger → begin with until = now + cooldown", () => {
    expect(decide({ now: NOW, current: null, open: false, trigger: "new_sessions", cooldownMinutes: 10 })).toEqual([
      {
        kind: "begin",
        trigger: "new_sessions",
        next: { state: "on", since: NOW.toISOString(), until: at(10), by: null },
      },
    ]);
  });

  test("not active, no trigger → nothing", () => {
    expect(decide({ now: NOW, current: null, open: false, trigger: null, cooldownMinutes: 10 })).toEqual([]);
  });

  test("active + trigger → extend until (keeps since and by), no new begin", () => {
    const cur = { ...on(3), by: "00000000-0000-7000-8000-000000000001" };
    expect(decide({ now: NOW, current: cur, open: true, trigger: "follow_burst", cooldownMinutes: 10 })).toEqual([
      { kind: "extend", next: { ...cur, until: at(10) } },
    ]);
    // Never shortens a longer until.
    expect(decide({ now: NOW, current: on(30), open: true, trigger: "new_sessions", cooldownMinutes: 10 })).toEqual([]);
  });

  test("active, no trigger: waits for until, then ends (cooldown)", () => {
    expect(decide({ now: NOW, current: on(1), open: true, trigger: null, cooldownMinutes: 10 })).toEqual([]);
    expect(decide({ now: NOW, current: on(0), open: true, trigger: null, cooldownMinutes: 10 })).toEqual([
      { kind: "end" },
    ]);
  });

  test("suppressed blocks a re-trigger before until", () => {
    const sup: SurgeOverride = { state: "suppressed", since: at(-1), until: at(5), by: null };
    expect(decide({ now: NOW, current: sup, open: false, trigger: "new_sessions", cooldownMinutes: 10 })).toEqual([]);
    const done = { ...sup, until: at(-1) };
    expect(decide({ now: NOW, current: done, open: false, trigger: null, cooldownMinutes: 10 })).toEqual([
      { kind: "clear" },
    ]);
    expect(
      decide({ now: NOW, current: done, open: false, trigger: "new_sessions", cooldownMinutes: 10 }).map((a) => a.kind),
    ).toEqual(["begin"]);
  });

  test("key gone without an end event → expired (then a begin if still triggered)", () => {
    expect(decide({ now: NOW, current: null, open: true, trigger: null, cooldownMinutes: 10 })).toEqual([
      { kind: "expired" },
    ]);
    expect(
      decide({ now: NOW, current: null, open: true, trigger: "follow_burst", cooldownMinutes: 10 }).map((a) => a.kind),
    ).toEqual(["expired", "begin"]);
  });

  test("the key's TTL is until − now + 60 s", () => {
    expect(overrideTtlSeconds(on(10), NOW)).toBe(660);
    expect(overrideTtlSeconds(on(-5), NOW)).toBe(1);
  });
});
