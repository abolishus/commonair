// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { BotConfig } from "@commonair/contracts/shapes";
import { commandList } from "../src/plugins/bot/engine.ts";
import { indexCommands } from "../src/plugins/bot/parse.ts";
import { type CommandDef, PartCache } from "../src/plugins/bot/state.ts";
import { standing } from "./fixtures.ts";

function counter() {
  let now = 0;
  const loads: string[] = [];
  const pending = new Map<string, (v: string) => void>();
  const cache = new PartCache<string>(
    (id) => {
      loads.push(id);
      return new Promise((resolve) => pending.set(id, resolve));
    },
    { ttlMs: 1_000, max: 3, now: () => now },
  );
  const settle = (id: string, v: string) => pending.get(id)?.(v);
  return { cache, loads, settle, tick: (ms: number) => (now += ms) };
}

describe("PartCache", () => {
  test("loads once while a load is in flight, then serves the cached value", async () => {
    const c = counter();
    const a = c.cache.get("a");
    const b = c.cache.get("a");
    c.settle("a", "v1");
    expect(await a).toBe("v1");
    expect(await b).toBe("v1");
    expect(await c.cache.get("a")).toBe("v1");
    expect(c.loads).toEqual(["a"]);
  });

  test("reloads after the TTL", async () => {
    const c = counter();
    const first = c.cache.get("a");
    c.settle("a", "v1");
    await first;
    c.tick(1_000);
    const second = c.cache.get("a");
    c.settle("a", "v2");
    expect(await second).toBe("v2");
    expect(c.loads).toEqual(["a", "a"]);
  });

  test("a drop during a load keeps the stale result out of the cache", async () => {
    const c = counter();
    const stale = c.cache.get("a");
    c.cache.drop("a");
    const fresh = c.cache.get("a");
    c.settle("a", "fresh");
    expect(await fresh).toBe("fresh");
    expect(c.loads).toEqual(["a", "a"]);
    // The first load resolves with whatever its caller gets, but never lands in the cache.
    void stale;
    expect(await c.cache.get("a")).toBe("fresh");
  });

  test("bounded: the oldest channel goes first", async () => {
    const c = counter();
    for (const id of ["a", "b", "c", "d"]) {
      const p = c.cache.get(id);
      c.settle(id, id);
      await p;
    }
    expect(c.cache.size).toBe(3);
    const again = c.cache.get("a");
    c.settle("a", "a2");
    expect(await again).toBe("a2");
  });

  test("retain evicts channels no longer hosted", async () => {
    const c = counter();
    for (const id of ["a", "b"]) {
      const p = c.cache.get(id);
      c.settle(id, id);
      await p;
    }
    c.cache.retain(new Set(["b"]));
    expect(c.cache.size).toBe(1);
  });

  test("retain during a dropped load does not let the stale value back in", async () => {
    const resolvers: ((v: string) => void)[] = [];
    const cache = new PartCache<string>(() => new Promise((resolve) => resolvers.push(resolve)), {
      ttlMs: 60_000,
      max: 10,
      now: () => 0,
    });
    const stale = cache.get("a");
    cache.drop("a");
    cache.retain(new Set());
    resolvers[0]?.("stale");
    expect(await stale).toBe("stale");
    expect(cache.size).toBe(0);
    const fresh = cache.get("a");
    resolvers[1]?.("fresh");
    expect(await fresh).toBe("fresh");
    expect(resolvers).toHaveLength(2);
  });
});

describe("commandList", () => {
  const cmd = (name: string, userLevel: CommandDef["userLevel"]): CommandDef => ({
    id: name,
    name,
    aliases: [],
    response: "x",
    userLevel,
    cooldownSeconds: 0,
    costPoints: 0,
  });
  const list = [cmd("hello", "everyone"), cmd("modonly", "moderator"), cmd("subs", "subscriber")];
  const commands = { index: indexCommands(list), list };

  test("only what the caller's level can use, plus the active built-ins", () => {
    const config = BotConfig.parse({ songRequests: { enabled: true, maxQueue: 5 } });
    expect(commandList(commands, { standing: standing() }, { botUserId: "b", config })).toBe(
      "Commands: !hello !points !sr !commands",
    );
    expect(commandList(commands, { standing: standing({ isModerator: true }) }, { botUserId: "b", config })).toBe(
      "Commands: !hello !modonly !subs !points !sr !commands",
    );
  });

  test("points off hides !points; cut to whole entries", () => {
    const config = BotConfig.parse({ loyalty: { enabled: false, pointsName: "p" } });
    const many = Array.from({ length: 100 }, (_, i) => cmd(`command_${String(i).padStart(3, "0")}`, "everyone"));
    const out = commandList(
      { index: indexCommands(many), list: many },
      { standing: standing() },
      { botUserId: "b", config },
    );
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).not.toContain("!points");
    expect(out.endsWith("!command_")).toBe(false);
  });

  test("a command with a cost is listed only while loyalty is on", () => {
    const paid = [cmd("free", "everyone"), { ...cmd("paid", "everyone"), costPoints: 10 }];
    const set = { index: indexCommands(paid), list: paid };
    const off = BotConfig.parse({ loyalty: { enabled: false, pointsName: "p" } });
    const on = BotConfig.parse({ loyalty: { enabled: true, pointsName: "p" } });
    expect(commandList(set, { standing: standing() }, { botUserId: "b", config: off })).toBe(
      "Commands: !free !commands",
    );
    expect(commandList(set, { standing: standing() }, { botUserId: "b", config: on })).toBe(
      "Commands: !free !paid !points !commands",
    );
  });
});
