// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { judgeLoadRun } from "../src/load.ts";
import { type LoadEnv, loadLoadEnv, mbpsToBytesPerSecond } from "../src/load/env.ts";
import { type HostSummary, summarizeHost } from "../src/load/host.ts";
import { DEFAULT_GENERATOR_THRESHOLDS, describeLimit, judgeGenerators } from "../src/load/judge.ts";
import type { LoadReport } from "../src/load/report.ts";

/** A host whose samples all have this CPU and this transmit/receive on eth1. */
function host(cpu: number, tx: number, rx = 0, failures = 0): HostSummary {
  return summarizeHost(
    Array.from({ length: 4 }, (_, i) => ({
      at: i * 5_000,
      seconds: 5,
      cpu: { busyPercent: cpu, stealPercent: 0, cpus: 8 },
      mem: null,
      load: null,
      nic: {
        eth0: { rxBytesPerSecond: 0, txBytesPerSecond: 1 },
        eth1: { rxBytesPerSecond: rx, txBytesPerSecond: tx },
      },
    })),
    failures,
  );
}

const CEILING = 1_000_000;

describe("generator judge (inconclusive)", () => {
  test("defaults: CPU p95 over 80 %, NIC within 15 % of its ceiling", () => {
    expect(DEFAULT_GENERATOR_THRESHOLDS).toEqual({ maxCpuP95: 80, nicHeadroom: 0.15 });
  });

  test("a generator with headroom is conclusive", () => {
    expect(judgeGenerators({ local: host(50, 500_000) }, CEILING)).toEqual({
      inconclusive: false,
      limits: [],
      notes: [],
    });
  });

  test("CPU p95: exactly 80 % is fine, above is inconclusive", () => {
    expect(judgeGenerators({ local: host(80, 0) }, CEILING).inconclusive).toBe(false);
    const v = judgeGenerators({ local: host(80.1, 0) }, CEILING);
    expect(v.inconclusive).toBe(true);
    expect(v.limits).toEqual([{ kind: "cpu", host: "local", cpuP95: 80.1, threshold: 80 }]);
  });

  test("NIC transmit: exactly 85 % of the ceiling is within 15 % (inconclusive), just under is not", () => {
    expect(judgeGenerators({ local: host(10, 849_999) }, CEILING).inconclusive).toBe(false);
    const v = judgeGenerators({ local: host(10, 850_000) }, CEILING);
    expect(v.limits).toEqual([
      {
        kind: "nic",
        host: "local",
        iface: "eth1",
        direction: "tx",
        bytesPerSecondP95: 850_000,
        ceilingBytesPerSecond: CEILING,
      },
    ]);
  });

  test("NIC receive counts too (viewers download through the generator)", () => {
    const v = judgeGenerators({ local: host(10, 0, 900_000) }, CEILING);
    expect(v.limits.map((l) => (l.kind === "nic" ? l.direction : l.kind))).toEqual(["rx"]);
  });

  test("both limits on one host are both reported", () => {
    const v = judgeGenerators({ local: host(95, 990_000) }, CEILING);
    expect(v.limits.map((l) => l.kind)).toEqual(["cpu", "nic"]);
  });

  test("any saturated host makes the run inconclusive (remote shard hosts too)", () => {
    const v = judgeGenerators({ local: host(10, 0), "root@10.110.0.7": host(97, 0) }, CEILING);
    expect(v.inconclusive).toBe(true);
    expect(v.limits[0]).toMatchObject({ host: "root@10.110.0.7" });
    expect(describeLimit(v.limits[0] as (typeof v.limits)[0])).toBe("root@10.110.0.7: CPU p95 97.0 % > 80 %");
  });

  test("an unknown ceiling skips the NIC rule with a note; CPU still applies", () => {
    const v = judgeGenerators({ local: host(10, 1e12) }, null);
    expect(v.inconclusive).toBe(false);
    expect(v.notes).toEqual(["generator NIC ceiling unknown: NIC rule not applied"]);
    expect(judgeGenerators({ local: host(99, 0) }, null).inconclusive).toBe(true);
  });

  test("a host with no samples or failed reads is noted, never counted as saturated", () => {
    const v = judgeGenerators({ local: null, g2: summarizeHost([], 4), g3: host(10, 0, 0, 2) }, CEILING);
    expect(v.inconclusive).toBe(false);
    expect(v.notes).toEqual(["local: no host samples", "g2: no host samples", "g3: 2 failed reads"]);
  });

  test("custom thresholds", () => {
    expect(judgeGenerators({ local: host(70, 0) }, CEILING, { maxCpuP95: 60, nicHeadroom: 0.15 }).inconclusive).toBe(
      true,
    );
    expect(
      judgeGenerators({ local: host(0, 600_000) }, CEILING, { maxCpuP95: 80, nicHeadroom: 0.5 }).inconclusive,
    ).toBe(true);
  });
});

