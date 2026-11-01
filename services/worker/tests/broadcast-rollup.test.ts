// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The rollup's pure parts: minute bucketing, verdict classes and categories, the cost rounding. */
import { describe, expect, test } from "vite-plus/test";
import {
  classifySession,
  marginalCostCents,
  minutesOf,
  peakConcurrent,
  rollUp,
  type RollupSession,
  sessionWindow,
  windowSeconds,
} from "../src/jobs/broadcast-rollup.ts";

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const at = (minutes: number, seconds = 0) => new Date(T0 + minutes * 60_000 + seconds * 1000);
const broadcast = { startedAt: at(0), endedAt: at(10) };

function session(over: Partial<RollupSession> = {}): RollupSession {
  return {
    startedAt: at(1),
    endedAt: at(3),
    assignedSource: "origin",
    verdict: "verified",
    verdictReasons: [],
    scoredAt: at(2),
    ...over,
  };
}

describe("minute bucketing", () => {
  test("a session spanning minute edges is in every minute it touches", () => {
    const w = sessionWindow(session({ startedAt: at(1, 30), endedAt: at(3, 10) }), broadcast);
    expect(minutesOf(w)).toEqual([at(1), at(2), at(3)].map((d) => d.getTime()));
    expect(windowSeconds(w)).toBe(100);
  });

  test("ending exactly on a minute boundary does not touch the next minute", () => {
    const w = sessionWindow(session({ startedAt: at(1), endedAt: at(3) }), broadcast);
    expect(minutesOf(w)).toEqual([at(1).getTime(), at(2).getTime()]);
  });

  test("a zero-length session has no minutes and no seconds", () => {
    const w = sessionWindow(session({ startedAt: at(4), endedAt: at(4) }), broadcast);
    expect(minutesOf(w)).toEqual([]);
    expect(windowSeconds(w)).toBe(0);
  });

  test("a session still open at the broadcast end is clipped there", () => {
    const w = sessionWindow(session({ startedAt: at(9, 30), endedAt: null }), broadcast);
    expect(w).toEqual({ start: at(9, 30).getTime(), end: at(10).getTime() });
    expect(minutesOf(w)).toEqual([at(9).getTime()]);
  });

  test("anything before the start or after the end is clipped; a session wholly outside is empty", () => {
    expect(windowSeconds(sessionWindow(session({ startedAt: at(-2), endedAt: at(1) }), broadcast))).toBe(60);
    expect(windowSeconds(sessionWindow(session({ startedAt: at(9), endedAt: at(15) }), broadcast))).toBe(60);
    const after = sessionWindow(session({ startedAt: at(11), endedAt: at(12) }), broadcast);
    expect(minutesOf(after)).toEqual([]);
    expect(windowSeconds(after)).toBe(0);
  });

  test("seconds are floored per session", () => {
    const w = sessionWindow(session({ startedAt: at(1), endedAt: new Date(at(1).getTime() + 1999) }), broadcast);
    expect(windowSeconds(w)).toBe(1);
  });
});

describe("verdict classes", () => {
  test("verified only when gate-eligible: scored and its fetches judged", () => {
    expect(classifySession(session())).toEqual({ kind: "verified" });
    expect(classifySession(session({ scoredAt: null }))).toEqual({ kind: "unverified" });
    expect(classifySession(session({ verdictReasons: ["fetch_unjudged"] }))).toEqual({ kind: "unverified" });
    expect(classifySession(session({ verdict: "pending", verdictReasons: ["insufficient_heartbeats"] }))).toEqual({
      kind: "unverified",
    });
  });

  test("an excluded session takes its first signal reason's category", () => {
    const ex = (verdictReasons: string[]) => classifySession(session({ verdict: "excluded", verdictReasons }));
    expect(ex(["datacenter_ip", "headless", "fetch_pattern"])).toEqual({ kind: "excluded", category: "datacenter" });
    expect(ex(["headless", "datacenter_ip"])).toEqual({ kind: "excluded", category: "automation" });
    // Non-signal reasons are skipped, whatever their position.
    expect(ex(["allowed_on_appeal", "device_concurrency", "headless"])).toEqual({
      kind: "excluded",
      category: "concurrency",
    });
    expect(ex(["fetch_pattern"])).toEqual({ kind: "excluded", category: "playback_pattern" });
    expect(ex([])).toEqual({ kind: "excluded", category: "other" });
    expect(ex(["retired_code"])).toEqual({ kind: "excluded", category: "other" });
  });
});

