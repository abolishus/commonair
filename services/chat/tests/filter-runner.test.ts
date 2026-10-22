// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from "vite-plus/test";
import { type CompiledFilter, compileFilters } from "../src/content.ts";
import { type HoldReason, WorkerFilterRunner, type WorkerFilterRunnerOptions } from "../src/filter-runner.ts";
import type { WordFilterDef } from "../src/types.ts";

const def = (over: Partial<WordFilterDef>): WordFilterDef => ({
  id: "f",
  pattern: "x",
  isRegex: true,
  action: "block",
  replacement: null,
  ...over,
});

/**
 * A pattern the validator would refuse, compiled directly to stand in for anything that slips
 * past it: exponential backtracking on "aaaa…!" keeps a single exec busy for far longer than
 * any budget. Each id is a distinct filter set.
 */
const evil = (id = "evil"): CompiledFilter[] => [{ def: def({ id, pattern: "(a+)+$" }), re: /(a+)+$/giu }];
const evilBody = `${"a".repeat(34)}!`;

const typical = compileFilters([
  def({ id: "b1", pattern: "\\bbadword\\b" }),
  def({ id: "b2", pattern: "f+u+c+k+" }),
  def({ id: "b3", pattern: "discord\\.gg/\\w+" }),
  def({ id: "b4", pattern: "free\\s(?:nitro|robux|vbucks)" }),
  def({ id: "b5", pattern: "[a-z0-9._-]+@[a-z0-9-]+\\.[a-z]{2,6}" }),
  def({ id: "h1", pattern: "\\bcrypto\\b.*\\bgiveaway\\b", action: "hold" }),
  def({ id: "r1", pattern: "darn", isRegex: false, action: "replace" }),
  def({ id: "r2", pattern: "s[e3]x+y", action: "replace", replacement: "[removed]" }),
]);

let runner: WorkerFilterRunner | null = null;
afterEach(async () => {
  await runner?.close();
  runner = null;
});

/** A runner that records why messages were held. */
function make(opts: WorkerFilterRunnerOptions = {}) {
  const reasons: HoldReason[] = [];
  let quarantines = 0;
  let zombies = 0;
  let maxZombies = 0;
  const r = new WorkerFilterRunner({
    ...opts,
    hooks: {
      held: (reason) => reasons.push(reason),
      quarantined: () => quarantines++,
      zombies: (d) => {
        zombies += d;
        maxZombies = Math.max(maxZombies, zombies);
      },
    },
  });
  runner = r;
  return { r, reasons, quarantines: () => quarantines, maxZombies: () => maxZombies };
}

const HELD = { action: "hold", timedOut: true };
/**
 * For tests about outcomes, not timing. The production hard timeout is the filter budget plus
 * 25 ms, so one scheduling stall while other suites run in parallel would hold a message.
 */
const UNHURRIED = { hardTimeoutMs: 2_000, maxQueueWaitMs: 2_000 };