describe("judgeLoadRun", () => {
  const report = {
    started: 10,
    viewers: 10,
    stallRatio: 0,
    glassToGlassP95Ms: 1,
    ttffP95Ms: 1,
    errors: 0,
  } as LoadReport;

  function recorder() {
    const out = {
      asserts: [] as string[],
      checks: [] as string[],
      data: {} as Record<string, unknown>,
      metrics: {} as Record<string, unknown>,
    };
    const ctx = {
      assert: (name: string) => void out.asserts.push(name),
      check: (name: string) => {
        out.checks.push(name);
        return true;
      },
      data: (k: string, v: unknown) => void (out.data[k] = v),
      metric: (k: string, v: unknown) => void (out.metrics[k] = v),
      log: { warn: () => undefined } as never,
    };
    return { out, ctx };
  }

  test("inconclusive: no assertion on the target, the verdict and the limits recorded", () => {
    const { out, ctx } = recorder();
    const verdict = judgeGenerators({ local: host(99, 0) }, null);
    expect(judgeLoadRun(ctx, { report, generatorVerdict: verdict })).toBe("inconclusive");
    expect(out.asserts).toEqual([]);
    expect(out.checks).toEqual([]);
    expect(out.metrics["load.inconclusive"]).toBe(1);
    expect(out.data.verdict).toMatchObject({ outcome: "inconclusive", limits: ["local: CPU p95 99.0 % > 80 %"] });
  });

  test("a local run (no verdict) is judged exactly as before", () => {
    const { out, ctx } = recorder();
    expect(judgeLoadRun(ctx, { report, generatorVerdict: null })).toBe("judged");
    expect(out.asserts).toEqual(["every viewer started playback"]);
    expect(out.checks).toHaveLength(4);
    expect(out.data.verdict).toBeUndefined();
  });
});

describe("HARNESS_LOAD_* variables", () => {
  test("all optional; unset keeps the local behaviour", () => {
    const env: LoadEnv = loadLoadEnv({});
    expect(env).toEqual({
      HARNESS_LOAD_TARGET_SSH: undefined,
      HARNESS_LOAD_TARGET_NIC_MBPS: undefined,
      HARNESS_LOAD_GENERATOR_NIC_MBPS: undefined,
      HARNESS_LOAD_GENERATOR_HOSTS: [],
      HARNESS_LOAD_GENERATOR_REPO: undefined,
      HARNESS_LOAD_AUTH_PER_MINUTE: undefined,
      HARNESS_LOAD_ACCOUNTS_FILE: undefined,
    });
  });

  test("parsed values; blanks are unset; a bad number is refused", () => {
    const env = loadLoadEnv({
      HARNESS_LOAD_TARGET_SSH: " commonair@10.110.0.5 ",
      HARNESS_LOAD_TARGET_NIC_MBPS: "2000",
      HARNESS_LOAD_GENERATOR_HOSTS: "local, root@10.110.0.7 ,,",
      HARNESS_LOAD_AUTH_PER_MINUTE: "9",
      HARNESS_LOAD_ACCOUNTS_FILE: "  ",
    });
    expect(env.HARNESS_LOAD_TARGET_SSH).toBe("commonair@10.110.0.5");
    expect(env.HARNESS_LOAD_TARGET_NIC_MBPS).toBe(2000);
    expect(env.HARNESS_LOAD_GENERATOR_HOSTS).toEqual(["local", "root@10.110.0.7"]);
    expect(env.HARNESS_LOAD_AUTH_PER_MINUTE).toBe(9);
    expect(env.HARNESS_LOAD_ACCOUNTS_FILE).toBeUndefined();
    expect(() => loadLoadEnv({ HARNESS_LOAD_TARGET_NIC_MBPS: "fast" })).toThrow(/positive number/);
    expect(() => loadLoadEnv({ HARNESS_LOAD_AUTH_PER_MINUTE: "0" })).toThrow(/positive number/);
  });

  test("Mbit/s to bytes per second", () => {
    expect(mbpsToBytesPerSecond(8)).toBe(1_000_000);
    expect(mbpsToBytesPerSecond(undefined)).toBeNull();
  });
});
