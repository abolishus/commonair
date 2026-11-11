// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** d6-studio: every Get paid and co-op card selector the harness names is rendered by the web app's source. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { D6_STUDIO_IDS } from "../src/web/selectors.ts";

const WEB = new URL("../../apps/web/src/components/", import.meta.url).pathname;
const DIRS = ["setup-checklist", "studio-coop"];
const source = DIRS.flatMap((d) =>
  readdirSync(join(WEB, d))
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => readFileSync(join(WEB, d, f), "utf8")),
).join("\n");

describe("D6_STUDIO_IDS", () => {
  test.each(Object.entries(D6_STUDIO_IDS))("%s (%s) is a test id in the studio's components", (_name, id) => {
    expect(source).toMatch(new RegExp(`(data-testid|retryTestId|data-[a-z-]*testid)=\\{?["'\`]${id}["'\`]`));
  });

  test("the values are unique", () => {
    const values = Object.values(D6_STUDIO_IDS);
    expect(new Set(values).size).toBe(values.length);
  });
});
