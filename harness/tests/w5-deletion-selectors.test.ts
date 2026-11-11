// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** w5-deletion: every "Members leaving" selector the harness names is a literal test id in the source. */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { W5_DELETION_IDS } from "../src/web/selectors.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const source = readFileSync(`${ROOT}apps/web/src/components/treasury/share-refund-leaving.tsx`, "utf8");

describe("W5_DELETION_IDS", () => {
  test.each(Object.entries(W5_DELETION_IDS))("%s (%s) is a test id in the source", (_name, id) => {
    expect(source.includes(`"data-testid": "${id}"`) || source.includes(`data-testid="${id}"`)).toBe(true);
  });

  test("the values are unique", () => {
    const values = Object.values(W5_DELETION_IDS);
    expect(new Set(values).size).toBe(values.length);
  });
});
