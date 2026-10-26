// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  DOUBLE_LEADER_WINDOW_MS,
  type MonitorEntry,
  issuanceReport,
  parseMonitorLine,
  startMonitor,
} from "../src/multi/monitor.ts";

const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

describe("parseMonitorLine", () => {
  test("timestamp, client and quoted arguments", () => {
    expect(
      parseMonitorLine('+1761480070.123456 [0 10.89.42.7:51234] "set" "issuance:lock" "id-1" "PX" "50000" "NX"'),
    ).toEqual({
      at: 1761480070123,
      client: "10.89.42.7:51234",
      args: ["set", "issuance:lock", "id-1", "PX", "50000", "NX"],
    });
  });

  test("escaped quotes and backslashes inside arguments", () => {
    const e = parseMonitorLine(String.raw`1761480070.5 [0 127.0.0.1:1] "eval" "return \"a\\b\"" "0"`);
    expect(e?.args).toEqual(["eval", 'return "a\\b"', "0"]);
  });

  test("commands a script issues come from `lua`", () => {
    expect(parseMonitorLine('1761480070.000001 [0 lua] "DEL" "issuance:lock"')?.client).toBe("lua");
  });

  test("anything else is not an entry", () => {
    expect(parseMonitorLine("+OK")).toBeNull();
    expect(parseMonitorLine("")).toBeNull();
    expect(parseMonitorLine("1761480070.1 [0 x:1]")).toBeNull();
  });
});

describe("issuanceReport", () => {
  const t0 = 29_358_000 * 60_000 + 10_000;
  const set = (t: number, host: string, id: string): MonitorEntry => ({
    at: t,
    client: `${host}:4${id.length}`,
    args: ["set", "issuance:lock", id, "PX", "50000", "NX"],
  });
  const release = (t: number, host: string, id: string, cmd = "eval"): MonitorEntry => ({
    at: t,
    client: `${host}:5000`,
    args: [cmd, cmd === "eval" ? RELEASE : "f00d", "1", "issuance:lock", id],
  });
  /** An origin ticking every `every` ms from `start` for `n` ticks: SET then, if it leads, release. */
  const origin = (host: string, id: string, start: number, n: number, leads: (k: number) => boolean, every = 60_000) =>
    Array.from({ length: n }, (_, k) => {
      const at = start + k * every;
      return leads(k) ? [set(at, host, id), release(at + 40, host, id)] : [set(at, host, id)];
    }).flat();

  test("one leader: both origins contend, one releases each minute", () => {
    const r = issuanceReport(
      [
        ...origin("10.0.0.1", "o1", t0, 5, () => true),
        ...origin("10.0.0.2", "o2", t0 + 3, 5, () => false),
        { at: t0 + 41, client: "lua", args: ["DEL", "issuance:lock"] },
      ],
      { observedMs: 5 * 60_000 },
    );
    expect(r.contenders).toEqual(["10.0.0.1", "10.0.0.2"]);
    expect(r.leaders).toEqual(["o1"]);
    expect(r.maxLeadersInWindow).toBe(1);
    expect(r.doubled).toEqual([]);
    expect(r.releasesPerMinute).toBe(1);
  });

  test("leadership passing between ticks (a race won a minute later) is not a double", () => {
    // Aligned timers with jitter: o1 wins ticks 0 and 2, o2 wins 1 and 3, ~60 s apart.
    const r = issuanceReport(
      [
        release(t0, "10.0.0.1", "o1"),
        release(t0 + 59_200, "10.0.0.2", "o2"),
        release(t0 + 120_300, "10.0.0.1", "o1"),
        release(t0 + 179_900, "10.0.0.2", "o2"),
      ],
      { observedMs: 4 * 60_000 },
    );
    expect(r.leaders).toEqual(["o1", "o2"]);
    expect(r.maxLeadersInWindow).toBe(1);
    expect(r.releasesPerMinute).toBe(1);
  });

  test.each([1_000, 5_000, 15_000, 29_000, 30_000, 31_000, 45_000, 50_000, 59_000])(
    "two origins both computing, timers drifted %i ms apart, is a double whatever the drift",
    (drift) => {
      const r = issuanceReport(
        [...origin("10.0.0.1", "o1", t0, 4, () => true), ...origin("10.0.0.2", "o2", t0 + drift, 4, () => true)],
        { observedMs: 4 * 60_000 },
      );
      expect(r.maxLeadersInWindow).toBe(2);
      expect(r.doubled.length).toBeGreaterThan(0);
      expect(r.doubled[0]?.ids).toEqual(["o1", "o2"]);
      expect(r.releasesPerMinute).toBe(2);
    },
  );

  test("a drifting timer (one origin 26 s late on a long-running stack) with one leader stays single", () => {
    // Only the late origin's SET wins after the early one stops; contention alone is not a double.
    const r = issuanceReport(
      [...origin("10.0.0.1", "o1", t0, 3, () => true), ...origin("10.0.0.2", "o2", t0 + 26_000, 3, () => false)],
      { observedMs: 3 * 60_000 },
    );
    expect(r.maxLeadersInWindow).toBe(1);
    expect(r.contenders).toHaveLength(2);
  });

  test("a second leader right after the first released (same tick) is a double", () => {
    const r = issuanceReport(
      [
        set(t0, "10.0.0.1", "o1"),
        release(t0 + 20, "10.0.0.1", "o1"),
        set(t0 + 90, "10.0.0.2", "o2"),
        release(t0 + 120, "10.0.0.2", "o2", "evalsha"),
      ],
      { observedMs: 60_000 },
    );
    expect(r.doubled).toEqual([{ at: t0 + 20, ids: ["o1", "o2"] }]);
  });

  test("the window is half-open and configurable", () => {
    const entries = [release(t0, "a", "o1"), release(t0 + DOUBLE_LEADER_WINDOW_MS, "b", "o2")];
    expect(issuanceReport(entries, { observedMs: 60_000 }).maxLeadersInWindow).toBe(1);
    expect(
      issuanceReport(entries, { observedMs: 60_000, windowMs: DOUBLE_LEADER_WINDOW_MS + 1 }).maxLeadersInWindow,
    ).toBe(2);
  });

  test("other keys, plain SETs, lua-issued commands and order of arrival", () => {
    const r = issuanceReport(
      [
        release(t0 + 60_000, "10.0.0.1", "o1"),
        set(t0, "10.0.0.2", "o2"),
        { at: t0 + 5, client: "10.0.0.3:1", args: ["set", "issuance:lock", "x"] },
        { at: t0 + 6, client: "10.0.0.3:1", args: ["eval", RELEASE, "1", "worker:lock:integrity:x", "y"] },
        { at: t0 + 7, client: "10.0.0.3:1", args: ["get", "issuance:lock"] },
        { at: t0 + 8, client: "lua", args: ["eval", RELEASE, "1", "issuance:lock", "z"] },
        release(t0, "10.0.0.2", "o2"),
      ],
      { observedMs: 120_000 },
    );
    expect(r.contenders).toEqual(["10.0.0.2"]);
    expect(r.releases.map((x) => x.id)).toEqual(["o2", "o1"]);
    expect(r.releasesPerMinute).toBe(1);
  });

  test("nothing observed", () => {
    const r = issuanceReport([], { observedMs: 0 });
    expect(r).toEqual({
      releases: [],
      leaders: [],
      contenders: [],
      maxLeadersInWindow: 0,
      doubled: [],
      releasesPerMinute: null,
    });
  });
});

