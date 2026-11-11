// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** d5-content: every content and overlays selector the harness names is rendered by the source. */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { D5_CONTENT_IDS } from "../src/web/selectors.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const FILES = [
  "packages/ui/src/blocks/studio/content-board.tsx",
  "packages/ui/src/blocks/studio/overlay-token.tsx",
  "apps/web/src/components/overlays-studio.tsx",
];
const source = FILES.map((f) => readFileSync(`${ROOT}${f}`, "utf8")).join("\n");

const fixed: [string, string][] = Object.entries(D5_CONTENT_IDS).flatMap(([name, id]) =>
  typeof id === "string" ? [[name, id] as [string, string]] : [],
);

describe("D5_CONTENT_IDS", () => {
  test.each(fixed)("%s (%s) is a test id in the source", (_name, id) => {
    // Literal test ids, or the overlay link ids built as `overlay-url-${kind}`.
    const literal = new RegExp(`data-testid=\\{?["'\`]${id}["'\`]`).test(source);
    const built = id.startsWith("overlay-url-") && source.includes("`overlay-url-${kind}`");
    expect(literal || built).toBe(true);
  });

  test("alert tabs are built per type", () => {
    expect(source).toContain("data-testid={`alert-tab-${type}`}");
    expect(D5_CONTENT_IDS.alertTab("raid")).toBe("alert-tab-raid");
  });

  test("failure screenshots blank all three overlay links (each holds the token)", async () => {
    const { REDACT_SELECTORS } = await import("../src/e6/kit.ts");
    for (const id of ["overlay-url", D5_CONTENT_IDS.overlayUrlChat, D5_CONTENT_IDS.overlayUrlGoals])
      expect(REDACT_SELECTORS).toContain(`[data-testid="${id}"]`);
  });

  test("the values are unique", () => {
    const values = fixed.map(([, v]) => v);
    expect(new Set(values).size).toBe(values.length);
  });
});
