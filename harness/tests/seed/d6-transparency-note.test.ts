// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Overhaul D6.1: seed-coop writes one treasurer note on a recent transparency month. */
import { describe, expect, test } from "vite-plus/test";
import { unit } from "../../src/seed/coop.ts";
import { transparencyNotePlan } from "../../src/seed/coop/plan.ts";
import { NOT_SEEDED } from "../../src/seed/coverage.ts";

const NOW = new Date("2026-11-11T09:30:00Z");

describe("seed-coop's transparency note", () => {
  test("seed-coop owns transparency_notes and it is no longer NOT_SEEDED", () => {
    expect(unit.tables).toContain("transparency_notes");
    expect(Object.keys(NOT_SEEDED)).not.toContain("transparency_notes");
  });

  test("the note goes on money's revenue month, which has ledger activity", () => {
    expect(transparencyNotePlan(NOW, "2026-10").month).toBe("2026-10");
  });

  test("without a well-formed revenue month it goes on the current UTC month", () => {
    expect(transparencyNotePlan(NOW, null).month).toBe("2026-11");
    expect(transparencyNotePlan(NOW, "2026-13").month).toBe("2026-11");
    expect(transparencyNotePlan(NOW, "October").month).toBe("2026-11");
    expect(transparencyNotePlan(new Date("2026-12-31T23:59:59Z"), null).month).toBe("2026-12");
  });

  test("the body fits the contract (1 to 2000 characters), says it is seed data and names nobody", () => {
    const { body } = transparencyNotePlan(NOW, null);
    expect(body.trim().length).toBeGreaterThan(0);
    expect(body.length).toBeLessThanOrEqual(2000);
    expect(body).toMatch(/^Seed data:/);
    expect(body).not.toMatch(/@/);
  });
});
