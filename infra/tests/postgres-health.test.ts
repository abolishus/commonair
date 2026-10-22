// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Postgres health and start-timeout rules (infra/postgres/health.sh). A WAL replay after a
 * restore that keeps advancing is never killed: the startup check gates the regular one, and
 * only the script decides when a start is stuck. The behaviour itself is exercised against a
 * real Postgres in postgres-health.int.test.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { parse } from "yaml";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const unit = read("infra/quadlet/commonair-postgres.container");
const values = (key: string) => [...unit.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))].map((m) => m[1]!);
const one = (key: string) => {
  const v = values(key);
  expect(v, key).toHaveLength(1);
  return v[0]!;
};
const script = read("infra/postgres/health.sh");

/** Seconds in a systemd time span such as `5`, `5s`, `5min`, `12h`. */
function seconds(span: string): number {
  const m = /^(\d+)(s|sec|min|m|h)?$/.exec(span.trim());
  if (!m) throw new Error(`unparsed time span ${span}`);
  return Number(m[1]) * ({ min: 60, m: 60, h: 3600 }[m[2] ?? "s"] ?? 1);
}
/** A `${NAME:-default}` default from health.sh, in seconds. */
function scriptDefault(name: string): number {
  const m = new RegExp(`"\\$\\{${name}:-(\\d+)\\}"`).exec(script);
  if (!m) throw new Error(`${name} has no default in health.sh`);
  return Number(m[1]);
}

describe("commonair-postgres.container health", () => {
  test("the image ships the health script", () => {
    expect(read("infra/postgres/Containerfile")).toContain(
      "COPY --chmod=0755 infra/postgres/health.sh /usr/local/bin/commonair-pg-health",
    );
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
  });

  test("regular check: ready means accepting connections and out of recovery; unhealthy is killed", () => {
    expect(one("HealthCmd")).toBe("commonair-pg-health");
    expect(one("HealthOnFailure")).toBe("kill");
    expect(one("Notify")).toBe("healthy");
    // About two minutes of failures after startup before the kill, as before.
    expect(seconds(one("HealthInterval")) * Number(one("HealthRetries"))).toBe(100);
    expect(seconds(one("HealthTimeout"))).toBeLessThan(seconds(one("HealthInterval")));
    expect(script).toMatch(/Database cluster state: \*in production/);
    expect(script).toMatch(/pg_isready -q -t 3/);
  });

  test("startup check gates the regular one and never lets Podman restart on its failures", () => {
    expect(one("HealthStartupCmd")).toBe("commonair-pg-health --startup");
    expect(one("HealthStartupRetries")).toBe("0");
    expect(seconds(one("HealthStartupInterval"))).toBe(10);
    expect(seconds(one("HealthStartupTimeout"))).toBeLessThan(seconds(one("HealthStartupInterval")));
  });

  test("bounds: a stuck replay stops after 10 min, a normal start after 2 min", () => {
    expect(scriptDefault("COMMONAIR_PG_STALL_SECONDS")).toBe(600);
    expect(scriptDefault("COMMONAIR_PG_START_SECONDS")).toBe(120);
  });

  test("the start timeout is only a backstop, far beyond the script's bounds", () => {
    const timeout = seconds(one("TimeoutStartSec"));
    expect(timeout).toBeGreaterThanOrEqual(6 * 3600);
    expect(timeout).toBeGreaterThan(scriptDefault("COMMONAIR_PG_STALL_SECONDS") * 10);
    // ADR 0023 §10 restart rules stay as they were.
    expect(values("Restart")).toEqual(["always"]);
    expect(values("RestartMode")).toEqual(["direct"]);
    expect(values("RunInit")).toEqual(["true"]);
    expect(values("StartLimitIntervalSec")).toEqual(["0"]);
  });
});

describe("restore_command", () => {
  test("commonair-restore replays through commonair-wal-fetch, which the image ships", () => {
    expect(read("infra/postgres/Containerfile")).toContain(
      "COPY --chmod=0755 infra/postgres/wal-fetch.sh /usr/local/bin/commonair-wal-fetch",
    );
    expect(read("infra/postgres/restore.sh")).toContain("restore_command = '/usr/local/bin/commonair-wal-fetch %f %p'");
  });

  test("only wal-g's not-found status ends the replay; other failures are fatal (above 125)", () => {
    const fetch = read("infra/postgres/wal-fetch.sh");
    expect(fetch).toMatch(/^not_found=74$/m);
    expect(fetch).toMatch(/"\$not_found"\) exit 1 ;;/);
    expect(fetch).toMatch(/exit 126/);
  });
});

describe("compose mirror", () => {
  const compose = parse(read("compose.yaml")) as {
    services: Record<string, { healthcheck?: { test?: string[] } }>;
  };

  test("compose's postgres runs the same ready check", () => {
    expect(compose.services.postgres?.healthcheck?.test).toEqual(["CMD", "commonair-pg-health"]);
  });
});
