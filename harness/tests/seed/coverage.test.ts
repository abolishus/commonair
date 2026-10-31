// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { schemaTableNames } from "@commonair/db";
import { describe, expect, test } from "vite-plus/test";
import { FIXED_ACCOUNTS } from "../../src/seed/accounts.ts";
import { coverageProblems, pendingTables } from "../../src/seed/coverage.ts";
import { SEED_ROUTES, routeTreeFullPaths } from "../../src/seed/routes.ts";
import { SEED_UNIT_NAMES, type SeedUnit } from "../../src/seed/types.ts";
import { SEED_UNITS, orderUnits } from "../../src/seed/units.ts";

const byText = (a: string, b: string) => a.localeCompare(b);

const routeTree = readFileSync(
  fileURLToPath(new URL("../../../apps/web/src/routeTree.gen.ts", import.meta.url)),
  "utf8",
);

const stub = (name: SeedUnit["name"], tables: string[], extra: Partial<SeedUnit> = {}): SeedUnit => ({
  name,
  after: [],
  tables,
  pending: [],
  run: async () => ({ rows: {} }),
  ...extra,
});

describe("table coverage", () => {
  test("every schema table belongs to exactly one unit, the base seed or NOT_SEEDED", () => {
    expect(coverageProblems(schemaTableNames(), SEED_UNITS)).toEqual({
      unclaimed: [],
      duplicated: [],
      unknown: [],
      strayPending: [],
    });
  });

  test("coverageProblems finds unclaimed, duplicated, unknown and stray pending tables", () => {
    const units = [stub("social", ["users", "ghost"], { pending: ["chat_messages"] }), stub("money", ["users"])];
    const p = coverageProblems(["users", "tips", "verifications"], units);
    expect(p.unclaimed).toEqual(["tips"]);
    expect(p.duplicated).toEqual([{ table: "users", by: ["seed-social", "seed-money"] }]);
    expect(p.unknown).toEqual(expect.arrayContaining(["ghost"]));
    expect(p.strayPending).toEqual([{ unit: "social", table: "chat_messages" }]);
  });

  test("pendingTables lists only units with something left", () => {
    expect(pendingTables([stub("social", ["users"]), stub("money", ["tips"], { pending: ["tips"] })])).toEqual({
      money: ["tips"],
    });
  });
});

describe("units", () => {
  test("one module per unit name, social first, and an acyclic order", () => {
    expect(SEED_UNITS.map((u) => u.name).sort()).toEqual([...SEED_UNIT_NAMES].sort());
    const order = orderUnits(SEED_UNITS).map((u) => u.name);
    expect(order[0]).toBe("social");
    for (const u of SEED_UNITS)
      for (const dep of u.after) expect(order.indexOf(dep)).toBeLessThan(order.indexOf(u.name));
  });

  test("orderUnits rejects cycles and unknown dependencies", () => {
    expect(() =>
      orderUnits([stub("social", [], { after: ["money"] }), stub("money", [], { after: ["social"] })]),
    ).toThrow(/cycle/);
    expect(() => orderUnits([stub("social", [], { after: ["coop"] })])).toThrow(/unknown unit coop/);
  });
});

describe("route coverage", () => {
  test("SEED_ROUTES lists exactly the web app's routes", () => {
    expect(Object.keys(SEED_ROUTES).sort()).toEqual(routeTreeFullPaths(routeTree));
  });

  test("every route is visited by a fixed login or anonymously, and params match the path", () => {
    const handles = new Set(FIXED_ACCOUNTS.map((a) => a.handle));
    for (const [path, r] of Object.entries(SEED_ROUTES)) {
      expect(r.as === "anonymous" || handles.has(r.as), `${path}: ${r.as}`).toBe(true);
      const want = [...path.matchAll(/\$(\w+)/g)].map((m) => m[1] as string).sort(byText);
      expect(Object.keys(r.params ?? {}).sort(byText), path).toEqual(want);
      const channelOwners = [...Object.values(r.params ?? {}), ...(r.query ? [r.query] : [])].flatMap((v) =>
        "channelOf" in v ? [v.channelOf] : [],
      );
      for (const h of channelOwners) expect(FIXED_ACCOUNTS.find((a) => a.handle === h)?.streamer, path).toBe(true);
    }
  });

  test("routeTreeFullPaths reads the interface keys only", () => {
    const src =
      "export interface FileRoutesByFullPath {\n  '/': typeof A\n  '/x/$id': typeof B\n}\nconst y = { '/nope': 1 }";
    expect(routeTreeFullPaths(src)).toEqual(["/", "/x/$id"]);
    expect(() => routeTreeFullPaths("")).toThrow(/not found/);
  });
});

describe("fixed accounts", () => {
  test("unique handles that fit a username, one admin, treasurer and legal, and a bot owner", () => {
    const handles = FIXED_ACCOUNTS.map((a) => a.handle);
    expect(new Set(handles).size).toBe(handles.length);
    for (const h of handles) expect(h).toMatch(/^[a-z0-9]{2,20}$/);
    for (const role of ["admin", "treasurer", "legal", "moderator"] as const)
      expect(FIXED_ACCOUNTS.filter((a) => a.platformRole === role)).toHaveLength(1);
    expect(FIXED_ACCOUNTS.find((a) => a.handle === "streamer1")?.streamer).toBe(true);
  });
});
