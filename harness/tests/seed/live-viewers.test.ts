// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `seed live`'s verified audience: who watches what, and each viewer's lifecycle on a fake clock. */
import { describe, expect, test } from "vite-plus/test";
import { bulkStreamerHandle, bulkViewerHandle } from "../../src/seed/accounts.ts";
import { DEFAULT_LIVE_CHANNELS, type LiveChannel, liveAvailable, planLive } from "../../src/seed/live.ts";
import {
  ARRIVAL_SPREAD_MS,
  BREAK_MS,
  HEALTH_CHECK_MS,
  type LiveWatcher,
  MAX_WATCHERS,
  MIN_WATCHERS,
  RETRY_MS,
  WATCH_SPAN_MS,
  type WatchSession,
  type WatcherDeps,
  planWatchers,
  runWatchers,
  superviseWatcher,
  watchersFor,
} from "../../src/seed/live-viewers.ts";
import { createRng } from "../../src/seed/prng.ts";
import { SEED_SCALES } from "../../src/seed/scale.ts";

const ch = (handle: string): LiveChannel => ({ handle, slug: `demo_${handle}` });
const STREAMERS = [
  "streamer1",
  "streamer2",
  "streamer3",
  "council1",
  "council2",
  ...Array.from({ length: 10 }, (_, i) => bulkStreamerHandle(i + 1)),
].map(ch);
const viewers = (n: number) => Array.from({ length: n }, (_, i) => bulkViewerHandle(i + 1));

function planFor(channels: number, pool: number, seed = 1) {
  const live = planLive(createRng(seed).fork("live"), { streamers: STREAMERS, viewers: viewers(pool) }, channels);
  const watchers = planWatchers(
    createRng(seed).fork("live").fork("watchers"),
    live.channels,
    viewers(pool),
    live.chatters,
  );
  return { live, watchers };
}
const perChannel = (ws: readonly LiveWatcher[]) => {
  const m = new Map<string, number>();
  for (const w of ws) m.set(w.channel, (m.get(w.channel) ?? 0) + 1);
  return m;
};

describe("planWatchers", () => {
  test("3–15 per live channel, busiest first, varied by channel", () => {
    const { live, watchers } = planFor(DEFAULT_LIVE_CHANNELS, SEED_SCALES.small.viewers);
    const counts = live.channels.map((c) => perChannel(watchers).get(c.slug) ?? 0);
    for (const n of counts) {
      expect(n).toBeGreaterThanOrEqual(MIN_WATCHERS);
      expect(n).toBeLessThanOrEqual(MAX_WATCHERS);
    }
    expect(counts[0]).toBeGreaterThan(counts[2] ?? 0);
    expect(new Set(counts).size).toBeGreaterThan(1);
  });

  test("counts per scale: the small pool covers the default channels; medium covers ten", () => {
    for (const [scale, channels] of [
      [SEED_SCALES.small, DEFAULT_LIVE_CHANNELS],
      [SEED_SCALES.medium, 10],
    ] as const) {
      const { live, watchers } = planFor(channels, scale.viewers);
      const wanted = live.channels.reduce((n, _c, rank) => n + watchersFor(rank, createRng(0)), 0);
      expect(watchers.length, `${scale.viewers} viewers`).toBeGreaterThanOrEqual(wanted - live.channels.length);
      expect(perChannel(watchers).size).toBe(live.channels.length);
    }
  });

  test("nobody watches two channels; a channel's chatters watch it", () => {
    const { live, watchers } = planFor(5, SEED_SCALES.small.viewers);
    expect(new Set(watchers.map((w) => w.handle)).size).toBe(watchers.length);
    // A chatter who watches at all watches the channel it chats in.
    const chatsIn = (h: string) => live.chatters.filter((c) => c.handle === h).map((c) => c.channel);
    const elsewhere = watchers.filter((w) => chatsIn(w.handle).length > 0 && !chatsIn(w.handle).includes(w.channel));
    expect(elsewhere).toEqual([]);
    const first = live.channels[0]?.slug;
    const chatters = live.chatters.filter((c) => c.channel === first).map((c) => c.handle);
    for (const h of chatters) expect(watchers.find((w) => w.handle === h)?.channel).toBe(first);
  });

  test("a short pool is shared out, never reused; no viewers means no watchers", () => {
    const { watchers } = planFor(5, 12);
    expect(watchers.length).toBeLessThanOrEqual(12);
    expect(new Set(watchers.map((w) => w.handle)).size).toBe(watchers.length);
    expect(planWatchers(createRng(1), STREAMERS.slice(0, 3), [], [])).toEqual([]);
  });

  test("deterministic per seed; only bulk viewers (restricted ones are never offered)", () => {
    expect(planFor(3, 50, 4).watchers).toEqual(planFor(3, 50, 4).watchers);
    const available = liveAvailable([
      { handle: "v00001", slug: "demo_v00001", restricted: true },
      { handle: "v00002", slug: "demo_v00002", restricted: false },
      { handle: "viewer1", slug: "demo_viewer1", restricted: false },
    ]);
    const ws = planWatchers(createRng(1), [ch("streamer1")], available.viewers, []);
    expect(ws.map((w) => w.handle)).toEqual(["v00002"]);
  });

  test("watchersFor stays within the bounds at every rank", () => {
    const r = createRng(3);
    for (let rank = 0; rank < 50; rank++) {
      const n = watchersFor(rank, r);
      expect(n).toBeGreaterThanOrEqual(MIN_WATCHERS);
      expect(n).toBeLessThanOrEqual(MAX_WATCHERS);
    }
    expect(watchersFor(0, createRng(1))).toBeGreaterThanOrEqual(MAX_WATCHERS - 1);
  });
});