describe("WorkerFilterRunner", () => {
  test("runs filters in a worker with the same outcomes as inline", async () => {
    const { r } = make(UNHURRIED);
    expect(await r.run("hello there", typical)).toEqual({ action: "pass", body: "hello there", filterId: null });
    expect(await r.run("join discord.gg/abc", typical)).toEqual({ action: "block", filterId: "b3" });
    expect(await r.run("darn crypto giveaway", typical)).toEqual({
      action: "hold",
      body: "**** crypto giveaway",
      filterId: "h1",
    });
  });

  test("a regex call past the hard timeout holds the message and the worker is replaced", async () => {
    const { r, reasons } = make({ workers: 1, hardTimeoutMs: 50 });
    const started = performance.now();
    expect(await r.run(evilBody, evil())).toEqual({ action: "hold", body: evilBody, filterId: null, timedOut: true });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(reasons).toEqual(["timeout"]);
    // The replacement worker serves the next message, which never waits on the stuck one.
    expect(await r.run("join discord.gg/abc", typical)).toEqual({ action: "block", filterId: "b3" });
  });

  test("a filter set that timed out is quarantined: held without running, logged once", async () => {
    // JavaScriptCore abandons the evil pattern after ~400 ms (it returns false), so the timeout
    // must sit well under that to trip; a tighter one would also catch the benign run at the end
    // when parallel suites stall the worker.
    const { r, reasons, quarantines } = make({ workers: 1, hardTimeoutMs: 250, quarantineMs: 300 });
    expect(await r.run(evilBody, evil())).toMatchObject(HELD);
    const started = performance.now();
    // Recompiled (a channel reload) but identical: same quarantine.
    expect(await r.run("aaa", evil())).toMatchObject(HELD);
    expect(await r.run("aaa", evil())).toMatchObject(HELD);
    // Far below the hard timeout: the quarantined set never reached a worker.
    expect(performance.now() - started).toBeLessThan(200);
    expect(reasons).toEqual(["timeout", "quarantined", "quarantined"]);
    expect(quarantines()).toBe(1);
    expect(r.threads()).toBeLessThanOrEqual(3);
    // Other channels' filters keep running.
    expect(await r.run("join discord.gg/abc", typical)).toEqual({ action: "block", filterId: "b3" });
    await Bun.sleep(350);
    // After the quarantine the set runs again.
    expect(await r.run("bbb", evil())).toEqual({ action: "pass", body: "bbb", filterId: null });
  });

  test("timeouts cannot multiply threads: live + zombie workers and respawns are capped", async () => {
    const { r, reasons, maxZombies } = make({
      workers: 1,
      maxZombies: 1,
      hardTimeoutMs: 30,
      maxQueueWaitMs: 100,
      respawnBurst: 2,
      respawnRefillMs: 60_000,
      zombieGraceMs: 60_000,
    });
    await r.run("warm", typical);
    let maxThreads = r.threads();
    const outcomes = [];
    for (let i = 0; i < 8; i++) {
      outcomes.push(await r.run(evilBody, evil(`e${i}`)));
      maxThreads = Math.max(maxThreads, r.threads());
    }
    for (const o of outcomes) expect(o).toMatchObject(HELD);
    expect(maxThreads).toBeLessThanOrEqual(2);
    // A live worker that times out becomes a zombie without adding a thread; respawns wait for room.
    expect(maxZombies()).toBeLessThanOrEqual(2);
    // With the cap reached and no respawn budget left, messages wait at most maxQueueWaitMs.
    expect(reasons.filter((x) => x === "timeout").length).toBeLessThanOrEqual(3);
    expect(reasons).toContain("queue_wait");
  });

  test("other workers keep serving while one is stuck", async () => {
    const { r } = make({ workers: 2, hardTimeoutMs: 300 });
    await r.run("warm", typical);
    const stuck = r.run(evilBody, evil());
    const started = performance.now();
    expect(await r.run("hello", typical)).toMatchObject({ action: "pass" });
    expect(performance.now() - started).toBeLessThan(250);
    expect(await stuck).toMatchObject(HELD);
  });

  test("a message waits at most maxQueueWaitMs for a worker", async () => {
    const { r, reasons } = make({ workers: 1, hardTimeoutMs: 2_000, maxQueueWaitMs: 100 });
    await r.run("warm", typical);
    const stuck = r.run(evilBody, evil());
    const started = performance.now();
    expect(await r.run("hello", typical)).toMatchObject(HELD);
    expect(performance.now() - started).toBeLessThan(500);
    expect(reasons).toEqual(["queue_wait"]);
    await r.close();
    expect(await stuck).toMatchObject(HELD);
  });

  test("queue caps: per filter set and overall", async () => {
    const { r, reasons } = make({ workers: 1, hardTimeoutMs: 2_000, maxQueueWaitMs: 2_000, maxQueuedPerSet: 2 });
    await r.run("warm", typical);
    const stuck = r.run(evilBody, evil()); // dispatched
    const queued = [r.run("one", typical), r.run("two", typical)];
    expect(await r.run("three", typical)).toMatchObject(HELD);
    expect(reasons).toEqual(["queue_full"]);
    await r.close();
    for (const p of [stuck, ...queued]) expect(await p).toMatchObject(HELD);
  });

  test("literal-only and empty filter sets run inline", async () => {
    const { r } = make({ workers: 1 });
    const literal = compileFilters([def({ pattern: "bad", isRegex: false })]);
    expect(await r.run("so bad", literal)).toEqual({ action: "block", filterId: "f" });
    expect(await r.run("anything", [])).toEqual({ action: "pass", body: "anything", filterId: null });
  });

  test("filter sets evicted from the worker cache are sent again", async () => {
    const { r } = make({ workers: 1, ...UNHURRIED });
    const sets = Array.from({ length: 300 }, (_, i) => compileFilters([def({ id: `s${i}`, pattern: `word${i}\\b` })]));
    for (const [i, set] of sets.entries()) expect(await r.run(`word${i}`, set)).toMatchObject({ action: "block" });
    expect(await r.run("word0", sets[0] ?? [])).toEqual({ action: "block", filterId: "s0" });
  });

  test("close holds pending messages", async () => {
    const { r } = make({ workers: 1, hardTimeoutMs: 5_000 });
    await r.run("warm", typical);
    const stuck = r.run(evilBody, evil());
    await r.close();
    expect(await stuck).toMatchObject(HELD);
    expect(await r.run("hello", typical)).toMatchObject(HELD);
  });

  test("latency for a typical filter set", async () => {
    const { r } = make();
    for (let i = 0; i < 200; i++) await r.run(`warm up ${i}`, typical);
    const samples: number[] = [];
    for (let i = 0; i < 2_000; i++) {
      const started = performance.now();
      await r.run(`a normal chat message, number ${i}, with a few words in it`, typical);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const at = (q: number) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))] ?? 0;
    if (process.env.CHAT_FILTER_BENCH)
      process.stderr.write(`filter worker p50 ${at(0.5).toFixed(3)} ms, p99 ${at(0.99).toFixed(3)} ms\n`);
    // Measured figures are in the README. The median catches a per-message regression; the tail only
    // a gross one, since parallel suites can stall the event loop for tens of milliseconds.
    expect(at(0.5)).toBeLessThan(2);
    expect(at(0.99)).toBeLessThan(50);
  });
});
