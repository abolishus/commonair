// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The ops test hook's job table and how it turns a job's return value into counts. */
import { describe, expect, test } from "vite-plus/test";
import { MODERATION_JOBS, OPS_TICK_JOBS, OpsJobResult, QUEUES } from "@commonair/contracts/internal";
import { flattenJobResult, OPS_JOB_QUEUES } from "../src/ops/hooks.ts";

describe("OPS_JOB_QUEUES", () => {
  test("every tick job has a queue", () => {
    expect(Object.keys(OPS_JOB_QUEUES).sort()).toEqual([...OPS_TICK_JOBS].sort());
  });
  test("the evidence audit runs on the moderation queue under its scheduled name", () => {
    expect(OPS_JOB_QUEUES["evidence-audit"]).toEqual({ queue: QUEUES.moderation, name: MODERATION_JOBS.evidenceAudit });
  });
});

describe("flattenJobResult", () => {
  test("flat integer counts pass through", () => {
    expect(flattenJobResult({ deleted: 2, held: 0 })).toEqual({ deleted: 2, held: 0 });
  });
  test("a lock-held run's skipped: true counts 1", () => {
    expect(flattenJobResult({ skipped: true })).toEqual({ skipped: 1 });
    expect(flattenJobResult({ exhausted: false })).toEqual({ exhausted: 0 });
  });
  test("the evidence audit's nested summary becomes dotted counts; ids and nulls are dropped", () => {
    const r = flattenJobResult({
      t0Media: { selected: 3, enqueued: 1 },
      evidence: { runId: "0190-run", checked: 12, missing: ["a", "b"], mismatched: [], incidentId: null },
    });
    expect(r).toEqual({
      "t0Media.selected": 3,
      "t0Media.enqueued": 1,
      "evidence.checked": 12,
      "evidence.missing": 2,
      "evidence.mismatched": 0,
    });
    expect(OpsJobResult.safeParse(r).success).toBe(true);
  });
  test("non-integer numbers, strings and non-objects yield nothing", () => {
    expect(flattenJobResult({ ratio: 0.5, name: "x", nan: Number.NaN })).toEqual({});
    expect(flattenJobResult(null)).toEqual({});
    expect(flattenJobResult(7)).toEqual({});
    expect(flattenJobResult([1, 2])).toEqual({});
    expect(flattenJobResult(undefined)).toEqual({});
  });
});