/**
 * A fake clock: `sleep` advances virtual time at once (yielding a macrotask so the test can abort),
 * and sessions report healthy until told otherwise.
 */
function fakeClock(opts: { failStarts?: number; unhealthyAt?: number[] } = {}) {
  let now = 0;
  let failures = opts.failStarts ?? 0;
  const sleeps: number[] = [];
  const events: string[] = [];
  /** Sleeps, checks, starts and stops in order. */
  const timeline: string[] = [];
  const live = new Set<number>();
  let sessions = 0;
  const deps: WatcherDeps = {
    async startWatch(w) {
      if (failures > 0) {
        failures--;
        events.push("start failed");
        throw new Error("channel is offline");
      }
      const id = ++sessions;
      live.add(id);
      events.push(`start ${id} ${w.handle}`);
      timeline.push(`start ${id}`);
      let checks = 0;
      const s: WatchSession = {
        async healthy() {
          checks++;
          timeline.push("check");
          return !(opts.unhealthyAt?.includes(id) && checks >= 2);
        },
        async stop() {
          if (live.delete(id)) events.push(`stop ${id}`);
          timeline.push(`stop ${id}`);
        },
      };
      return s;
    },
    out: (l) => events.push(l),
    async sleep(ms, signal) {
      await new Promise((r) => setTimeout(r, 0));
      if (signal.aborted) throw new Error("aborted");
      sleeps.push(ms);
      timeline.push(`sleep ${ms}`);
      now += ms;
    },
    now: () => now,
  };
  return { deps, sleeps, events, timeline, live, sessions: () => sessions, now: () => now };
}

const W: LiveWatcher = { handle: "v00001", channel: "demo_streamer1", owner: "streamer1", seed: "streamer1:watch:0" };
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 5_000 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(cond()).toBe(true);
};