describe("startMonitor", () => {
  /** A fake Valkey: answers AUTH and MONITOR, then streams lines split mid-line across writes. */
  function fakeValkey(lines: string[], opts: { refuse?: boolean } = {}) {
    const received: string[] = [];
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, chunk) {
          const text = new TextDecoder().decode(chunk);
          received.push(text);
          if (text.includes("AUTH")) socket.write(opts.refuse ? "-WRONGPASS invalid password\r\n" : "+OK\r\n");
          if (text.includes("MONITOR") && !opts.refuse) {
            socket.write("+OK\r\n");
            const all = lines.map((l) => `+${l}\r\n`).join("");
            const cut = Math.floor(all.length / 2) + 1;
            socket.write(all.slice(0, cut));
            setTimeout(() => socket.write(all.slice(cut)), 5);
          }
        },
      },
    });
    return { server, received, url: `redis://:secret@127.0.0.1:${server.port}` };
  }

  test("authenticates, keeps only lines with a needle, and survives a split line", async () => {
    const f = fakeValkey([
      '1761480070.100000 [0 10.0.0.1:1] "set" "issuance:lock" "o1" "PX" "50000" "NX"',
      '1761480070.100001 [0 10.0.0.9:1] "publish" "bus:events" "{}"',
      '1761480070.140000 [0 10.0.0.1:1] "eval" "script" "1" "issuance:lock" "o1"',
    ]);
    try {
      const m = await startMonitor(f.url, ["issuance:lock"]);
      await new Promise((r) => setTimeout(r, 50));
      expect(m.entries.map((e) => e.args[0])).toEqual(["set", "eval"]);
      expect(f.received.join("")).toContain("$6\r\nsecret\r\n");
      expect(m.error).toBeNull();
      m.stop();
    } finally {
      f.server.stop(true);
    }
  });

  test("a refused AUTH rejects", async () => {
    const f = fakeValkey([], { refuse: true });
    try {
      await expect(startMonitor(f.url, ["x"], 1_000)).rejects.toThrow(/WRONGPASS/);
    } finally {
      f.server.stop(true);
    }
  });
});
