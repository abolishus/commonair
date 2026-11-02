// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { bulkStreamerHandle, bulkViewerHandle } from "../../src/seed/accounts.ts";
import {
  CHATTERS_PER_CHANNEL,
  CHAT_GAP_MS,
  LIVE_FIXED_ORDER,
  type LiveAvailable,
  type LiveChannel,
  type LiveDeps,
  MAX_START_FAILURES,
  type PublisherHandle,
  REQUIRED_LOGINS,
  liveRefusals,
  nextLine,
  planLive,
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
