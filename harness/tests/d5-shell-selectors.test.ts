// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** d5-shell: every studio-shell and account-menu selector the harness names is rendered by the web app. */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { D5_SHELL_IDS, D5_SHELL_MODERATED_LINK_PREFIX } from "../src/web/selectors.ts";

const WEB = new URL("../../apps/web/src/", import.meta.url).pathname;
const FILES = ["components/studio-shell/live-status.tsx", "routes/_studio.tsx", "components/shell/account-items.tsx"];
const source = FILES.map((f) => readFileSync(WEB + f, "utf8")).join("\n");

describe("D5_SHELL_IDS", () => {
  test.each(Object.entries(D5_SHELL_IDS))("%s (%s) is a test id in the studio shell", (_name, id) => {
    expect(source).toContain(`data-testid="${id}"`);
  });

  test("the moderated link prefix is the one the studio nav renders", () => {
    expect(source).toContain("data-testid={`" + D5_SHELL_MODERATED_LINK_PREFIX + "${channel}`}");
  });

  test("the values are unique", () => {
    const values = Object.values(D5_SHELL_IDS);
    expect(new Set(values).size).toBe(values.length);
  });
});
