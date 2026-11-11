// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Overhaul D6.1: every transparency v2 test id the harness names is a literal in the web source. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { D6_TRANSPARENCY_TEST_IDS } from "../src/web/selectors.ts";

const SRC = new URL("../../apps/web/src/", import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.tsx?$/.test(name) && !name.endsWith(".gen.ts") ? [full] : [];
  });
}

describe("D6_TRANSPARENCY_TEST_IDS", () => {
  const text = sources(SRC)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  test("each id is set as a data-testid in apps/web/src", () => {
    const ids = Object.values(D6_TRANSPARENCY_TEST_IDS);
    expect(new Set(ids).size).toBe(ids.length);
    const missing = ids.filter(
      (id) => !text.includes(`data-testid="${id}"`) && !text.includes(`"data-testid": "${id}"`),
    );
    expect(missing).toEqual([]);
  });
});
