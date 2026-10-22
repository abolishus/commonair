// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The E6 selectors against docs/testing/e6-selectors.md, and the five scenarios' registration. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { validateScenario } from "../../src/registry.ts";
import {
  CONFIRM_DIALOG_CONFIRM,
  E6_ROUTE_PATTERNS,
  E6_TEST_IDS,
  OVERLAY_EXPIRY_CHOICES,
  etid,
  optionId,
} from "../../src/e6/selectors.ts";

const DOC = readFileSync(fileURLToPath(new URL("../../../docs/testing/e6-selectors.md", import.meta.url)), "utf8");

function section(heading: string): string {
  const lines = DOC.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) throw new Error(`no "## ${heading}" section`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

const spans = (text: string) => new Set([...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ""));

describe("E6 selectors match docs/testing/e6-selectors.md", () => {
  test("every test id is in the spec (Test ids, or the selector conventions)", () => {
    const ids = new Set([...spans(section("Test ids")), ...spans(section("`full` and the `no-proprietary` profile"))]);
    for (const id of Object.values(E6_TEST_IDS)) expect(ids.has(id), id).toBe(true);
    expect(ids.has(CONFIRM_DIALOG_CONFIRM)).toBe(true);
  });

  test("the overlay-expiry choices are the spec's", () => {
    const row = section("Test ids")
      .split("\n")
      .find((l) => l.startsWith("| `overlay-expiry`"));
    expect(row).toBeDefined();
    const values = [...(row ?? "").split("|")[2]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    expect(values).toEqual([...OVERLAY_EXPIRY_CHOICES]);
  });

  test("the routes are the spec's Routes table", () => {
    const routes = section("Routes")
      .split("\n")
      .filter((l) => l.startsWith("| `"))
      .flatMap((l) => [...(l.split("|")[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ""));
    expect(routes).toEqual([...E6_ROUTE_PATTERNS]);
  });

  test("option ids follow the convention and match the spec's examples", () => {
    expect(optionId("overlay-expiry", "7d")).toBe("overlay-expiry-option-7d");
    expect(optionId("vod-visibility", "private")).toBe("vod-visibility-option-private");
    const conventions = spans(section("`full` and the `no-proprietary` profile"));
    expect(conventions.has(optionId("overlay-expiry", "7d"))).toBe(true);
    expect(conventions.has(optionId("vod-visibility", "private"))).toBe(true);
  });

  test("etid builds attribute selectors with escaping", () => {
    expect(etid("vod-row", { "vod-id": "x" })).toBe('[data-testid="vod-row"][data-vod-id="x"]');
    expect(etid("a", { b: 'q"z' })).toBe('[data-testid="a"][data-b="q\\"z"]');
  });
});

describe("the five E6 feature scenarios", () => {
  const names = ["simulcast", "overlay-alert", "vod-clips", "data-export", "account-deletion"] as const;

  test.each(names)("%s is a valid scenario named after its file", async (name) => {
    const mod = (await import(`../../scenarios/${name}.ts`)) as { default: unknown };
    const s = validateScenario(mod.default, `${name}.ts`);
    expect(s.name).toBe(name);
    expect(s.inFull).not.toBe(false);
    expect(s.needs).toContain("api");
    expect(s.timeoutMs ?? 0).toBeGreaterThan(0);
  });

  test("the scenarios that confirm payments, mail or tick jobs need the worker", async () => {
    for (const name of ["overlay-alert", "vod-clips", "data-export", "account-deletion"]) {
      const mod = (await import(`../../scenarios/${name}.ts`)) as { default: { needs: readonly string[] } };
      expect(mod.default.needs, name).toContain("worker");
    }
  });
});