describe("superviseWatcher", () => {
  test("arrives within the spread, watches a span with health checks, takes a break, comes back", async () => {
    const f = fakeClock();
    const ac = new AbortController();
    const run = superviseWatcher(W, createRng(1), f.deps, ac.signal);
    await until(() => f.sessions() === 2);
    ac.abort();
    const stats = await run;
    expect(f.sleeps[0]).toBeLessThanOrEqual(ARRIVAL_SPREAD_MS);
    const startTwo = f.events.indexOf("start 2 v00001");
    expect(f.events.slice(0, startTwo)).toEqual(["start 1 v00001", "stop 1"]);
    // Session one: every wait is followed by a health check, and the waits add up to one span.
    const t = f.timeline;
    const first = t.slice(t.indexOf("start 1") + 1, t.indexOf("stop 1"));
    const waits = first.filter((e) => e.startsWith("sleep ")).map((e) => Number(e.slice(6)));
    expect(first.filter((e) => e === "check")).toHaveLength(waits.length);
    for (const ms of waits) expect(ms).toBeLessThanOrEqual(HEALTH_CHECK_MS);
    const span = waits.reduce((a, b) => a + b, 0);
    expect(span).toBeGreaterThanOrEqual(WATCH_SPAN_MS[0]);
    expect(span).toBeLessThanOrEqual(WATCH_SPAN_MS[1]);
    // Then one break before session two.
    const between = t.slice(t.indexOf("stop 1") + 1, t.indexOf("start 2"));
    expect(between).toHaveLength(1);
    const pause = Number(between[0]?.slice(6));
    expect(pause).toBeGreaterThanOrEqual(BREAK_MS[0]);
    expect(pause).toBeLessThanOrEqual(BREAK_MS[1]);
    expect(stats.spans).toBe(1);
    expect(stats.renewed).toBe(0);
    expect(f.live.size).toBe(0);
  });

  test("a session that stops getting media is renewed after a short wait", async () => {
    const f = fakeClock({ unhealthyAt: [1] });
    const ac = new AbortController();
    const run = superviseWatcher(W, createRng(1), f.deps, ac.signal);
    await until(() => f.sessions() === 2);
    ac.abort();
    const stats = await run;
    expect(stats.renewed).toBe(1);
    expect(f.events.slice(0, 3)).toEqual(["start 1 v00001", "stop 1", "start 2 v00001"]);
    // Two checks, then the retry wait before the new session.
    expect(f.sleeps.slice(1, 4)).toEqual([HEALTH_CHECK_MS, HEALTH_CHECK_MS, RETRY_MS]);
    expect(f.live.size).toBe(0);
  });

  test("a channel that is not live yet is retried quietly until it is", async () => {
    const f = fakeClock({ failStarts: 3 });
    const ac = new AbortController();
    const run = superviseWatcher(W, createRng(1), f.deps, ac.signal);
    await until(() => f.sessions() === 1);
    ac.abort();
    const stats = await run;
    expect(stats.failedStarts).toBe(3);
    expect(f.events.filter((e) => e.includes("did not start"))).toHaveLength(1);
    expect(f.sleeps.slice(1, 4)).toEqual([RETRY_MS, RETRY_MS, RETRY_MS]);
  });

  test("abort mid-session stops the session and resolves; abort before arrival starts nothing", async () => {
    const f = fakeClock();
    const ac = new AbortController();
    const run = superviseWatcher(W, createRng(1), f.deps, ac.signal);
    await until(() => f.live.size === 1);
    ac.abort();
    await run;
    expect(f.live.size).toBe(0);
    expect(f.events.at(-1)).toBe("stop 1");

    const g = fakeClock();
    const early = new AbortController();
    early.abort();
    expect(await superviseWatcher(W, createRng(1), g.deps, early.signal)).toEqual({
      sessions: 0,
      renewed: 0,
      spans: 0,
      failedStarts: 0,
    });
    expect(g.events).toEqual([]);
  });
});

describe("runWatchers", () => {
  test("every watcher starts, and seed live's abort stops each one cleanly", async () => {
    const { watchers } = planFor(DEFAULT_LIVE_CHANNELS, SEED_SCALES.small.viewers);
    const f = fakeClock();
    const ac = new AbortController();
    const run = runWatchers(watchers, createRng(1), f.deps, ac.signal);
    await until(() => f.live.size === watchers.length);
    ac.abort();
    const stats = await run;
    expect(f.live.size).toBe(0);
    expect(stats.sessions).toBeGreaterThanOrEqual(watchers.length);
    expect(f.events[0]).toMatch(new RegExp(`^seed live: ${watchers.length} seeded viewers watching`));
  });

  test("no watchers: nothing printed, resolves at once", async () => {
    const f = fakeClock();
    expect(await runWatchers([], createRng(1), f.deps, new AbortController().signal)).toEqual({
      sessions: 0,
      renewed: 0,
      spans: 0,
      failedStarts: 0,
    });
    expect(f.events).toEqual([]);
  });
});
