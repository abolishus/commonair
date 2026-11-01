// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Timestamp helpers for raw SQL on the Drizzle-wrapped client (src/w2/sql-time.ts). */
import { describe, expect, test } from "vite-plus/test";
import { toDate, tsParam } from "../../src/w2/sql-time.ts";

describe("sql-time", () => {
  test("tsParam is the ISO 8601 UTC string", () => {
    expect(tsParam(new Date(Date.UTC(2026, 10, 1, 8, 0, 14, 622)))).toBe("2026-11-01T08:00:14.622Z");
  });

  test("toDate reads Postgres timestamptz text (microseconds and short offsets)", () => {
    expect(toDate("2026-10-31 12:34:56.789123+00").toISOString()).toBe("2026-10-31T12:34:56.789Z");
    expect(toDate("2026-10-31 14:34:56+02").toISOString()).toBe("2026-10-31T12:34:56.000Z");
    expect(toDate("2026-10-31T12:34:56.789+00:00").toISOString()).toBe("2026-10-31T12:34:56.789Z");
  });

  test("toDate passes Dates and nulls through and refuses garbage", () => {
    const d = new Date();
    expect(toDate(d)).toBe(d);
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(() => toDate("not a time")).toThrow(/not a timestamp/);
  });
});
