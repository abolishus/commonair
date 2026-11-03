// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The pure parts of scripts/selfhost/e2e-metrics.ts; the check itself runs in the self-host e2e. */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  RULE_GROUPS,
  checkMetrics,
  metricQueries,
  promGet,
  queryPath,
  ruleGroups,
  vectorValue,
} from "./e2e-metrics.ts";

const ok = (n: number | null) =>
  JSON.stringify({
    status: "success",
    data: { resultType: "vector", result: n === null ? [] : [{ metric: {}, value: [0, String(n)] }] },
  });
const rules = (names: readonly string[]) =>
  JSON.stringify({ status: "success", data: { groups: names.map((name) => ({ name })) } });

describe("queries", () => {
  test("each family is counted for the install's state mode", () => {
    expect(metricQueries("external")).toEqual({
      system_cpu: 'count({__name__=~"system_cpu_.+",state_mode="external"})',
      postgresql: 'count({__name__=~"postgresql_.+",state_mode="external"})',
      redis: 'count({__name__=~"redis_.+",state_mode="external"})',
    });
  });

  test("the path is URL-encoded, so the shell line has no quote or space in it", () => {
    const line = promGet(queryPath(metricQueries("bundled").postgresql ?? ""));
    expect(line).toMatch(
      /^podman exec commonair-prometheus wget -q -O - 'http:\/\/127\.0\.0\.1:9090\/api\/v1\/query\?query=[^' ]+'$/,
    );
    expect(() => promGet("/api/v1/query?query=a b")).toThrow(/unsafe/);
  });

  test("RULE_GROUPS are the groups the rule files define", () => {
    const groups = ["commonair-recording.yml", "commonair-alerts.yml"].flatMap((f) =>
      [
        ...readFileSync(new URL(`../../infra/prometheus/rules/${f}`, import.meta.url), "utf8").matchAll(
          /^  - name: (\S+)$/gm,
        ),
      ].map((m) => m[1] ?? ""),
    );
    const byName = (a: string, b: string) => a.localeCompare(b);
    expect([...RULE_GROUPS].sort(byName)).toEqual(groups.sort(byName));
  });
});

describe("answers", () => {
  test("a count, an empty vector, an error", () => {
    expect(vectorValue(ok(42))).toBe(42);
    expect(vectorValue(ok(null))).toBe(0);
    expect(() => vectorValue(JSON.stringify({ status: "error", error: "bad" }))).toThrow(/unexpected/);
    expect(ruleGroups(rules(["a", "b"]))).toEqual(["a", "b"]);
  });
});

describe("checkMetrics", () => {
  function fakeHost(answers: (cmd: string, round: number) => string) {
    let round = 0;
    const calls: string[] = [];
    const inHost = (cmd: string) => {
      calls.push(cmd);
      if (cmd.includes("/api/v1/rules")) return rules(RULE_GROUPS);
      const a = answers(cmd, round);
      if (cmd.includes("redis")) round++;
      return a;
    };
    return { inHost, calls };
  }
  const sleep = async () => {};

  test("passes once every family has series, after polling", async () => {
    const { inHost } = fakeHost((cmd, round) => (cmd.includes("postgresql") && round < 2 ? ok(null) : ok(7)));
    const seen: [boolean, string][] = [];
    await checkMetrics(inHost, (b, w) => seen.push([b, w]), "bundled", { sleep });
    expect(seen.every(([b]) => b)).toBe(true);
    expect(seen.map(([, w]) => w)).toContain('Prometheus has postgresql_* series with state_mode="bundled" (7)');
  });

  test("fails a family that never shows up, and a missing rule group", async () => {
    const inHost = (cmd: string) =>
      cmd.includes("/api/v1/rules") ? rules(RULE_GROUPS.slice(1)) : cmd.includes("redis") ? "wget: error" : ok(3);
    const seen: [boolean, string][] = [];
    await checkMetrics(inHost, (b, w) => seen.push([b, w]), "external", { sleep, timeoutMs: 0 });
    expect(seen.filter(([b]) => !b).map(([, w]) => w)).toEqual([
      'Prometheus has redis_* series with state_mode="external" (0)',
      "Prometheus loaded the CommonAir rule groups (missing: commonair-targets)",
    ]);
  });
});
