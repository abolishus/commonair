// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `WatchGate` (ADR 0015) against an in-memory Valkey stand-in: flags, surge, caching, fail-open, attempts. */
import { describe, expect, test } from "vite-plus/test";
import { KEYS } from "@commonair/contracts/internal";
import type { Database } from "@commonair/db";
import type { ValkeyClient } from "@commonair/service";
import { MemoryLimiter } from "../src/limiter.ts";
import { createMetrics } from "../src/metrics.ts";
import { WatchGate, type WatchGateDeps } from "../src/watch-gate.ts";
import { channel, NOW, silentLogger } from "./fixtures.ts";

const BROADCAST = "00000000-0000-7000-8000-0000000000d1";
const OTHER = "00000000-0000-7000-8000-0000000000d2";
const USER = "00000000-0000-7000-8000-000000000001";

class FakeValkey {
  readonly data = new Map<string, string>();
  reads = 0;
  failing = false;
  async get(key: string): Promise<string | null> {
    this.reads++;
    if (this.failing) throw Object.assign(new Error("down"), { code: "ECONNREFUSED" });
    return this.data.get(key) ?? null;
  }
}

/** A database whose every select finds no rows (thresholds fall back to 7; nobody chatted before a surge). */
function emptyDb(): Database {
  const rows = () => Object.assign(Promise.resolve([]), { limit: () => Promise.resolve([]) });
  const chain = { select: () => chain, from: () => chain, where: rows };
  return chain as unknown as Database;
}

function setup(over: Partial<WatchGateDeps> = {}) {
  const valkey = new FakeValkey();
  let clock = NOW.getTime();
  let unavailable = 0;
  const metrics = { ...createMetrics(), watchGateUnavailable: () => void unavailable++ };
  const gate = new WatchGate({
    valkey: valkey as unknown as ValkeyClient,
    db: emptyDb(),
    limiter: new MemoryLimiter(() => clock),
    metrics,
    logger: silentLogger,
    enabled: { watchGate: true, surgeGuard: true },
    clock: () => clock,
    ...over,
  });
  return {
    gate,
    valkey,
    unavailable: () => unavailable,
    tick: (ms: number) => (clock += ms),
    watched: (s: number, b = BROADCAST, f: 0 | 1 = 0) =>
      valkey.data.set(KEYS.verifiedWatch(live().id, USER), JSON.stringify({ b, s, f })),
    surge: (state: "on" | "suppressed", since = new Date(NOW.getTime() - 60_000)) =>
      valkey.data.set(
        KEYS.surgeOverride(live().id),
        JSON.stringify({
          state,
          since: since.toISOString(),
          until: new Date(NOW.getTime() + 600_000).toISOString(),
          by: null,
        }),
      ),
  };
}

const live = (settings: Parameters<typeof channel>[0] = {}) =>
  channel({ minVerifiedWatchSeconds: 120, ...settings }, { liveBroadcastId: BROADCAST });

