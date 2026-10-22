// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { ALL_ENV_SCHEMAS, infraEnv, loadEnv } from "../../packages/config/src/env.ts";
import { z } from "zod";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("init-env produces an env that every service schema accepts", () => {
  const out = join(mkdtempSync(join(tmpdir(), "commonair-env-")), ".env");
  const proc = Bun.spawnSync(["bun", "scripts/init-env.ts", "--out", out], { cwd: root });
  expect(proc.exitCode).toBe(0);
  const text = readFileSync(out, "utf8");
  expect(text).not.toContain("__generate");
  const env = Object.fromEntries(
    text
      .split("\n")
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  const all = z.object(Object.assign({}, ...Object.values(ALL_ENV_SCHEMAS).map((s) => s.shape)));
  expect(() => loadEnv(all, env)).not.toThrow();
  expect(env.S3_ACCESS_KEY_ID).toMatch(/^GK[0-9a-f]{24}$/);
});

/** Runs init-env into a fresh directory (optionally merging into `before`) and returns the env. */
function initEnv(before?: string): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "commonair-env-"));
  const out = join(dir, ".env");
  if (before !== undefined) writeFileSync(out, before);
  const args = ["bun", "scripts/init-env.ts", "--out", out, ...(before === undefined ? [] : ["--merge"])];
  const proc = Bun.spawnSync(args, { cwd: root });
  expect(proc.exitCode, proc.stderr.toString()).toBe(0);
  return Object.fromEntries(
    readFileSync(out, "utf8")
      .split("\n")
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

describe("Valkey password", () => {
  test("a fresh env gets a password, and the development URL carries it", () => {
    const env = initEnv();
    expect(env.VALKEY_PASSWORD).toMatch(/^[0-9a-f]{64}$/);
    expect(env.VALKEY_URL).toBe(`redis://:${env.VALKEY_PASSWORD}@localhost:6379`);
    // Two runs, two passwords.
    expect(initEnv().VALKEY_PASSWORD).not.toBe(env.VALKEY_PASSWORD);
  });

  test("a merge into a file from before gives it one and adds it to its URL", () => {
    const env = initEnv("VALKEY_URL=redis://valkey.internal:6380/2\nAUTH_SECRET=kept\n");
    expect(env.VALKEY_PASSWORD).toMatch(/^[0-9a-f]{64}$/);
    expect(env.VALKEY_URL).toBe(`redis://:${env.VALKEY_PASSWORD}@valkey.internal:6380/2`);
    expect(env.AUTH_SECRET).toBe("kept");
  });

  test("a merge keeps a password and its URL as they are", () => {
    const env = initEnv("VALKEY_PASSWORD=abc123\nVALKEY_URL=redis://:abc123@valkey:6379\n");
    expect(env.VALKEY_PASSWORD).toBe("abc123");
    expect(env.VALKEY_URL).toBe("redis://:abc123@valkey:6379");
  });

  test("an explicitly empty password (development without one) stays empty, the URL without one", () => {
    const env = initEnv("VALKEY_PASSWORD=\nVALKEY_URL=redis://localhost:6379\n");
    expect(env.VALKEY_PASSWORD).toBe("");
    expect(env.VALKEY_URL).toBe("redis://localhost:6379");
  });

  test("a URL that already has credentials keeps them, even with a fresh password", () => {
    const env = initEnv("VALKEY_URL=redis://:other@valkey:6379\n");
    expect(env.VALKEY_URL).toBe("redis://:other@valkey:6379");
  });

  test("the password passes its schema (URL-safe characters only)", () => {
    const env = initEnv();
    expect(() => loadEnv(infraEnv, { VALKEY_PASSWORD: env.VALKEY_PASSWORD })).not.toThrow();
    expect(() => loadEnv(infraEnv, { VALKEY_PASSWORD: "a/b@c" })).toThrow(/VALKEY_PASSWORD/);
  });
});

describe("the owner's DATABASE_URL", () => {
  test("a fresh env's DATABASE_URL carries the generated POSTGRES_PASSWORD", () => {
    const env = initEnv();
    expect(env.POSTGRES_PASSWORD).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const u = new URL(env.DATABASE_URL!);
    expect([u.username, u.password, u.hostname, u.pathname]).toEqual([
      "commonair",
      env.POSTGRES_PASSWORD,
      "localhost",
      "/commonair",
    ]);
  });

  test("a merge keeps an existing DATABASE_URL and POSTGRES_PASSWORD", () => {
    const env = initEnv("POSTGRES_PASSWORD=kept\nDATABASE_URL=postgres://commonair:other@db:5432/x\n");
    expect(env.POSTGRES_PASSWORD).toBe("kept");
    expect(env.DATABASE_URL).toBe("postgres://commonair:other@db:5432/x");
  });

  test("a merge into a file without DATABASE_URL uses the kept password", () => {
    const env = initEnv("POSTGRES_PASSWORD=kept-pw\n");
    expect(new URL(env.DATABASE_URL!).password).toBe("kept-pw");
  });
});
