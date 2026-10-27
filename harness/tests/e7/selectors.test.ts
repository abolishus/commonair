// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The E7 selectors against docs/testing/e7-selectors.md. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { INTERNAL_ROUTES } from "@commonair/contracts/internal";
import { describe, expect, test } from "vite-plus/test";
import {
  E7_DMCA_TICK,
  E7_ID_PATTERNS,
  E7_ROUTE_PATTERNS,
  E7_ROUTES,
  E7_TEST_IDS,
  e7Option,
  e7tid,
} from "../../src/e7/selectors.ts";

const DOC = readFileSync(fileURLToPath(new URL("../../../docs/testing/e7-selectors.md", import.meta.url)), "utf8");

function section(heading: string): string {
  const lines = DOC.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) throw new Error(`no "## ${heading}" section`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

const spans = (text: string) => new Set([...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ""));

describe("E7 selectors match docs/testing/e7-selectors.md", () => {
  test("every test id is in the spec's Test ids section", () => {
    const ids = spans(section("Test ids"));
    for (const id of Object.values(E7_TEST_IDS)) expect(ids.has(id), id).toBe(true);
  });

  test("every per-item id pattern is in the spec, and builds ids with its prefix", () => {
    const ids = spans(section("Test ids"));
    for (const p of Object.values(E7_ID_PATTERNS)) {
      expect(ids.has(p.template), p.template).toBe(true);
      expect(p.id("x")).toBe(p.template.replace(/<[^>]+>$/, "x"));
    }
  });

  test("the Test ids section has the groups the units build against", () => {
    const groups = DOC.split("\n")
      .filter((l) => l.startsWith("### "))
      .map((l) => l.slice(4));
    expect(groups).toHaveLength(10);
    expect(groups[0]).toBe("DMCA notice (`/dmca`)");
    expect(groups.at(-1)).toBe("Legal");
  });

  test("the routes are the spec's Routes table", () => {
    const routes = section("Routes")
      .split("\n")
      .filter((l) => l.startsWith("| `"))
      .flatMap((l) => [...(l.split("|")[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ""));
    expect(routes).toEqual([...E7_ROUTE_PATTERNS]);
    const fixed = Object.values(E7_ROUTES).filter((r) => typeof r === "string");
    for (const r of fixed) expect(E7_ROUTE_PATTERNS as readonly string[]).toContain(r);
    expect(E7_ROUTES.channel("alice")).toBe("/alice");
  });

  test("the dmca-tick hook is the contract's and the spec's", () => {
    expect(E7_DMCA_TICK).toBe(INTERNAL_ROUTES.dmcaTick);
    expect(spans(section("Rules")).has(`POST ${E7_DMCA_TICK}`)).toBe(true);
  });

  test("option items follow <field>-<value>", () => {
    expect(e7Option("dmcaq-status", "received")).toBe("dmcaq-status-received");
    expect(spans(section("Rules")).has("<field>-<value>")).toBe(true);
  });

  test("e7tid builds attribute selectors with escaping", () => {
    expect(e7tid("dmcaq-item", { "notice-id": "x" })).toBe('[data-testid="dmcaq-item"][data-notice-id="x"]');
    expect(e7tid("a", { b: 'q"z' })).toBe('[data-testid="a"][data-b="q\\"z"]');
  });
});
