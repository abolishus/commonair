// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { mergeAllowances } from "../src/allowance.ts";
import { findSuperseded, type LiveSession, rankConcurrency, SUPERSEDE_DEFAULTS } from "../src/concurrency.ts";

const NOW = new Date("2026-03-01T12:00:00Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000);
const live = (id: string, o: Partial<LiveSession> & { start: number; seen?: number }): LiveSession => ({
  id,
  deviceHash: o.deviceHash ?? "dev",
  userId: o.userId ?? null,
  channelId: o.channelId ?? "ch",
  startedAt: ago(o.start),
  lastSeenAt: ago(o.seen ?? Math.min(o.start, 5)),
});

describe("findSuperseded (reload overlap)", () => {
  test("a reload: the old session stopped beating when the new one started, after the grace it is superseded", () => {
    const old = live("old", { start: 600, seen: 102 });
    const reload = live("new", { start: 100, seen: 3 });
    expect(findSuperseded([old, reload], NOW)).toEqual(new Set(["old"]));
  });

  test("within the grace period (> 60 s, throttled timers) nothing is decided yet", () => {
    expect(SUPERSEDE_DEFAULTS.graceMs).toBeGreaterThan(60_000);
    const old = live("old", { start: 600, seen: 95 });
    const reload = live("new", { start: 89, seen: 1 });
    expect(findSuperseded([old, reload], NOW).size).toBe(0);
    // Exactly at the grace boundary it is.
    expect(findSuperseded([old, live("new", { start: 90, seen: 1 })], NOW)).toEqual(new Set(["old"]));
    // With no grace (the counting rule), a quiet predecessor is set aside at once.
    expect(findSuperseded([old, reload], NOW, { ...SUPERSEDE_DEFAULTS, graceMs: 0 })).toEqual(new Set(["old"]));
  });

  test("a session whose last beat was hidden is never superseded (background tabs are throttled)", () => {
    const old = live("old", { start: 600, seen: 102 });
    const reload = live("new", { start: 100, seen: 3 });
    expect(findSuperseded([old, reload], NOW, SUPERSEDE_DEFAULTS, new Set(["old"])).size).toBe(0);
    expect(findSuperseded([old, reload], NOW, SUPERSEDE_DEFAULTS, new Set(["new"]))).toEqual(new Set(["old"]));
  });

  test("the final beat may race the new session's start by up to the slack", () => {
    const old = live("old", { start: 600, seen: 99 }); // beat 1 s after the new session started
    const reload = live("new", { start: 100, seen: 2 });
    expect(findSuperseded([old, reload], NOW)).toEqual(new Set(["old"]));
    const later = live("old2", { start: 600, seen: 97 }); // 3 s after: still beating
    expect(findSuperseded([later, reload], NOW).size).toBe(0);
  });

  test("two tabs that both keep beating are concurrent, not superseded", () => {
    const a = live("a", { start: 600, seen: 4 });
    const b = live("b", { start: 300, seen: 6 });
    expect(findSuperseded([a, b], NOW).size).toBe(0);
  });

  test("different channels or devices never supersede each other", () => {
    const old = live("old", { start: 600, seen: 62 });
    expect(findSuperseded([old, live("new", { start: 60, channelId: "other" })], NOW).size).toBe(0);
    expect(findSuperseded([old, live("new", { start: 60, deviceHash: "other" })], NOW).size).toBe(0);
  });

  test("a chain of reloads supersedes every predecessor; the newest survives", () => {
    const s1 = live("s1", { start: 900, seen: 602 });
    const s2 = live("s2", { start: 600, seen: 302 });
    const s3 = live("s3", { start: 300, seen: 2 });
    expect(findSuperseded([s3, s1, s2], NOW)).toEqual(new Set(["s1", "s2"]));
  });

  test("empty and single-session inputs", () => {
    expect(findSuperseded([], NOW).size).toBe(0);
    expect(findSuperseded([live("x", { start: 10 })], NOW).size).toBe(0);
  });
});

describe("rankConcurrency", () => {
  test("newest first per device; the reload is rank 1", () => {
    const sessions = [
      live("a", { start: 400 }),
      live("b", { start: 300 }),
      live("c", { start: 200 }),
      live("d", { start: 100 }),
    ];
    const r = rankConcurrency(sessions);
    expect(r.get("d")!.device).toEqual({ rank: 1, concurrent: 4 });
    expect(r.get("a")!.device).toEqual({ rank: 4, concurrent: 4 });
    expect(r.get("a")!.account).toBeNull();
  });

  test("superseded sessions are not counted and rank alone", () => {
    const sessions = [live("old", { start: 600, seen: 62 }), live("new", { start: 60 })];
    const r = rankConcurrency(sessions, new Set(["old"]));
    expect(r.get("new")!.device).toEqual({ rank: 1, concurrent: 1 });
    expect(r.get("old")!.device).toEqual({ rank: 1, concurrent: 1 });
  });

  test("accounts are ranked across devices; anonymous sessions have no account rank", () => {
    const sessions = [
      live("p", { start: 300, userId: "u", deviceHash: "d1" }),
      live("q", { start: 200, userId: "u", deviceHash: "d2" }),
      live("anon", { start: 100, deviceHash: "d3" }),
    ];
    const r = rankConcurrency(sessions);
    expect(r.get("q")!.account).toEqual({ rank: 1, concurrent: 2 });
    expect(r.get("p")!.account).toEqual({ rank: 2, concurrent: 2 });
    expect(r.get("p")!.device).toEqual({ rank: 1, concurrent: 1 });
    expect(r.get("anon")!.account).toBeNull();
  });

  test("ties on start time break by id deterministically", () => {
    const r = rankConcurrency([live("b", { start: 100 }), live("a", { start: 100 })]);
    expect(r.get("b")!.device.rank).toBe(1);
    expect(r.get("a")!.device.rank).toBe(2);
  });

  test("empty input", () => {
    expect(rankConcurrency([]).size).toBe(0);
  });
});

describe("mergeAllowances", () => {
  test("no decisions means no allowance", () => {
    expect(mergeAllowances([])).toBeNull();
  });
  test("unions the covered codes and takes the latest decision time", () => {
    expect(
      mergeAllowances([
        { at: new Date(1000), codes: ["headless", "datacenter_ip"] },
        { at: new Date(5000), codes: ["datacenter_ip", "fetch_pattern"] },
        { at: new Date(3000), codes: [] },
      ]),
    ).toEqual({ since: 5000, codes: ["datacenter_ip", "fetch_pattern", "headless"] });
  });
});
