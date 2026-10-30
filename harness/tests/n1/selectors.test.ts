// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The N1 selectors against docs/testing/n1-selectors.md. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import {
  N1_ROUTE_PATTERNS,
  N1_ROUTES,
  N1_TEST_IDS,
  PUSH_TOGGLE_STATES,
  n1Option,
  n1tid,
} from "../../src/n1/selectors.ts";

const DOC = readFileSync(fileURLToPath(new URL("../../../docs/testing/n1-selectors.md", import.meta.url)), "utf8");

function section(heading: string): string {
  const lines = DOC.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) throw new Error(`no "## ${heading}" section`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

const spans = (text: string) => new Set([...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ""));

describe("N1 selectors match docs/testing/n1-selectors.md", () => {
  test("every test id is in the spec's Test ids section", () => {
    const ids = spans(section("Test ids"));
    for (const id of Object.values(N1_TEST_IDS)) expect(ids.has(id), id).toBe(true);
  });

  test("every row of the Test ids tables is listed (no unlisted id)", () => {
    const listed = new Set<string>(Object.values(N1_TEST_IDS));
    const rows = section("Test ids")
      .split("\n")
      .filter((l) => l.startsWith("| `"));
    expect(rows.length).toBe(listed.size);
    for (const row of rows) {
      const first = /^\| `([^`]+)`/.exec(row)?.[1] ?? "";
      expect(listed.has(first), first).toBe(true);
    }
  });

  test("the Test ids section has the groups the units build against", () => {
    const groups = DOC.split("\n")
      .filter((l) => l.startsWith("### "))
      .map((l) => l.slice(4));
    expect(groups).toEqual([
      "Header (signed in)",
      "Settings (`/settings/notifications`)",
      "Push toggle (inside settings)",
      "Unsubscribe page (`/settings/notifications/unsubscribe`)",
      "PWA",
      "Discord (studio dashboard)",
    ]);
  });

  test("the push toggle's states are the spec's", () => {
    const row = section("Test ids")
      .split("\n")
      .find((l) => l.startsWith("| `push-toggle`"));
    const states = spans(row ?? "");
    for (const s of PUSH_TOGGLE_STATES) expect(states.has(s), s).toBe(true);
  });

  test("the routes are the spec's Routes table", () => {
    const routes = section("Routes")
      .split("\n")
      .filter((l) => l.startsWith("| `"))
      .flatMap((l) => [...(l.split("|")[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ""));
    expect(routes).toEqual([...N1_ROUTE_PATTERNS]);
    const pageRoutes = Object.values(N1_ROUTES).filter((r) => r !== N1_ROUTES.apiUnsubscribe);
    for (const r of pageRoutes) expect(N1_ROUTE_PATTERNS as readonly string[]).toContain(r);
    expect(spans(section("Rules")).has("/api/email/unsubscribe?list=…&token=…")).toBe(true);
  });

  test("option items follow <field>-<value>", () => {
    expect(n1Option(N1_TEST_IDS.channelEmail, "off")).toBe(N1_TEST_IDS.channelEmailOff);
    expect(n1Option(N1_TEST_IDS.channelPush, "default")).toBe(N1_TEST_IDS.channelPushDefault);
    expect(spans(section("Rules")).has("<field>-<value>")).toBe(true);
  });

  test("the scenario's steps are listed in order", () => {
    const steps = section("Scenarios")
      .split("\n")
      .filter((l) => /^\d+\. \*\*/.test(l))
      .map((l) => /^\d+\. \*\*([^*]+)\*\*/.exec(l)?.[1]);
    expect(steps).toEqual([
      "In-app",
      "Email",
      "Cooldown",
      "Push over the API",
      "Inbox",
      "PWA",
      "Push from the browser",
    ]);
  });

  test("n1tid builds attribute selectors with escaping", () => {
    expect(n1tid("notify-channel", { slug: "x" })).toBe('[data-testid="notify-channel"][data-slug="x"]');
    expect(n1tid("a", { b: 'q"z' })).toBe('[data-testid="a"][data-b="q\\"z"]');
  });
});
