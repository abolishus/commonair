// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { formatHour, formatIsoDuration } from "../src/lib/format.ts";
import * as ui from "../src/index.ts";

/** ICU puts a narrow or plain no-break space before the day period in some versions. */
const plain = (s: string): string => s.replace(/[  ]/g, " ");
const ALL_HOURS = Array.from({ length: 24 }, (_, h) => h);

describe("formatHour", () => {
  test("en-US: a 12-hour clock with the day period", () => {
    expect(plain(formatHour(0, "en-US"))).toBe("12 AM");
    expect(plain(formatHour(1, "en-US"))).toBe("1 AM");
    expect(plain(formatHour(11, "en-US"))).toBe("11 AM");
    expect(plain(formatHour(12, "en-US"))).toBe("12 PM");
    expect(plain(formatHour(15, "en-US"))).toBe("3 PM");
    expect(plain(formatHour(23, "en-US"))).toBe("11 PM");
  });

  test("24-hour locales: the hour alone, no 'Uhr' or 'h'", () => {
    expect(formatHour(0, "es")).toBe("0");
    expect(formatHour(9, "es")).toBe("9");
    expect(formatHour(12, "es")).toBe("12");
    expect(formatHour(15, "es")).toBe("15");
    expect(formatHour(23, "es")).toBe("23");
    expect(formatHour(15, "de")).toBe("15");
    expect(formatHour(0, "de")).toMatch(/^0?0$/);
    expect(formatHour(15, "fr")).toBe("15");
    expect(formatHour(23, "en-GB")).toBe("23");
    expect(formatHour(15, "ja")).toBe("15");
  });

  test("every hour of the day is distinct in each locale (a picker never shows two the same)", () => {
    for (const locale of ["en-US", "en-GB", "es", "de", "fr", "ja", "ko", "ar"]) {
      const labels = ALL_HOURS.map((h) => formatHour(h, locale));
      expect(new Set(labels).size, locale).toBe(24);
      for (const label of labels) expect(label.trim(), locale).not.toBe("");
    }
  });

  test("other 12-hour locales keep their own day period", () => {
    expect(formatHour(15, "ko")).not.toBe(formatHour(3, "ko"));
    expect(formatHour(15, "ko")).toContain("3");
  });

  test("is not shifted by a time zone or daylight saving", () => {
    // Formatted as UTC on a fixed day: the result depends on the locale only.
    expect(ALL_HOURS.map((h) => formatHour(h, "es"))).toEqual(ALL_HOURS.map(String));
  });

  test("throws for anything outside 0-23 or not an integer", () => {
    for (const bad of [-1, 24, 25, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
      expect(() => formatHour(bad, "en-US"), String(bad)).toThrow(RangeError);
  });

  test("is exported from the package index", () => {
    expect(ui.formatHour).toBe(formatHour);
    expect(ui.formatIsoDuration).toBe(formatIsoDuration);
  });
});

describe("formatIsoDuration", () => {
  test("whole seconds to an ISO 8601 duration", () => {
    expect(formatIsoDuration(0)).toBe("PT0S");
    expect(formatIsoDuration(59)).toBe("PT59S");
    expect(formatIsoDuration(60)).toBe("PT1M");
    expect(formatIsoDuration(3600)).toBe("PT1H");
    expect(formatIsoDuration(3723)).toBe("PT1H2M3S");
    expect(formatIsoDuration(172_800)).toBe("PT48H");
  });

  test("negative, fractional and non-finite input floors at zero", () => {
    expect(formatIsoDuration(-1)).toBe("PT0S");
    expect(formatIsoDuration(59.9)).toBe("PT59S");
    expect(formatIsoDuration(Number.NaN)).toBe("PT0S");
  });
});
