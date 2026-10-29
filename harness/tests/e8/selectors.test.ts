// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The E8 selectors against docs/testing/e8-selectors.md. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { INTERNAL_ROUTES } from "@commonair/contracts/internal";
import { describe, expect, test } from "vite-plus/test";
import {
  E8_ID_PATTERNS,
  E8_INTERACT_TICK,
  E8_ROUTE_PATTERNS,
  E8_ROUTES,
  E8_TEST_IDS,
  e8Option,
  e8tid,
} from "../../src/e8/selectors.ts";

const DOC = readFileSync(fileURLToPath(new URL("../../../docs/testing/e8-selectors.md", import.meta.url)), "utf8");

function section(heading: string): string {
  const lines = DOC.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) throw new Error(`no "## ${heading}" section`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

const spans = (text: string) => new Set([...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ""));

describe("E8 selectors match docs/testing/e8-selectors.md", () => {
  test("every test id is in the spec's Test ids section", () => {
    const ids = spans(section("Test ids"));
    for (const id of Object.values(E8_TEST_IDS)) expect(ids.has(id), id).toBe(true);
  });

  test("every per-item id pattern is in the spec, and builds ids with its prefix", () => {
    const ids = spans(section("Test ids"));
    for (const p of Object.values(E8_ID_PATTERNS)) {
      expect(ids.has(p.template), p.template).toBe(true);
      expect(p.id("x")).toBe(p.template.replace(/<[^>]+>$/, "x"));
    }
  });

  test("the Test ids section has the groups the units build against", () => {
    const groups = DOC.split("\n")
      .filter((l) => l.startsWith("### "))
      .map((l) => l.slice(4));
    expect(groups).toHaveLength(8);
    expect(groups[0]).toBe("Studio nav");
    expect(groups.at(-1)).toBe("Overlays");
  });

  test("the routes are the spec's Routes table", () => {
    const routes = section("Routes")
      .split("\n")
      .filter((l) => l.startsWith("| `"))
      .flatMap((l) => [...(l.split("|")[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ""));
    expect(routes).toEqual([...E8_ROUTE_PATTERNS]);
    const fixed = Object.values(E8_ROUTES).filter((r) => typeof r === "string");
    for (const r of fixed) expect(E8_ROUTE_PATTERNS as readonly string[]).toContain(r);
    expect(E8_ROUTES.channel("alice")).toBe("/alice");
  });

  test("the interact tick hook is the contract's and the spec's", () => {
    expect(E8_INTERACT_TICK).toBe(INTERNAL_ROUTES.interactTick);
    expect(spans(section("Rules")).has(`POST ${E8_INTERACT_TICK}`)).toBe(true);
  });

  test("option items follow <field>-<value>", () => {
    expect(e8Option("raid-policy", "off")).toBe(E8_TEST_IDS.raidPolicyOff);
    expect(e8Option("goal-type", "tips")).toBe(E8_TEST_IDS.goalTypeTips);
    expect(spans(section("Rules")).has("<field>-<value>")).toBe(true);
  });

  test("e8tid builds attribute selectors with escaping", () => {
    expect(e8tid("poll-live", { "poll-id": "x" })).toBe('[data-testid="poll-live"][data-poll-id="x"]');
    expect(e8tid("a", { b: 'q"z' })).toBe('[data-testid="a"][data-b="q\\"z"]');
  });
});