describe("WatchGate.load", () => {
  test("null when both instance flags are off, whatever the channel says", async () => {
    const { gate } = setup({ enabled: { watchGate: false, surgeGuard: false } });
    expect(await gate.load(live(), USER, NOW)).toBeNull();
  });

  test("null when the channel's gate is 0 and the guard is off for it", async () => {
    const { gate } = setup();
    expect(await gate.load(live({ minVerifiedWatchSeconds: 0 }), USER, NOW)).toBeNull();
  });

  test("null when the channel is offline (nothing to have watched)", async () => {
    const { gate } = setup();
    expect(await gate.load(channel({ minVerifiedWatchSeconds: 120 }), USER, NOW)).toBeNull();
  });

  test("the channel's gate with the key for the live broadcast", async () => {
    const s = setup();
    s.watched(150);
    expect(await s.gate.load(live(), USER, NOW)).toEqual({
      requiredSeconds: 120,
      verified: { broadcastId: BROADCAST, seconds: 150, fallback: false },
      surgeExempt: false,
      fallbackAccountAgeDays: 7,
      unavailable: false,
    });
  });

  test("a key for another broadcast reads as none; the fallback marker is carried", async () => {
    const s = setup();
    s.watched(900, OTHER);
    expect((await s.gate.load(live(), USER, NOW))?.verified).toBeNull();
    const t = setup();
    t.watched(900, BROADCAST, 1);
    expect((await t.gate.load(live(), USER, NOW))?.verified).toEqual({
      broadcastId: BROADCAST,
      seconds: 900,
      fallback: true,
    });
  });

  test("a saved gate is ignored while CHAT_WATCH_GATE is off", async () => {
    const s = setup({ enabled: { watchGate: false, surgeGuard: true } });
    const ch = live({ surgeGuard: { enabled: true, triggerUnverifiedRatio: 0.5, cooldownMinutes: 10 } });
    expect(await s.gate.load(ch, USER, NOW)).toBeNull();
    s.surge("on");
    s.gate.invalidate(ch.id);
    expect((await s.gate.load(ch, USER, NOW))?.requiredSeconds).toBe(60);
  });

  test("surge mode: max(own gate, 60); suppressed adds nothing", async () => {
    const guard = { surgeGuard: { enabled: true, triggerUnverifiedRatio: 0.5, cooldownMinutes: 10 } };
    const s = setup();
    s.surge("on");
    expect((await s.gate.load(live({ ...guard, minVerifiedWatchSeconds: 300 }), USER, NOW))?.requiredSeconds).toBe(300);
    expect(await s.gate.load(live({ ...guard, minVerifiedWatchSeconds: 0 }), USER, NOW)).toMatchObject({
      requiredSeconds: 60,
      surgeExempt: false,
    });
    const t = setup();
    t.surge("suppressed");
    expect(await t.gate.load(live({ ...guard, minVerifiedWatchSeconds: 0 }), USER, NOW)).toBeNull();
    // The guard off for the channel: its key is not read at all.
    const u = setup();
    u.surge("on");
    expect(await u.gate.load(live({ minVerifiedWatchSeconds: 0 }), USER, NOW)).toBeNull();
    expect(u.valkey.reads).toBe(0);
  });

  test("the verified-watch read is cached for 5 s", async () => {
    const s = setup();
    s.watched(30);
    expect((await s.gate.load(live(), USER, NOW))?.verified?.seconds).toBe(30);
    s.watched(200);
    expect((await s.gate.load(live(), USER, NOW))?.verified?.seconds).toBe(30);
    s.tick(5_001);
    expect((await s.gate.load(live(), USER, NOW))?.verified?.seconds).toBe(200);
  });

  test("Valkey errors fail open with a metric", async () => {
    const s = setup();
    s.valkey.failing = true;
    const r = await s.gate.load(live(), USER, NOW);
    expect(r).toMatchObject({ unavailable: true, requiredSeconds: 120, verified: null });
    expect(s.unavailable()).toBe(1);
    // A failed read is not cached: the next send reads again.
    s.valkey.failing = false;
    s.watched(130);
    expect(await s.gate.load(live(), USER, NOW)).toMatchObject({ unavailable: false, verified: { seconds: 130 } });
  });

  test("an override read error on a guard-only channel lets the message through (null)", async () => {
    const s = setup();
    s.valkey.failing = true;
    const ch = live({
      minVerifiedWatchSeconds: 0,
      surgeGuard: { enabled: true, triggerUnverifiedRatio: 0.5, cooldownMinutes: 10 },
    });
    expect(await s.gate.load(ch, USER, NOW)).toBeNull();
    expect(s.unavailable()).toBe(1);
  });
});

describe("WatchGate.surge", () => {
  const guarded = live({ surgeGuard: { enabled: true, triggerUnverifiedRatio: 0.5, cooldownMinutes: 10 } });

  test("on, suppressed, absent, flag off, error", async () => {
    const s = setup();
    expect(await s.gate.surge(guarded, NOW)).toEqual({ state: "off", until: null });
    s.surge("on");
    s.gate.invalidate(guarded.id);
    expect(await s.gate.surge(guarded, NOW)).toMatchObject({ state: "on" });
    s.surge("suppressed");
    s.gate.invalidate(guarded.id);
    expect(await s.gate.surge(guarded, NOW)).toMatchObject({ state: "suppressed" });
    const off = setup({ enabled: { watchGate: true, surgeGuard: false } });
    off.surge("on");
    expect(await off.gate.surge(guarded, NOW)).toEqual({ state: "off", until: null });
    const down = setup();
    down.valkey.failing = true;
    expect(await down.gate.surge(guarded, NOW)).toEqual({ state: "off", until: null });
  });

  test("the override is cached until invalidated", async () => {
    const s = setup();
    expect((await s.gate.surge(guarded, NOW)).state).toBe("off");
    s.surge("on");
    expect((await s.gate.surge(guarded, NOW)).state).toBe("off");
    s.gate.invalidate(guarded.id);
    expect((await s.gate.surge(guarded, NOW)).state).toBe("on");
  });
});

describe("WatchGate.denied", () => {
  test("six denials a minute pass through; the seventh becomes msg_ratelimit until the window moves", async () => {
    const s = setup();
    const r = { code: "msg_verified_watch" as const, text: "x" };
    const ch = live().id;
    for (let i = 0; i < 6; i++) expect(await s.gate.denied(ch, USER, r, NOW)).toBe(r);
    expect((await s.gate.denied(ch, USER, r, NOW)).code).toBe("msg_ratelimit");
    // Another channel has its own count.
    expect(await s.gate.denied(OTHER, USER, r, NOW)).toBe(r);
    s.tick(60_001);
    expect(await s.gate.denied(ch, USER, r, new Date(NOW.getTime() + 60_001))).toBe(r);
  });
});
