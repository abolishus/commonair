// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";
import { ALL_ENV_SCHEMAS, loadEnv } from "../../packages/config/src/env.ts";
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
