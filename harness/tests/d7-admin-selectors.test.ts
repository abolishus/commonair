// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** d7-admin: every admin console selector the harness names is a test id in the web app's source. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { D7_ADMIN_IDS, D7_ADMIN_ROUTES, TEST_IDS } from "../src/web/selectors.ts";

const WEB = join(import.meta.dirname, "../../apps/web/src");
const FILES = [
  "routes/_admin.tsx",
  "components/admin/overview.tsx",
  "components/admin/audit-log.tsx",
  "components/admin/user-view.tsx",
  "components/safety/mod-queue.tsx",
];
const source = FILES.map((f) => readFileSync(join(WEB, f), "utf8")).join("\n");

describe("D7_ADMIN_IDS", () => {
  test.each(Object.entries(D7_ADMIN_IDS))("%s (%s) is a test id in the admin console's source", (_name, id) => {
    // As a JSX attribute, or as a prop entry (`"data-testid": "…"`).
    expect(source).toMatch(new RegExp(`(data-testid=\\{?["'\`]${id}["'\`]|"data-testid": "${id}")`));
  });

  test("the values are unique and do not collide with the shared ids", () => {
    const values = Object.values(D7_ADMIN_IDS);
    expect(new Set(values).size).toBe(values.length);
    const shared = new Set<string>(Object.values(TEST_IDS));
    expect(values.filter((v) => shared.has(v))).toEqual([]);
  });

  test("routes", () => {
    expect(D7_ADMIN_ROUTES.adminHome).toBe("/admin");
    expect(D7_ADMIN_ROUTES.adminUser("Mara x")).toBe("/admin/users/Mara%20x");
  });
});
