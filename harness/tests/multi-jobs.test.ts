// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { type JobRun, jobRunFromHash, oncePerTick, parseSchedulerJobId, schedulerReport } from "../src/multi/jobs.ts";

describe("parseSchedulerJobId", () => {
  test("BullMQ scheduler ids: repeat:<scheduler>:<tick millis>", () => {
    expect(parseSchedulerJobId("repeat:live-counters:1761480070000")).toEqual({
      scheduler: "live-counters",
      tickMs: 1761480070000,
    });
    expect(parseSchedulerJobId("repeat:a:b:10")).toEqual({ scheduler: "a:b", tickMs: 10 });
    expect(parseSchedulerJobId("fanout-0198")).toBeNull();
    expect(parseSchedulerJobId("repeat:live-counters:")).toBeNull();
  });
});

describe("jobRunFromHash", () => {
  test("reads BullMQ's short fields", () => {
    expect(
      jobRunFromHash("repeat:live-counters:100", { processedOn: "105", finishedOn: "110", ats: "2", stc: "1" }),
    ).toEqual({
      id: "repeat:live-counters:100",
      scheduler: "live-counters",
      tickMs: 100,
      processedOn: 105,
      finishedOn: 110,
      attemptsStarted: 2,
      stalled: 1,
    });
  });

  test("falls back to attemptsMade, defaults to one start and no stall", () => {
    expect(jobRunFromHash("repeat:x:1", { atm: "3" })?.attemptsStarted).toBe(3);
    const bare = jobRunFromHash("repeat:x:1", {});
    expect([bare?.attemptsStarted, bare?.stalled, bare?.processedOn]).toEqual([1, 0, null]);
    expect(jobRunFromHash("not-a-scheduler", {})).toBeNull();
  });
});

const run = (tickMs: number, over: Partial<JobRun> = {}): JobRun => ({
  id: `repeat:live-counters:${tickMs}`,
  scheduler: "live-counters",
  tickMs,
  processedOn: tickMs + 5,
  finishedOn: tickMs + 30,
  attemptsStarted: 1,
  stalled: 0,
  ...over,
});

describe("schedulerReport", () => {
  const every = 10_000;
  const ticks = (from: number, n: number) => Array.from({ length: n }, (_, i) => run(from + i * every));

  test("one run per tick across the window passes", () => {
    const r = schedulerReport(ticks(100_000, 6), "live-counters", every, 100_000, 160_000);
    expect(r).toMatchObject({ ticks: 6, expectedTicks: 6, minGapMs: every, tooClose: 0, rerun: [] });
    expect(oncePerTick(r)).toBe(true);
  });

  test("a second scheduler interleaving ticks is caught", () => {
    const runs = [...ticks(100_000, 6), run(105_000), run(125_000)];
    const r = schedulerReport(runs, "live-counters", every, 100_000, 160_000);
    expect(r.tooClose).toBe(4);
    expect(r.minGapMs).toBe(5_000);
    expect(oncePerTick(r)).toBe(false);
  });

  test("a run started twice (stalled after its worker died, or retried) is caught", () => {
    const runs = ticks(100_000, 6);
    runs[2] = run(120_000, { attemptsStarted: 2 });
    runs[4] = run(140_000, { stalled: 1 });
    const r = schedulerReport(runs, "live-counters", every, 100_000, 160_000);
    expect(r.rerun).toEqual(["repeat:live-counters:120000", "repeat:live-counters:140000"]);
    expect(oncePerTick(r)).toBe(false);
  });

  test("missing ticks beyond the edge tolerance fail; one at an edge does not", () => {
    expect(oncePerTick(schedulerReport(ticks(100_000, 5), "live-counters", every, 100_000, 160_000))).toBe(true);
    expect(oncePerTick(schedulerReport(ticks(100_000, 3), "live-counters", every, 100_000, 160_000))).toBe(false);
  });

  test("only the named scheduler inside [from, to) counts; nothing at all fails", () => {
    const runs = [
      ...ticks(100_000, 3),
      { ...run(110_000), scheduler: "score-sessions", id: "repeat:score-sessions:110000" },
    ];
    const r = schedulerReport(runs, "live-counters", every, 110_000, 120_000);
    expect(r.ticks).toBe(1);
    expect(r.expectedTicks).toBe(1);
    expect(oncePerTick(schedulerReport([], "live-counters", every, 0, 60_000))).toBe(false);
    expect(schedulerReport([], "x", every, 10, 0).expectedTicks).toBe(0);
  });
});
