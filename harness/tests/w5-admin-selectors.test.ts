// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** w5-admin: every appeal queue selector the harness names is a test id in the web app's source. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { D7_ADMIN_IDS, TEST_IDS, W5_ADMIN_IDS } from "../src/web/selectors.ts";

const source = readFileSync(join(import.meta.dirname, "../../apps/web/src/components/safety/appeal-queue.tsx"), "utf8");

describe("W5_ADMIN_IDS", () => {
  test.each(Object.entries(W5_ADMIN_IDS))("%s (%s) is a test id in the appeal queue's source", (_name, id) => {
    expect(source).toMatch(new RegExp(`data-testid=\\{?["'\`]${id}["'\`]`));
  });

  test("the values are unique and do not collide with the shared or d7-admin ids", () => {
    const values = Object.values(W5_ADMIN_IDS);
    expect(new Set(values).size).toBe(values.length);
    const taken = new Set<string>([...Object.values(TEST_IDS), ...Object.values(D7_ADMIN_IDS)]);
    expect(values.filter((v) => taken.has(v))).toEqual([]);
  });
});
