// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from "vite-plus/test";
import { type CompiledFilter, compileFilters } from "../src/content.ts";
import { WorkerFilterRunner } from "../src/filter-runner.ts";
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
 * any budget.
 */
const evil: CompiledFilter[] = [{ def: def({ id: "evil", pattern: "(a+)+$" }), re: /(a+)+$/giu }];
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

describe("WorkerFilterRunner", () => {
  test("runs filters in a worker with the same outcomes as inline", async () => {
    runner = new WorkerFilterRunner();
    expect(await runner.run("hello there", typical)).toEqual({ action: "pass", body: "hello there", filterId: null });
    expect(await runner.run("join discord.gg/abc", typical)).toEqual({ action: "block", filterId: "b3" });
    expect(await runner.run("darn crypto giveaway", typical)).toEqual({
      action: "hold",
      body: "**** crypto giveaway",
      filterId: "h1",
    });
  });

  test("a regex call past the hard timeout holds the message and the worker is replaced", async () => {
    const reasons: string[] = [];
    runner = new WorkerFilterRunner({ workers: 1, hardTimeoutMs: 50, onTimeout: (r) => reasons.push(r) });
    const started = performance.now();
    expect(await runner.run(evilBody, evil)).toEqual({
      action: "hold",
      body: evilBody,
      filterId: null,
      timedOut: true,
    });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(reasons).toEqual(["timeout"]);
    // The replacement worker serves the next message, which never waits on the stuck one.
    expect(await runner.run("join discord.gg/abc", typical)).toEqual({ action: "block", filterId: "b3" });
  });

  test("other workers keep serving while one is stuck", async () => {
    runner = new WorkerFilterRunner({ workers: 2, hardTimeoutMs: 300 });
    await runner.run("warm", typical);
    const stuck = runner.run(evilBody, evil);
    const started = performance.now();
    expect(await runner.run("hello", typical)).toMatchObject({ action: "pass" });
    expect(performance.now() - started).toBeLessThan(250);
    expect(await stuck).toMatchObject({ action: "hold", timedOut: true });
  });

  test("literal-only and empty filter sets run inline", async () => {
    runner = new WorkerFilterRunner({ workers: 1 });
    const literal = compileFilters([def({ pattern: "bad", isRegex: false })]);
    expect(await runner.run("so bad", literal)).toEqual({ action: "block", filterId: "f" });
    expect(await runner.run("anything", [])).toEqual({ action: "pass", body: "anything", filterId: null });
  });

  test("a full queue holds instead of waiting", async () => {
    const reasons: string[] = [];
    runner = new WorkerFilterRunner({ workers: 1, maxQueue: 1, hardTimeoutMs: 200, onTimeout: (r) => reasons.push(r) });
    await runner.run("warm", typical);
    const stuck = runner.run(evilBody, evil); // dispatched
    const queued = runner.run("hello", typical); // waits for the worker
    expect(await runner.run("hello", typical)).toMatchObject({ action: "hold", timedOut: true });
    expect(reasons).toContain("queue_full");
    expect(await stuck).toMatchObject({ action: "hold", timedOut: true });
    expect(await queued).toMatchObject({ action: "pass" });
  });

  test("filter sets evicted from the worker cache are sent again", async () => {
    runner = new WorkerFilterRunner({ workers: 1 });
    const sets = Array.from({ length: 300 }, (_, i) => compileFilters([def({ id: `s${i}`, pattern: `word${i}\\b` })]));
    for (const [i, set] of sets.entries()) expect(await runner.run(`word${i}`, set)).toMatchObject({ action: "block" });
    expect(await runner.run("word0", sets[0] ?? [])).toEqual({ action: "block", filterId: "s0" });
  });

  test("close holds pending messages", async () => {
    runner = new WorkerFilterRunner({ workers: 1, hardTimeoutMs: 5_000 });
    await runner.run("warm", typical);
    const stuck = runner.run(evilBody, evil);
    await runner.close();
    expect(await stuck).toMatchObject({ action: "hold", timedOut: true });
    expect(await runner.run("hello", typical)).toMatchObject({ action: "hold", timedOut: true });
  });

  test("latency for a typical filter set", async () => {
    runner = new WorkerFilterRunner();
    for (let i = 0; i < 200; i++) await runner.run(`warm up ${i}`, typical);
    const samples: number[] = [];
    for (let i = 0; i < 2_000; i++) {
      const started = performance.now();
      await runner.run(`a normal chat message, number ${i}, with a few words in it`, typical);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const at = (q: number) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))] ?? 0;
    if (process.env.CHAT_FILTER_BENCH)
      process.stderr.write(`filter worker p50 ${at(0.5).toFixed(3)} ms, p99 ${at(0.99).toFixed(3)} ms\n`);
    // Lenient so a loaded CI machine does not flake; measured p99 is reported in the README.
    expect(at(0.99)).toBeLessThan(10);
  });
});
