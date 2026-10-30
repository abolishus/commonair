// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The W1 selectors against docs/testing/w1-selectors.md. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { INTERNAL_ROUTES, OPS_TICK_JOBS } from "@commonair/contracts/internal";
import { describe, expect, test } from "vite-plus/test";
import {
  W1_OPS_JOBS,
  W1_OPS_TICK,
  W1_ROUTE_PATTERNS,
  W1_ROUTES,
  W1_TEST_IDS,
  w1Option,
  w1tid,
} from "../../src/w1/selectors.ts";

const DOC = readFileSync(fileURLToPath(new URL("../../../docs/testing/w1-selectors.md", import.meta.url)), "utf8");

function section(heading: string): string {
  const lines = DOC.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) throw new Error(`no "## ${heading}" section`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

const spans = (text: string) => new Set([...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ""));

describe("W1 selectors match docs/testing/w1-selectors.md", () => {
  test("the document has the five sections the units build against", () => {
    const sections = DOC.split("\n")
      .filter((l) => l.startsWith("## "))
      .map((l) => l.slice(3));
    expect(sections).toEqual(["Rules", "Routes", "Player seam", "Test ids", "Scenarios"]);
  });

  test("every test id is in the spec's Test ids section", () => {
    const ids = spans(section("Test ids"));
    for (const id of Object.values(W1_TEST_IDS)) expect(ids.has(id), id).toBe(true);
  });

  test("the Test ids section has one group per W1 web unit, plus the studio nav", () => {
    const groups = section("Test ids")
      .split("\n")
      .filter((l) => l.startsWith("### "))
      .map((l) => l.slice(4));
    expect(groups).toEqual(["Studio nav", "Breakdown", "Calm Chat", "Watch gate", "Fraud floor", "Data mode"]);
  });

  test("the routes are the spec's Routes table", () => {
    const routes = section("Routes")
      .split("\n")
      .filter((l) => l.startsWith("| `"))
      .flatMap((l) => [...(l.split("|")[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ""))
      .filter((r) => r.startsWith("/"));
    expect(routes).toEqual([...W1_ROUTE_PATTERNS]);
    const fixed = Object.values(W1_ROUTES).filter((r) => typeof r === "string");
    expect([...fixed].sort()).toEqual([...W1_ROUTE_PATTERNS].sort());
  });

  test("the channel route carries the player seam's diagnostic parameters", () => {
    expect(W1_ROUTES.channel("alice")).toBe("/alice");
    expect(W1_ROUTES.channel("alice", { targetLatency: 12, rendition: "audio" })).toBe(
      "/alice?targetLatency=12&rendition=audio",
    );
    const seam = spans(section("Player seam"));
    expect(seam.has("targetLatency=<seconds>")).toBe(true);
    expect(seam.has("rendition=<name>")).toBe(true);
  });

  test("the ops tick hook is the contract's and the spec's, and knows the W1 jobs", () => {
    expect(W1_OPS_TICK).toBe(INTERNAL_ROUTES.opsTick);
    const rules = spans(section("Rules"));
    expect(rules.has(`POST ${W1_OPS_TICK}`)).toBe(true);
    for (const job of W1_OPS_JOBS) {
      expect(OPS_TICK_JOBS as readonly string[]).toContain(job);
      expect(rules.has(job), job).toBe(true);
    }
  });

  test("option items follow <field>-<value>", () => {
    expect(w1Option("data-mode-budget", "50")).toBe(W1_TEST_IDS.dataModeBudget50);
    expect(w1Option("data-mode-budget", "custom")).toBe(W1_TEST_IDS.dataModeBudgetCustom);
    expect(spans(section("Rules")).has("<field>-<value>")).toBe(true);
  });

  test("w1tid builds attribute selectors with escaping", () => {
    expect(w1tid("fraud-flag", { kind: "x" })).toBe('[data-testid="fraud-flag"][data-kind="x"]');
    expect(w1tid("a", { b: 'q"z' })).toBe('[data-testid="a"][data-b="q\\"z"]');
  });
});
