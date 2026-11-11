// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The seed's unit scheduling: which units may run side by side, that a failure stops new units but
 * lets the running ones finish, and the estimate the seed shard's timing comment comes from.
 */
import { describe, expect, test } from "vite-plus/test";
import { selectUnits } from "../../src/seed/checkpoint.ts";
import type { SeedUnitName } from "../../src/seed/types.ts";
import { SEED_UNITS, graphSeconds, orderUnits, readyUnits, runUnits } from "../../src/seed/units.ts";

type U = { name: SeedUnitName; after: readonly SeedUnitName[] };
const u = (name: SeedUnitName, after: SeedUnitName[] = []): U => ({ name, after });
const deferred = () => {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

/** The real graph: who waits for whom. */
const GRAPH = Object.fromEntries(SEED_UNITS.map((x) => [x.name, [...x.after].sort()]));

/** CI's unit times (s) on the nightly of eeff9ecb (run 42215129857), all units one by one. */
const CI_SECONDS: Record<SeedUnitName, number> = {
  social: 12,
  interact: 37,
  money: 17,
  media: 234,
  safety: 99,
  coop: 160,
  platform: 15,
  // Overhaul wave 5: a handful of rows; not on the nightly yet.
  schedule: 1,
};

describe("the seed's dependency graph", () => {
  test("what each unit waits for, implicit data dependencies included", () => {
    expect(GRAPH).toEqual({
      social: [],
      interact: ["social"],
      money: ["interact", "social"],
      media: ["interact", "social"],
      safety: ["media", "social"],
      coop: ["money", "safety", "social"],
      platform: ["coop", "media", "safety", "social"],
      schedule: ["platform", "social"],
    });
  });

  test("the one-by-one order is the documented one (and checkpoints keep their meaning)", () => {
    expect(orderUnits(SEED_UNITS).map((x) => x.name)).toEqual([
      "social",
      "interact",
      "money",
      "media",
      "safety",
      "coop",
      "platform",
      "schedule",
    ]);
  });

  test("side by side, only money runs beside media", () => {
    const order = orderUnits(SEED_UNITS);
    const done = new Set<SeedUnitName>(["social", "interact"]);
    expect(readyUnits(order, done, done)).toEqual(["money", "media"]);
    // Every other step of the graph has a single unit ready.
    expect(readyUnits(order, new Set(), new Set())).toEqual(["social"]);
    const afterMedia = new Set<SeedUnitName>(["social", "interact", "media"]);
    expect(readyUnits(order, afterMedia, new Set([...afterMedia, "money"]))).toEqual(["safety"]);
    const afterSafety = new Set<SeedUnitName>([...afterMedia, "money", "safety"]);
    expect(readyUnits(order, afterSafety, afterSafety)).toEqual(["coop"]);
  });

  test("CI's times: one by one 575 s; money beside media saves its 17 s", () => {
    const serial = Object.values(CI_SECONDS).reduce((a, b) => a + b, 0);
    expect(serial).toBe(575);
    expect(graphSeconds(SEED_UNITS, CI_SECONDS)).toBe(serial - CI_SECONDS.money);
  });
});

describe("readyUnits", () => {
  test("a dependency outside the selection counts as done (a resume's earlier units)", () => {
    const sel = [u("safety", ["social", "media"]), u("coop", ["safety", "money"])];
    expect(readyUnits(sel, new Set(), new Set())).toEqual(["safety"]);
    expect(readyUnits(sel, new Set(["safety"]), new Set(["safety"]))).toEqual(["coop"]);
  });

  test("started units are never offered twice; an empty selection offers nothing", () => {
    expect(readyUnits([u("social")], new Set(), new Set(["social"]))).toEqual([]);
    expect(readyUnits([], new Set(), new Set())).toEqual([]);
  });

  test("works on a resume selection of the real graph", () => {
    const run = selectUnits(orderUnits(SEED_UNITS), "money").run;
    expect(readyUnits(run, new Set(), new Set()).sort()).toEqual(["media", "money"]);
  });
});

describe("graphSeconds", () => {
  test("a chain sums; parallel branches take the longest; missing times count as 0", () => {
    const g = [u("social"), u("interact", ["social"]), u("money", ["social"]), u("coop", ["interact", "money"])];
    expect(graphSeconds(g, { social: 10, interact: 30, money: 50, coop: 5 })).toBe(65);
    expect(graphSeconds(g, { social: 10 })).toBe(10);
    expect(graphSeconds([], {})).toBe(0);
  });

  test("throws on a cycle, as orderUnits does", () => {
    expect(() => graphSeconds([u("social", ["money"]), u("money", ["social"])], {})).toThrow(/cycle/);
  });
});

describe("runUnits", () => {
  test("one by one: in order, each after the previous one ended", async () => {
    const log: string[] = [];
    await runUnits(
      [u("social"), u("interact", ["social"]), u("money", ["social"])],
      async (x) => {
        log.push(`start ${x.name}`);
        await tick();
        log.push(`end ${x.name}`);
      },
      { concurrent: false },
    );
    expect(log).toEqual(["start social", "end social", "start interact", "end interact", "start money", "end money"]);
  });

  test("one by one: an aborted signal stops before the next unit, with its reason", async () => {
    const ac = new AbortController();
    const ran: string[] = [];
    const run = runUnits(
      [u("social"), u("interact")],
      async (x) => {
        ran.push(x.name);
        ac.abort(new Error("stop"));
      },
      { concurrent: false, signal: ac.signal },
    );
    await expect(run).rejects.toThrow("stop");
    expect(ran).toEqual(["social"]);
  });

  test("side by side: a unit starts as soon as all it waits for are done", async () => {
    const gates = new Map<SeedUnitName, ReturnType<typeof deferred>>();
    const started: SeedUnitName[] = [];
    const graph = [u("social"), u("interact", ["social"]), u("money", ["social"]), u("coop", ["interact", "money"])];
    const run = runUnits(
      graph,
      (x) => {
        started.push(x.name);
        const d = deferred();
        gates.set(x.name, d);
        return d.promise;
      },
      { concurrent: true },
    );
    await tick();
    expect(started).toEqual(["social"]);
    gates.get("social")?.resolve();
    await tick();
    expect(started).toEqual(["social", "interact", "money"]);
    gates.get("money")?.resolve();
    await tick();
    // coop still waits for interact.
    expect(started).toEqual(["social", "interact", "money"]);
    gates.get("interact")?.resolve();
    await tick();
    expect(started).toEqual(["social", "interact", "money", "coop"]);
    gates.get("coop")?.resolve();
    await run;
  });

  test("side by side: after a failure nothing new starts, running units finish, the first error wins", async () => {
    const gates = new Map<SeedUnitName, ReturnType<typeof deferred>>();
    const started: SeedUnitName[] = [];
    const finished: SeedUnitName[] = [];
    const graph = [u("social"), u("interact", ["social"]), u("money", ["social"]), u("coop", ["interact", "money"])];
    const run = runUnits(
      graph,
      async (x) => {
        started.push(x.name);
        const d = deferred();
        gates.set(x.name, d);
        await d.promise;
        finished.push(x.name);
      },
      { concurrent: true },
    );
    let settled = false;
    void run.catch(() => undefined).finally(() => (settled = true));
    await tick();
    gates.get("social")?.resolve();
    await tick();
    gates.get("interact")?.reject(new Error("interact broke"));
    await tick();
    // money is still running: the run waits for it.
    expect(settled).toBe(false);
    gates.get("money")?.reject(new Error("money broke too"));
    await expect(run).rejects.toThrow("interact broke");
    expect(started).toEqual(["social", "interact", "money"]);
    expect(finished).toEqual(["social"]);
  });

  test("side by side: a unit whose dependencies end after another unit failed never starts", async () => {
    const gates = new Map<SeedUnitName, ReturnType<typeof deferred>>();
    const started: SeedUnitName[] = [];
    // media waits only for money, so money ending after interact's failure makes it ready.
    const graph = [u("social"), u("interact", ["social"]), u("money", ["social"]), u("media", ["money"])];
    const run = runUnits(
      graph,
      (x) => {
        started.push(x.name);
        const d = deferred();
        gates.set(x.name, d);
        return d.promise;
      },
      { concurrent: true },
    );
    void run.catch(() => undefined);
    await tick();
    gates.get("social")?.resolve();
    await tick();
    gates.get("interact")?.reject(new Error("interact broke"));
    await tick();
    gates.get("money")?.resolve();
    await expect(run).rejects.toThrow("interact broke");
    expect(started).toEqual(["social", "interact", "money"]);
  });

  test("side by side: a unit that throws synchronously fails the run like a rejection", async () => {
    const run = runUnits(
      [u("social")],
      () => {
        throw new Error("sync");
      },
      { concurrent: true },
    );
    await expect(run).rejects.toThrow("sync");
  });

  test("side by side: an abort starts nothing more and rethrows its reason once the running unit ends", async () => {
    const ac = new AbortController();
    const started: SeedUnitName[] = [];
    await expect(
      runUnits(
        [u("social"), u("interact", ["social"])],
        async (x) => {
          started.push(x.name);
          ac.abort(new Error("aborted"));
          await tick();
        },
        { concurrent: true, signal: ac.signal },
      ),
    ).rejects.toThrow("aborted");
    expect(started).toEqual(["social"]);
  });

  test("side by side: an already-aborted signal runs nothing; no units is a no-op", async () => {
    const ac = new AbortController();
    ac.abort(new Error("early"));
    let ran = 0;
    await expect(
      runUnits([u("social")], async () => void ran++, { concurrent: true, signal: ac.signal }),
    ).rejects.toThrow("early");
    expect(ran).toBe(0);
    await expect(runUnits([], async () => undefined, { concurrent: true })).resolves.toBeUndefined();
  });
});
