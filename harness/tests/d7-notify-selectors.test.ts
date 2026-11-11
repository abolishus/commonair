// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** d7-notify: every grid and inbox selector the harness names is rendered by the web app's source. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { D7_NOTIFY_IDS, TEST_IDS } from "../src/web/selectors.ts";

const DIR = new URL("../../apps/web/src/components/notifications/", import.meta.url).pathname;
const source = readdirSync(DIR)
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => readFileSync(join(DIR, f), "utf8"))
  .join("\n");

describe("D7_NOTIFY_IDS", () => {
  test.each(Object.entries(D7_NOTIFY_IDS))("%s (%s) is a test id in the notification components", (_name, id) => {
    // As a JSX attribute (a SectionLoadError's `data-testid` prop included).
    expect(source).toMatch(new RegExp(`data-testid=\\{?["'\`]${id}["'\`]`));
  });

  test("the values are unique and do not collide with the shared ids", () => {
    const values = Object.values(D7_NOTIFY_IDS);
    expect(new Set(values).size).toBe(values.length);
    const shared = new Set<string>(Object.values(TEST_IDS));
    expect(values.filter((v) => shared.has(v))).toEqual([]);
  });
});
