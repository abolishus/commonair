// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Restart, health and ordering rules for the production Quadlet units (ADR 0023 §9 and §10).
 *
 * Under podman-compose a crashed app container stayed down: compose turns every depends_on
 * into `podman create --requires`, and Podman applies a restart policy only while every
 * required container runs, which the exited one-shot jobs never do (infra/README.md). Quadlet
 * passes no restart policy to Podman at all: systemd restarts the unit (Restart=), and the
 * one-shots it depends on stay active (RemainAfterExit=yes). These tests pin that down.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";

const DIR = new URL("../quadlet/", import.meta.url).pathname;
const units = readdirSync(DIR)
  .filter((f) => f.endsWith(".container"))
  .sort()
  .map((f) => [f.replace(/\.container$/, ""), readFileSync(join(DIR, f), "utf8")] as const);

const values = (unit: string, key: string) => [...unit.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))].map((m) => m[1]!);
function section(unit: string, name: string): string {
  const start = unit.indexOf(`[${name}]\n`);
  if (start === -1) return "";
  const rest = unit.slice(start + name.length + 3);
  const end = rest.search(/^\[[A-Za-z]+\]$/m);
  return end === -1 ? rest : rest.slice(0, end);
}
const oneShot = (unit: string) => /^Type=oneshot$/m.test(unit);
const longRunning = units.filter(([, u]) => !oneShot(u));
const oneShots = units.filter(([, u]) => oneShot(u));
// Units that read the schema: they get the database URL secret.
const schemaUsers = units.filter(([, u]) => /^Secret=commonair-database-url,/m.test(u));

/** Seconds in a systemd time span such as `5`, `5s`, `5min`, `1h`. */
function seconds(span: string): number {
  const m = /^(\d+)(s|sec|min|m|h)?$/.exec(span.trim());
  if (!m) throw new Error(`unparsed time span ${span}`);
  return Number(m[1]) * ({ min: 60, m: 60, h: 3600 }[m[2] ?? "s"] ?? 1);
}

describe("every container unit", () => {
  test("the expected set: services, one-shot jobs and the timer-driven certificate sync", () => {
    expect(oneShots.map(([n]) => n)).toEqual(["commonair-garage-init", "commonair-irc-cert", "commonair-migrate"]);
    expect(longRunning.length).toBe(18);
  });

  // No exceptions: catatonit is bind-mounted from the host and static, so it runs in every
  // image (distroless and scratch-based ones included).
  test.each(units)("%s: RunInit=true (an init reaps orphans and forwards signals)", (_, unit) => {
    expect(values(section(unit, "Container"), "RunInit")).toEqual(["true"]);
  });

  test.each(units)("%s: pinned image (own images are rendered per release, the rest by digest)", (_, unit) => {
    const [image] = values(unit, "Image");
    expect(image).toMatch(/^(localhost\/commonair\/[a-z-]+:latest|[a-z0-9.-]+\/[^@\s]+:[\w.-]+@sha256:[0-9a-f]{64})$/);
  });
});

describe("long-running units restart for real", () => {
  test.each(longRunning)("%s: Restart=always with a delay that backs off", (_, unit) => {
    const service = section(unit, "Service");
    expect(values(service, "Restart")).toEqual(["always"]);
    expect(seconds(values(service, "RestartSec")[0] ?? "")).toBe(5);
    // Throttles a crash loop: 5 s growing to 5 min over ten restarts (systemd ≥ 254).
    expect(Number(values(service, "RestartSteps")[0])).toBeGreaterThanOrEqual(1);
    expect(seconds(values(service, "RestartMaxDelaySec")[0] ?? "")).toBe(300);
  });

  test.each(longRunning)("%s: a crash loop can never leave the unit permanently failed", (_, unit) => {
    // StartLimitIntervalSec=0 turns the start rate limit off, so systemd never gives up
    // (a burst limit is then moot); RestartSteps above does the throttling instead.
    expect(values(section(unit, "Unit"), "StartLimitIntervalSec")).toEqual(["0"]);
    expect(values(unit, "StartLimitBurst")).toEqual([]);
  });

  test.each(longRunning)("%s: health check, and an unhealthy container is killed and restarted", (_, unit) => {
    const container = section(unit, "Container");
    expect(values(container, "HealthCmd")).toHaveLength(1);
    expect(values(container, "HealthOnFailure")).toEqual(["kill"]);
    expect(values(container, "Notify")).toEqual(["healthy"]);
    // Startup must outlast the health check's own start period and retries.
    const startPeriod = seconds(values(container, "HealthStartPeriod")[0] ?? "0");
    expect(seconds(values(section(unit, "Service"), "TimeoutStartSec")[0] ?? "0")).toBeGreaterThan(startPeriod);
  });

  test.each(longRunning)("%s: started at boot", (_, unit) => {
    expect(values(section(unit, "Install"), "WantedBy")).toEqual(["default.target"]);
  });
});

