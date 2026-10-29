// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The E9 selectors against docs/testing/e9-selectors.md. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { APP_SUSPENSION_REASONS } from "@commonair/contracts/enums";
import { describe, expect, test } from "vite-plus/test";
import { E9_ID_PATTERNS, E9_ROUTE_PATTERNS, E9_ROUTES, E9_TEST_IDS, e9Option, e9tid } from "../../src/e9/selectors.ts";

const DOC = readFileSync(fileURLToPath(new URL("../../../docs/testing/e9-selectors.md", import.meta.url)), "utf8");

function section(heading: string): string {
  const lines = DOC.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) throw new Error(`no "## ${heading}" section`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

const spans = (text: string) => new Set([...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ""));

describe("E9 selectors match docs/testing/e9-selectors.md", () => {
  test("every test id is in the spec's Test ids section", () => {
    const ids = spans(section("Test ids"));
    for (const id of Object.values(E9_TEST_IDS)) expect(ids.has(id), id).toBe(true);
  });

  test("every id-shaped span of the Test ids tables is listed (no unlisted id)", () => {
    const listed = new Set<string>(Object.values(E9_TEST_IDS));
    const templates = new Set<string>(Object.values(E9_ID_PATTERNS).map((p) => p.template));
    const rows = section("Test ids")
      .split("\n")
      .filter((l) => l.startsWith("| `"));
    // The first column of every table row is a test id.
    for (const row of rows) {
      const first = /^\| `([^`]+)`/.exec(row)?.[1] ?? "";
      expect(listed.has(first) || templates.has(first), first).toBe(true);
    }
  });

  test("every per-item id pattern is in the spec, and builds ids with its prefix", () => {
    const ids = spans(section("Test ids"));
    for (const p of Object.values(E9_ID_PATTERNS)) {
      expect(ids.has(p.template), p.template).toBe(true);
      expect(p.id("x")).toBe(p.template.replace(/<[^>]+>$/, "x"));
    }
  });

  test("suspension reasons are the contract's enum", () => {
    expect(spans(section("Test ids")).has("APP_SUSPENSION_REASONS")).toBe(true);
    expect(APP_SUSPENSION_REASONS.map((r) => E9_ID_PATTERNS.adminappReason.id(r))).toContain("adminapp-reason-spam");
  });

  test("the Test ids section has the groups the units build against", () => {
    const groups = DOC.split("\n")
      .filter((l) => l.startsWith("### "))
      .map((l) => l.slice(4));
    expect(groups).toEqual([
      "Consent (`/oauth2/authorize`)",
      "Device activation (`/activate`)",
      "Connections (`/settings/connections`)",
      "Developer console (`/developer`, `/developer/apps/$appId`)",
      "Bots and tokens (`/developer/bots`)",
      "Apps (`/admin/apps`)",
    ]);
  });

  test("the routes are the spec's Routes table", () => {
    const routes = section("Routes")
      .split("\n")
      .filter((l) => l.startsWith("| `"))
      .flatMap((l) => [...(l.split("|")[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ""));
    expect(routes).toEqual([...E9_ROUTE_PATTERNS]);
    const fixed = Object.values(E9_ROUTES).filter((r) => typeof r === "string");
    for (const r of fixed) expect(E9_ROUTE_PATTERNS as readonly string[]).toContain(r);
    expect(E9_ROUTES.developerApp("a1")).toBe("/developer/apps/a1");
  });

  test("option items follow <field>-<value>", () => {
    expect(e9Option("adminapp-reason", "spam")).toBe("adminapp-reason-spam");
    expect(spans(section("Rules")).has("<field>-<value>")).toBe(true);
  });

  test("e9tid builds attribute selectors with escaping", () => {
    expect(e9tid("devapp-row", { "app-id": "x" })).toBe('[data-testid="devapp-row"][data-app-id="x"]');
    expect(e9tid("a", { b: 'q"z' })).toBe('[data-testid="a"][data-b="q\\"z"]');
  });
});
