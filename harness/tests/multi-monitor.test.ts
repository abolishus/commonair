// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  type MonitorEntry,
  issuanceTick,
  issuanceTicks,
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

describe("issuanceTick", () => {
  test("ticks fire 10 s past the minute and sit mid-bucket, so drift either side stays in one tick", () => {
    const minute = 29_358_000 * 60_000;
    const tickAt = minute + 10_000;
    expect(issuanceTick(tickAt - 25_000)).toBe(issuanceTick(tickAt));
    expect(issuanceTick(tickAt + 25_000)).toBe(issuanceTick(tickAt));
    expect(issuanceTick(tickAt + 60_000)).toBe(issuanceTick(tickAt) + 1);
  });
});

describe("issuanceTicks", () => {
  const minute = 29_358_000 * 60_000;
  const at = (k: number, ms = 0) => minute + k * 60_000 + 10_000 + ms;
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

  test("one leader: both origins contend, one releases", () => {
    const ticks = issuanceTicks([
      set(at(0), "10.0.0.1", "o1"),
      set(at(0, 3), "10.0.0.2", "o2"),
      release(at(0, 40), "10.0.0.1", "o1"),
      { at: at(0, 41), client: "lua", args: ["DEL", "issuance:lock"] },
    ]);
    expect(ticks).toEqual([{ tick: issuanceTick(at(0)), contenders: ["10.0.0.1", "10.0.0.2"], leaders: ["o1"] }]);
  });

  test("two leaders in one tick: the second origin took the lock after the first released it", () => {
    const ticks = issuanceTicks([
      set(at(1), "10.0.0.1", "o1"),
      release(at(1, 20), "10.0.0.1", "o1"),
      set(at(1, 90), "10.0.0.2", "o2"),
      release(at(1, 120), "10.0.0.2", "o2", "evalsha"),
    ]);
    expect(ticks[0]?.leaders).toEqual(["o1", "o2"]);
  });

  test("ticks are separate, in order; other keys and plain SETs are ignored", () => {
    const ticks = issuanceTicks([
      set(at(3), "10.0.0.1", "o1"),
      set(at(2), "10.0.0.2", "o2"),
      { at: at(2, 5), client: "10.0.0.3:1", args: ["set", "issuance:lock", "x"] },
      { at: at(2, 6), client: "10.0.0.3:1", args: ["eval", RELEASE, "1", "worker:lock:integrity:x", "y"] },
      { at: at(2, 7), client: "10.0.0.3:1", args: ["get", "issuance:lock"] },
    ]);
    expect(ticks.map((t) => [t.tick - issuanceTick(at(0)), t.contenders, t.leaders])).toEqual([
      [2, ["10.0.0.2"], []],
      [3, ["10.0.0.1"], []],
    ]);
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
