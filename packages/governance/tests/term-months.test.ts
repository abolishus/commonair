// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Board terms: calendar-month arithmetic in UTC. */
import { describe, expect, test } from "vite-plus/test";
import { addUtcMonths } from "../src/elections.ts";

const iso = (at: string, months: number) => addUtcMonths(new Date(at), months).toISOString();

describe("addUtcMonths", () => {
  test("keeps the day and time of day when the target month has it", () => {
    expect(iso("2026-06-15T12:34:56.789Z", 12)).toBe("2027-06-15T12:34:56.789Z");
    expect(iso("2026-11-30T23:30:00.000Z", 6)).toBe("2027-05-30T23:30:00.000Z");
    expect(iso("2026-01-01T00:00:00.000Z", 0)).toBe("2026-01-01T00:00:00.000Z");
  });

  test("clamps to the last day of a shorter month instead of spilling into the next", () => {
    expect(iso("2027-01-31T12:00:00.000Z", 1)).toBe("2027-02-28T12:00:00.000Z");
    expect(iso("2028-01-31T12:00:00.000Z", 1)).toBe("2028-02-29T12:00:00.000Z");
    expect(iso("2026-03-31T00:00:00.000Z", 1)).toBe("2026-04-30T00:00:00.000Z");
    expect(iso("2026-08-31T00:00:00.000Z", 1)).toBe("2026-09-30T00:00:00.000Z");
  });

  test("a leap day plus whole years lands on 28 February", () => {
    expect(iso("2028-02-29T09:00:00.000Z", 12)).toBe("2029-02-28T09:00:00.000Z");
    expect(iso("2028-02-29T09:00:00.000Z", 48)).toBe("2032-02-29T09:00:00.000Z");
  });

  test("crosses year boundaries and long terms", () => {
    expect(iso("2026-12-15T00:00:00.000Z", 1)).toBe("2027-01-15T00:00:00.000Z");
    expect(iso("2026-10-31T00:00:00.000Z", 4)).toBe("2027-02-28T00:00:00.000Z");
    expect(iso("2026-06-15T00:00:00.000Z", 36)).toBe("2029-06-15T00:00:00.000Z");
  });

  test("does not mutate its input", () => {
    const at = new Date("2027-01-31T12:00:00.000Z");
    addUtcMonths(at, 1);
    expect(at.toISOString()).toBe("2027-01-31T12:00:00.000Z");
  });
});
