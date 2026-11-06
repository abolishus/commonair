// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { bulkStreamerHandle, bulkViewerHandle } from "../../src/seed/accounts.ts";
import {
  BYPASS_RENEW_MS,
  CHATTERS_PER_CHANNEL,
  CHAT_GAP_MS,
  COVERAGE_CHAT_GAP_MS,
  COVERAGE_LIVE_CHANNELS,
  LIVE_FIXED_ORDER,
  type LiveAvailable,
  type LiveChannel,
  type LiveDeps,
  MAX_START_FAILURES,
  type PublisherHandle,
  REQUIRED_LOGINS,
  fixedLiveSlugs,
  liveAvailable,
  liveRefusals,
  nextLine,
  planLive,
  renewUntilAborted,
  runLive,
} from "../../src/seed/live.ts";
import { createRng } from "../../src/seed/prng.ts";

const ch = (handle: string): LiveChannel => ({ handle, slug: `demo_${handle}` });
const AVAILABLE: LiveAvailable = {
  // Deliberately shuffled: the plan orders them.
  streamers: [
    ch(bulkStreamerHandle(3)),
    ch("council2"),
    ch(bulkStreamerHandle(1)),
    ch("streamer2"),
    ch("streamer1"),
    ch("council1"),
    ch("streamer3"),
    ch(bulkStreamerHandle(2)),
  ],
  viewers: Array.from({ length: 12 }, (_, i) => bulkViewerHandle(i + 1)),
};

describe("planLive", () => {
  test("fixed streamers first in their order, then bulk streamers by handle", () => {
    const p = planLive(createRng(1), AVAILABLE, 7);
    expect(p.channels.map((c) => c.handle)).toEqual([...LIVE_FIXED_ORDER, "s0001", "s0002"]);
    expect(p.short).toBe(0);
    expect(planLive(createRng(1), AVAILABLE, 2).channels.map((c) => c.handle)).toEqual(["streamer1", "streamer2"]);
  });

  test("deterministic: the same seed picks the same chatters", () => {
    expect(planLive(createRng(4), AVAILABLE, 3)).toEqual(planLive(createRng(4), AVAILABLE, 3));
    const a = planLive(createRng(4), AVAILABLE, 3).chatters.map((c) => c.handle);
    const b = planLive(createRng(5), AVAILABLE, 3).chatters.map((c) => c.handle);
    expect(a).not.toEqual(b);
  });

  test("each channel gets its chatters, spread over distinct bulk viewers", () => {
    const p = planLive(createRng(1), AVAILABLE, 4);
    for (const c of p.channels)
      expect(p.chatters.filter((x) => x.channel === c.slug)).toHaveLength(CHATTERS_PER_CHANNEL);
    expect(new Set(p.chatters.map((c) => c.handle)).size).toBe(12);
    expect(p.chatters.every((c) => /^v\d+$/.test(c.handle))).toBe(true);
  });

  test("asking for more channels than exist keeps them all and says how many were short", () => {
    const p = planLive(createRng(1), AVAILABLE, 20);
    expect(p.channels).toHaveLength(8);
    expect(p.short).toBe(12);
    expect(planLive(createRng(1), { streamers: AVAILABLE.streamers, viewers: [] }, 2).chatters).toEqual([]);
  });

  test("chat is bounded: every gap within the configured range", () => {
    const r = createRng(2);
    for (let i = 0; i < 200; i++) {
      const l = nextLine(r, "streamer1");
      expect(l.gapMs).toBeGreaterThanOrEqual(CHAT_GAP_MS[0]);
      expect(l.gapMs).toBeLessThanOrEqual(CHAT_GAP_MS[1]);
      expect(l.body).not.toContain("{c}");
    }
  });
});

describe("liveAvailable", () => {
  const login = (handle: string, restricted = false, slug: string | null = `demo_${handle}`) => ({
    handle,
    slug,
    restricted,
  });
  test("streamers: the fixed ones and bulk streamers with a channel; viewers: bulk viewers only", () => {
    const a = liveAvailable([
      login("streamer1"),
      login("council2"),
      login("s0001"),
      login("s0002", false, null),
      login("viewer1"),
      login("admin"),
      login("v00001"),
      login("v00002"),
    ]);
    expect(a.streamers.map((s) => s.handle)).toEqual(["streamer1", "council2", "s0001"]);
    expect(a.viewers).toEqual(["v00001", "v00002"]);
  });

  test("a restricted account never chats (suspended, deleting, chat-banned or blocked)", () => {
    const a = liveAvailable([login("v00001", true), login("v00002"), login("v00003", true)]);
    expect(a.viewers).toEqual(["v00002"]);
  });

  test("the restriction is the chatters' only: a fixed streamer still streams", () => {
    expect(liveAvailable([login("streamer1", true)]).streamers).toEqual([ch("streamer1")]);
  });

  test("no logins: nothing to stream, nobody to chat", () => {
    expect(liveAvailable([])).toEqual({ streamers: [], viewers: [], adults: [] });
  });

  test("a gated channel is marked; adults are the unrestricted bulk viewers who confirmed 18+", () => {
    const a = liveAvailable([
      { ...login("streamer1"), gated: false },
      { ...login("streamer3"), gated: true },
      { ...login("v00001"), adult: true },
      { ...login("v00002"), adult: false },
      { ...login("v00003", true), adult: true },
      login("v00004"),
      { ...login("viewer1"), adult: true },
    ]);
    expect(a.streamers).toEqual([ch("streamer1"), { ...ch("streamer3"), gated: true }]);
    expect(a.viewers).toEqual(["v00001", "v00002", "v00004"]);
    expect(a.adults).toEqual(["v00001"]);
  });
});

