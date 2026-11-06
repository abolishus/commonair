// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { loadEnvSchema, loadHarnessEnv, loadLoadEnv } from "../src/env.ts";

const SRC = new URL("../src", import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

describe("the load test's variables live in env.ts", () => {
  test("unset: the local behaviour (nothing remote, no pacing, fresh accounts)", () => {
    expect(loadLoadEnv({})).toEqual({
      HARNESS_LOAD_TARGET_SSH: undefined,
      HARNESS_LOAD_TARGET_NIC_MBPS: undefined,
      HARNESS_LOAD_GENERATOR_NIC_MBPS: undefined,
      HARNESS_LOAD_GENERATOR_HOSTS: [],
      HARNESS_LOAD_GENERATOR_REPO: undefined,
      HARNESS_LOAD_AUTH_PER_MINUTE: undefined,
      HARNESS_LOAD_ACCOUNTS_FILE: undefined,
    });
  });

  test("set: trimmed strings, a host list, positive numbers; blanks count as unset", () => {
    expect(
      loadLoadEnv({
        HARNESS_LOAD_TARGET_SSH: " commonair@10.110.0.5 ",
        HARNESS_LOAD_TARGET_NIC_MBPS: "2000",
        HARNESS_LOAD_GENERATOR_HOSTS: "local, gen@10.0.0.2,,",
        HARNESS_LOAD_AUTH_PER_MINUTE: "  ",
        HARNESS_LOAD_ACCOUNTS_FILE: "",
      }),
    ).toMatchObject({
      HARNESS_LOAD_TARGET_SSH: "commonair@10.110.0.5",
      HARNESS_LOAD_TARGET_NIC_MBPS: 2000,
      HARNESS_LOAD_GENERATOR_HOSTS: ["local", "gen@10.0.0.2"],
      HARNESS_LOAD_AUTH_PER_MINUTE: undefined,
      HARNESS_LOAD_ACCOUNTS_FILE: undefined,
    });
    expect(() => loadLoadEnv({ HARNESS_LOAD_GENERATOR_NIC_MBPS: "-1" })).toThrow(/positive number/);
  });

  test("a bad load value does not stop the harness's own env from loading", () => {
    expect(() => loadHarnessEnv({ HARNESS_LOAD_TARGET_NIC_MBPS: "fast" })).not.toThrow();
  });

  test("every HARNESS_LOAD_ variable is in the schema, and no other module reads or declares one", () => {
    expect(Object.keys(loadEnvSchema.shape).every((n) => n.startsWith("HARNESS_LOAD_"))).toBe(true);
    // A direct read (`process.env.HARNESS_LOAD_X`) or a second schema (`HARNESS_LOAD_X: z…`).
    const outside = /(process|Bun)\.env(\.|\[["'])HARNESS_LOAD_|^\s*HARNESS_LOAD_\w+\s*:/m;
    const readers = sources(SRC)
      .filter((f) => relative(SRC, f) !== "env.ts")
      .filter((f) => outside.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(readers).toEqual([]);
  });
});

describe("the harness variables", () => {
  test("DATABASE_URL: blank is unset, a value is trimmed", () => {
    expect(loadHarnessEnv({ DATABASE_URL: "  " }).DATABASE_URL).toBeUndefined();
    expect(loadHarnessEnv({ DATABASE_URL: " postgres://h/db " }).DATABASE_URL).toBe("postgres://h/db");
  });

  test("with no source both loaders read process.env", () => {
    const saved = process.env.HARNESS_LOAD_TARGET_SSH;
    process.env.HARNESS_LOAD_TARGET_SSH = "ops@from-env";
    try {
      expect(loadLoadEnv().HARNESS_LOAD_TARGET_SSH).toBe("ops@from-env");
      expect(loadHarnessEnv().HARNESS_API_URL).toBe(loadHarnessEnv(process.env).HARNESS_API_URL);
    } finally {
      if (saved === undefined) delete process.env.HARNESS_LOAD_TARGET_SSH;
      else process.env.HARNESS_LOAD_TARGET_SSH = saved;
    }
  });
});
