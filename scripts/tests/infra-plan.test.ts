// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { type ComposeService, ONE_SHOT_SERVICES, STACK_HEALTHY_SERVICES, startPlan } from "../infra.ts";

const healthy = { condition: "service_healthy" as const };
const done = { condition: "service_completed_successfully" as const };

// The shape of compose.yaml: data services, two one-shots, services behind them, and a chain.
const stack: Record<string, ComposeService> = {
  postgres: {},
  valkey: {},
  garage: {},
  migrate: { depends_on: { postgres: healthy } },
  "garage-init": { depends_on: { garage: healthy } },
  api: { depends_on: { migrate: done, "garage-init": done, valkey: healthy } },
  chat: { depends_on: { migrate: done, valkey: healthy } },
  irc: { depends_on: { chat: healthy, migrate: done } },
  web: { depends_on: { api: healthy } },
  caddy: { profiles: ["tls"], depends_on: { web: healthy } },
  "mock-rtmp": { profiles: ["harness"] },
  grafana: { depends_on: ["postgres"] },
};

describe("startPlan", () => {
  test("services behind a one-shot start in dependency waves, the rest first", () => {
    const plan = startPlan(stack, new Set(["harness"]), ONE_SHOT_SERVICES);
    expect(plan.first.sort()).toEqual([
      "garage",
      "garage-init",
      "grafana",
      "migrate",
      "mock-rtmp",
      "postgres",
      "valkey",
    ]);
    expect(plan.waves.map((w) => w.services)).toEqual([
      ["api", "chat"],
      ["irc", "web"],
    ]);
  });

  test("each wave waits for its dependencies' own conditions", () => {
    const [first, second] = startPlan(stack, new Set(), ONE_SHOT_SERVICES).waves;
    expect(first!.wait).toEqual({
      migrate: "service_completed_successfully",
      "garage-init": "service_completed_successfully",
      valkey: "service_healthy",
    });
    expect(second!.wait).toEqual({
      chat: "service_healthy",
      migrate: "service_completed_successfully",
      api: "service_healthy",
    });
  });

  test("a disabled profile's services are left out, an enabled one's join their wave", () => {
    expect(startPlan(stack, new Set(), ONE_SHOT_SERVICES).first).not.toContain("mock-rtmp");
    const tls = startPlan(stack, new Set(["tls"]), ONE_SHOT_SERVICES);
    expect(tls.waves.map((w) => w.services)).toEqual([["api", "chat"], ["irc", "web"], ["caddy"]]);
  });

  test("healthy wins when two members of a wave wait on the same service differently", () => {
    const plan = startPlan(
      {
        db: {},
        job: { depends_on: ["db"] },
        a: { depends_on: { job: done, db: { condition: "service_started" } } },
        b: { depends_on: { job: done, db: healthy } },
      },
      new Set(),
      ["job"],
    );
    expect(plan.waves).toEqual([
      { services: ["a", "b"], wait: { job: "service_completed_successfully", db: "service_healthy" } },
    ]);
  });

  test("without one-shots everything starts in the first pass", () => {
    expect(startPlan(stack, new Set(), [])).toEqual({
      first: Object.keys(stack).filter((n) => !stack[n]!.profiles),
      waves: [],
    });
  });

  test("a depends_on cycle behind a one-shot is an error, not a hang", () => {
    const cyclic = { job: {}, a: { depends_on: ["job", "b"] }, b: { depends_on: ["a"] } };
    expect(() => startPlan(cyclic, new Set(), ["job"])).toThrow(/depends_on cycle among a, b/);
  });
});

describe("STACK_HEALTHY_SERVICES", () => {
  test("coturn is waited on: it runs without a profile and has a healthcheck in compose.yaml", () => {
    expect(STACK_HEALTHY_SERVICES).toContain("coturn");
    const compose = readFileSync(new URL("../../compose.yaml", import.meta.url), "utf8");
    // The service's block: from its key to the next top-level service key.
    const block = /^ {2}coturn:\n((?: {4}.*\n|\s*\n)+)/m.exec(compose)?.[1] ?? "";
    expect(block).toContain("healthcheck:");
    expect(block).not.toMatch(/^ {4}profiles:/m);
  });
});