describe("the seed-coverage walk's live streams", () => {
  const channels = [
    { ownerHandle: "streamer2", slug: "aurora2" },
    { ownerHandle: "s0001", slug: "bulk1" },
    { ownerHandle: "streamer1", slug: "aurora1" },
    { ownerHandle: "streamer3", slug: "aurora3" },
  ];
  test("streamer1 and streamer2, in planLive's order", () => {
    expect(COVERAGE_LIVE_CHANNELS).toBeGreaterThanOrEqual(2);
    expect(fixedLiveSlugs(channels, COVERAGE_LIVE_CHANNELS)).toEqual(["aurora1", "aurora2"]);
    const plan = planLive(createRng(1), AVAILABLE, COVERAGE_LIVE_CHANNELS);
    expect(plan.channels.map((c) => c.handle)).toEqual(["streamer1", "streamer2"]);
  });

  test("bounded by what the store has", () => {
    expect(fixedLiveSlugs(channels, 9)).toEqual(["aurora1", "aurora2", "aurora3"]);
    expect(fixedLiveSlugs(channels, 0)).toEqual([]);
    expect(fixedLiveSlugs([], 2)).toEqual([]);
  });

  test("chat is fast enough that a page judged within seconds sees a line, and still bounded", () => {
    const r = createRng(3);
    const gaps = Array.from({ length: 200 }, () => nextLine(r, "streamer1", COVERAGE_CHAT_GAP_MS).gapMs);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(COVERAGE_CHAT_GAP_MS[0]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(COVERAGE_CHAT_GAP_MS[1]);
    // CHATTERS_PER_CHANNEL chatters: on average a line well inside DATA_GRACE_MS (10 s).
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    expect(mean / CHATTERS_PER_CHANNEL).toBeLessThan(2_000);
    // At least a second between one chatter's lines (the chat rate limit).
    expect(COVERAGE_CHAT_GAP_MS[0]).toBeGreaterThanOrEqual(1_000);
    expect(COVERAGE_CHAT_GAP_MS[1]).toBeLessThan(CHAT_GAP_MS[0]);
  });
});

describe("liveRefusals", () => {
  const ok = { seedFull: true, password: "pw", databaseUrl: "postgres://x/y", missingLogins: [] };
  test("runs only with the flag, the password and a full seed", () => {
    expect(liveRefusals(ok)).toEqual([]);
    expect(liveRefusals({ ...ok, seedFull: false })[0]).toMatch(/DEMO_SEED_FULL/);
    expect(liveRefusals({ ...ok, password: undefined })[0]).toMatch(/DEMO_SEED_PASSWORD/);
    expect(liveRefusals({ ...ok, databaseUrl: undefined })[0]).toMatch(/DATABASE_URL/);
    expect(liveRefusals({ ...ok, missingLogins: REQUIRED_LOGINS })[0]).toMatch(/no full seed/);
  });
  test("every fixed human login is required", () => {
    expect(REQUIRED_LOGINS).toContain("demo_streamer1");
    expect(REQUIRED_LOGINS).toContain("demo_admin");
    expect(REQUIRED_LOGINS).not.toContain("demo_bot1");
  });
});

/** A fake process runner: publishers that stay up until stopped, or die on demand. */
function fakeDeps(opts: { failStarts?: number; dieOnce?: string } = {}) {
  const running = new Set<string>();
  const starts = new Map<string, number>();
  const chatters = new Set<string>();
  const lines: string[] = [];
  let failures = opts.failStarts ?? 0;
  const deps: LiveDeps = {
    async startPublisher(c) {
      if (failures > 0) {
        failures--;
        throw new Error("ffmpeg missing");
      }
      const n = (starts.get(c.handle) ?? 0) + 1;
      starts.set(c.handle, n);
      const id = `${c.handle}#${n}`;
      running.add(id);
      let exit: (code: number) => void = () => undefined;
      const exited = new Promise<number>((resolve) => {
        exit = resolve;
      });
      if (opts.dieOnce === c.handle && n === 1)
        setTimeout(() => {
          running.delete(id);
          exit(1);
        }, 5);
      const handle: PublisherHandle = {
        exited,
        stop: async () => {
          running.delete(id);
          exit(0);
        },
      };
      return handle;
    },
    async startChatter(c) {
      const id = `${c.handle}@${c.channel}`;
      chatters.add(id);
      return {
        stop: async () => {
          chatters.delete(id);
        },
      };
    },
    watchUrl: (c) => `http://web.test/${c.slug}`,
    out: (l) => lines.push(l),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  };
  return { deps, running, starts, chatters, lines };
}

describe("runLive", () => {
  test("abort stops every publisher and chatter, exits 0, and printed the watch URLs", async () => {
    const plan = planLive(createRng(1), AVAILABLE, 3);
    const f = fakeDeps();
    const ctl = new AbortController();
    const run = runLive(plan, f.deps, ctl.signal);
    await new Promise((r) => setTimeout(r, 30));
    expect(f.running.size).toBe(3);
    expect(f.chatters.size).toBe(plan.chatters.length);
    ctl.abort();
    expect(await run).toBe(0);
    expect(f.running.size).toBe(0);
    expect(f.chatters.size).toBe(0);
    for (const c of plan.channels) expect(f.lines).toContain(`  http://web.test/${c.slug}`);
  });

  test("a publisher that dies is restarted", async () => {
    const plan = planLive(createRng(1), AVAILABLE, 2);
    const f = fakeDeps({ dieOnce: "streamer2" });
    const ctl = new AbortController();
    const run = runLive(plan, f.deps, ctl.signal);
    await new Promise((r) => setTimeout(r, 60));
    expect(f.starts.get("streamer2")).toBe(2);
    expect(f.starts.get("streamer1")).toBe(1);
    expect(f.lines.some((l) => /demo_streamer2: the publisher exited \(code 1\); restart #1/.test(l))).toBe(true);
    ctl.abort();
    expect(await run).toBe(0);
    expect(f.running.size).toBe(0);
  });

  test("a channel that never starts is given up and the run exits 1", async () => {
    const plan = planLive(createRng(1), AVAILABLE, 1);
    const f = fakeDeps({ failStarts: MAX_START_FAILURES });
    const ctl = new AbortController();
    const code = await runLive(plan, f.deps, ctl.signal);
    expect(code).toBe(1);
    expect(f.lines.some((l) => l.includes("giving up"))).toBe(true);
    expect(f.chatters.size).toBe(0);
  });

  test("no channels: exit 1 at once", async () => {
    const f = fakeDeps();
    expect(await runLive({ channels: [], chatters: [], short: 0 }, f.deps, new AbortController().signal)).toBe(1);
  });
});

describe("renewUntilAborted", () => {
  test("renews at once and every interval, well inside the bypass's one-hour TTL", async () => {
    expect(BYPASS_RENEW_MS).toBe(30 * 60_000);
    const ac = new AbortController();
    const calls: string[] = [];
    let renewals = 0;
    await renewUntilAborted(
      async () => {
        renewals++;
        calls.push("renew");
      },
      BYPASS_RENEW_MS,
      ac.signal,
      {
        out: (l) => calls.push(l),
        sleep: async (ms) => {
          calls.push(`sleep ${ms}`);
          if (renewals === 3) ac.abort();
        },
      },
    );
    expect(calls).toEqual([
      "renew",
      `sleep ${BYPASS_RENEW_MS}`,
      "renew",
      `sleep ${BYPASS_RENEW_MS}`,
      "renew",
      `sleep ${BYPASS_RENEW_MS}`,
    ]);
  });

  test("a failed renewal is reported and retried at the next tick, never thrown", async () => {
    const ac = new AbortController();
    const out: string[] = [];
    let n = 0;
    await renewUntilAborted(
      async () => {
        n++;
        if (n === 1) throw new Error("answered HTTP 503");
      },
      10,
      ac.signal,
      {
        out: (l) => out.push(l),
        sleep: async () => {
          if (n === 2) ac.abort();
        },
      },
    );
    expect(n).toBe(2);
    expect(out).toEqual(["seed live: renewing the analytics display bypass failed (answered HTTP 503)"]);
  });

  test("stops when the sleep is aborted, and does nothing once aborted", async () => {
    const ac = new AbortController();
    let n = 0;
    await renewUntilAborted(
      async () => {
        n++;
      },
      10,
      ac.signal,
      {
        out: () => undefined,
        sleep: async () => {
          ac.abort();
          throw new Error("aborted");
        },
      },
    );
    expect(n).toBe(1);
    await renewUntilAborted(async () => void n++, 10, ac.signal, {
      out: () => undefined,
      sleep: async () => undefined,
    });
    expect(n).toBe(1);
  });
});