describe("one-shot jobs", () => {
  test.each(oneShots)("%s: run to completion once, no health check, no retry loop", (_, unit) => {
    const service = section(unit, "Service");
    expect(values(service, "Restart")).toEqual(["no"]);
    expect(values(unit, "HealthCmd")).toEqual([]);
    expect(values(unit, "HealthOnFailure")).toEqual([]);
  });

  test.each(oneShots.filter(([n]) => n !== "commonair-irc-cert"))(
    "%s: stays active after it exits, so dependents can restart without re-running it",
    (_, unit) => {
      expect(values(section(unit, "Service"), "RemainAfterExit")).toEqual(["yes"]);
      expect(values(section(unit, "Install"), "WantedBy")).toEqual(["default.target"]);
    },
  );
});

describe("migrations run before anything that reads the schema", () => {
  test("the schema users are the app services", () => {
    expect(schemaUsers.map(([n]) => n.replace(/^commonair-/, ""))).toEqual([
      "api",
      "chat",
      "irc",
      "media",
      "origin",
      "tracker",
      "web",
      "worker",
    ]);
  });

  test.each(schemaUsers)("%s: Requires= and After= commonair-migrate itself", (_, unit) => {
    const deps = section(unit, "Unit");
    expect(values(deps, "Requires")).toContain("commonair-migrate.service");
    expect(values(deps, "After")).toContain("commonair-migrate.service");
  });

  test("migrate runs as the owner after Postgres is healthy", () => {
    const migrate = units.find(([n]) => n === "commonair-migrate")![1];
    expect(values(migrate, "Requires")).toEqual(["commonair-postgres.service"]);
    expect(values(migrate, "After")).toEqual(["commonair-postgres.service"]);
    expect(values(migrate, "Secret")).toEqual(["commonair-owner-database-url,type=env,target=DATABASE_URL"]);
    const postgres = units.find(([n]) => n === "commonair-postgres")![1];
    expect(values(postgres, "Notify")).toEqual(["healthy"]);
  });

  test("every Requires= has a matching After= and names an existing unit", () => {
    const names = new Set(units.map(([n]) => `${n}.service`));
    for (const [name, unit] of units) {
      const requires = values(unit, "Requires");
      expect(
        requires.filter((r) => !values(unit, "After").includes(r)),
        name,
      ).toEqual([]);
      expect(
        requires.filter((r) => !names.has(r)),
        name,
      ).toEqual([]);
    }
  });

  test("the dependency graph has no cycle", () => {
    const deps = new Map(units.map(([n, u]) => [n, values(u, "Requires").map((r) => r.replace(/\.service$/, ""))]));
    const state = new Map<string, "visiting" | "done">();
    const visit = (n: string, path: string[]): void => {
      if (state.get(n) === "done") return;
      expect(state.get(n), `cycle: ${[...path, n].join(" → ")}`).not.toBe("visiting");
      state.set(n, "visiting");
      for (const d of deps.get(n) ?? []) visit(d, [...path, n]);
      state.set(n, "done");
    };
    for (const n of deps.keys()) visit(n, []);
  });
});