describe("rollUp", () => {
  test("totals are the sums of per-session seconds; unverified is kept apart", () => {
    const sessions = [
      session({ startedAt: at(0), endedAt: at(2) }), // verified 120 s, minutes 0-1
      session({ startedAt: at(1), endedAt: at(2), assignedSource: "relay" }), // verified 60 s, minute 1
      session({ verdict: "pending", startedAt: at(1), endedAt: at(4) }), // unverified 180 s
      session({ verdictReasons: ["fetch_unjudged"], assignedSource: "cdn", startedAt: at(5), endedAt: at(6) }),
      session({ verdict: "excluded", verdictReasons: ["datacenter_ip"], startedAt: at(1), endedAt: at(3) }),
      session({ verdict: "excluded", verdictReasons: ["headless"], startedAt: at(2), endedAt: at(2, 30) }),
      session({ startedAt: at(4), endedAt: at(4) }), // zero length: counts nowhere
      session({ verdict: "excluded", verdictReasons: ["headless"], startedAt: at(12), endedAt: at(13) }), // outside
    ];
    const { minutes, totals } = rollUp(broadcast, sessions);
    expect(totals).toEqual({
      durationSeconds: 600,
      sessions: 6,
      peakVerifiedConcurrent: 2,
      verifiedViewerSeconds: 180,
      unverifiedViewerSeconds: 240,
      excludedViewerSeconds: 150,
      excludedSecondsByCategory: { datacenter: 120, automation: 30 },
      excludedSessionsByCategory: { datacenter: 1, automation: 1 },
      verifiedSecondsBySource: { origin: 120, relay: 60 },
    });
    const m1 = minutes.find((m) => m.minute.getTime() === at(1).getTime());
    expect(m1).toEqual({
      minute: at(1),
      verified: 2,
      unverified: 1,
      excluded: 1,
      excludedByCategory: { datacenter: 1 },
      verifiedBySource: { origin: 1, relay: 1 },
      rawBySource: { origin: 3, relay: 1 },
    });
    expect(minutes.map((m) => m.minute.getTime())).toEqual([0, 1, 2, 3, 5].map((n) => at(n).getTime()));
    // The fetch-unjudged CDN session is raw CDN delivery, never verified CDN delivery.
    expect(minutes.at(-1)).toMatchObject({ verified: 0, unverified: 1, rawBySource: { cdn: 1 }, verifiedBySource: {} });
  });

  test("the peak is concurrency at an instant, not sessions per minute", () => {
    // A reconnect inside one minute: two sessions in minute 1 that never overlap.
    const { minutes, totals } = rollUp(broadcast, [
      session({ startedAt: at(1), endedAt: at(1, 20) }),
      session({ startedAt: at(1, 20), endedAt: at(1, 50) }),
    ]);
    expect(minutes[0]).toMatchObject({ minute: at(1), verified: 2 });
    expect(totals.peakVerifiedConcurrent).toBe(1);
  });

  test("only verified sessions make the peak", () => {
    const { totals } = rollUp(broadcast, [
      session({ startedAt: at(1), endedAt: at(5) }),
      session({ startedAt: at(2), endedAt: at(4) }),
      session({ verdict: "pending", startedAt: at(2), endedAt: at(4) }),
      session({ verdict: "excluded", verdictReasons: ["headless"], startedAt: at(2), endedAt: at(4) }),
    ]);
    expect(totals.peakVerifiedConcurrent).toBe(2);
  });

  test("a group is never made of sub-second reconnects", () => {
    const blips = Array.from({ length: 6 }, (_, i) =>
      session({
        verdict: "excluded",
        verdictReasons: ["headless"],
        startedAt: at(2, i),
        endedAt: new Date(at(2, i).getTime() + 500),
      }),
    );
    const { minutes, totals } = rollUp(broadcast, blips);
    expect(totals).toMatchObject({ sessions: 0, excludedSessionsByCategory: {}, excludedViewerSeconds: 0 });
    expect(minutes).toEqual([]);
  });

  test("no sessions: no minutes, zero totals", () => {
    const { minutes, totals } = rollUp(broadcast, []);
    expect(minutes).toEqual([]);
    expect(totals).toMatchObject({ sessions: 0, peakVerifiedConcurrent: 0, verifiedViewerSeconds: 0 });
  });
});

describe("marginal cost", () => {
  const GB = 1_000_000_000;

  test("zero when the model prices nothing", () => {
    expect(marginalCostCents({ origin: 50 * GB, relay: 10 * GB }, { centsPerGb: {} })).toBe(0);
    expect(marginalCostCents({}, { centsPerGb: { origin: 2 } })).toBe(0);
  });

  test("a source missing from the model, or with no bytes (CDN off), costs nothing", () => {
    expect(marginalCostCents({ origin: 3 * GB, p2p: 100 * GB }, { centsPerGb: { origin: 2 } })).toBe(6);
    expect(marginalCostCents({ origin: 3 * GB }, { centsPerGb: { origin: 2, cdn: 5 } })).toBe(6);
  });

  test("rounded once at the total, half-up", () => {
    // 0.4 + 0.4 cents: per-source rounding would give 0; the total rounds to 1.
    expect(marginalCostCents({ origin: GB / 5, relay: GB / 5 }, { centsPerGb: { origin: 2, relay: 2 } })).toBe(1);
    expect(marginalCostCents({ origin: GB / 2 }, { centsPerGb: { origin: 1 } })).toBe(1); // 0.5 → 1
    expect(marginalCostCents({ origin: GB / 2 - 1 }, { centsPerGb: { origin: 1 } })).toBe(0); // just under 0.5
    expect(marginalCostCents({ origin: 3 * GB }, { centsPerGb: { origin: 0.5 } })).toBe(2); // 1.5 → 2
  });

  test("exact for large byte counts and fractional rates", () => {
    // 9 PB at 0.123456 c/GB = 1,111,104 cents exactly, beyond float-safe products.
    expect(marginalCostCents({ origin: 9_000_000 * GB }, { centsPerGb: { origin: 0.123456 } })).toBe(1_111_104);
  });
});

describe("peakConcurrent", () => {
  const w = (start: number, end: number) => ({ start, end });
  test("empty, and empty windows, give 0", () => {
    expect(peakConcurrent([])).toBe(0);
    expect(peakConcurrent([w(5, 5), w(7, 3)])).toBe(0);
  });
  test("back-to-back windows do not overlap; nested and staggered ones do", () => {
    expect(peakConcurrent([w(0, 10), w(10, 20), w(20, 30)])).toBe(1);
    expect(peakConcurrent([w(0, 100), w(10, 20), w(15, 30), w(25, 40)])).toBe(3);
    expect(peakConcurrent([w(0, 10), w(0, 10), w(9, 11)])).toBe(3);
  });
  test("order of input does not matter", () => {
    expect(peakConcurrent([w(25, 40), w(15, 30), w(0, 100), w(10, 20)])).toBe(3);
  });
});
