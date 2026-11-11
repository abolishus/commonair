// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** d5-money: every revenue and analytics selector the harness names is rendered by the web app's source. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { D5_MONEY_IDS, TEST_IDS } from "../src/web/selectors.ts";

const WEB = new URL("../../apps/web/src/components/", import.meta.url).pathname;
const DIRS = ["studio-money", "analytics"];
const source = [
  ...DIRS.flatMap((d) =>
    readdirSync(join(WEB, d))
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => readFileSync(join(WEB, d, f), "utf8")),
  ),
  readFileSync(join(WEB, "money/revenue.tsx"), "utf8"),
].join("\n");

describe("D5_MONEY_IDS", () => {
  test.each(Object.entries(D5_MONEY_IDS))("%s (%s) is a test id in the money pages' components", (_name, id) => {
    // As a JSX attribute, or as a `rowProps` entry (`"data-testid": "…"`).
    expect(source).toMatch(new RegExp(`(data-testid=\\{?["'\`]${id}["'\`]|"data-testid": "${id}")`));
  });

  test("the values are unique and do not collide with the shared ids", () => {
    const values = Object.values(D5_MONEY_IDS);
    expect(new Set(values).size).toBe(values.length);
    const shared = new Set<string>(Object.values(TEST_IDS));
    expect(values.filter((v) => shared.has(v))).toEqual([]);
  });
});
