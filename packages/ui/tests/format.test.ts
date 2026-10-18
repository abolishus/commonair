// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  formatCompactNumber,
  formatMoney,
  formatNumber,
  formatRelativeTime,
  getInitial,
  minorDigits,
} from "../src/lib/format.ts";

/** Intl uses narrow/no-break spaces in some locales; compare on plain spaces. */
const plain = (s: string): string => s.replace(/[  ]/g, " ");

describe("formatMoney", () => {
  test("formats integer cents in the currency's minor unit", () => {
    expect(formatMoney(123456, "USD", "en-US")).toBe("$1,234.56");
    expect(formatMoney(5, "USD", "en-US")).toBe("$0.05");
    expect(formatMoney(0, "USD", "en-US")).toBe("$0.00");
  });

  test("zero-decimal currencies treat the minor unit as the whole unit (JPY)", () => {
    expect(minorDigits("JPY")).toBe(0);
    expect(formatMoney(1234, "JPY", "en-US")).toBe("¥1,234");
    expect(plain(formatMoney(1234, "JPY", "ja-JP"))).toMatch(/^(¥|￥)1,234$/);
  });

  test("three-decimal currencies (KWD)", () => {
    expect(minorDigits("KWD")).toBe(3);
    expect(plain(formatMoney(1500, "KWD", "en-US"))).toBe("KWD 1.500");
  });

  test("negative amounts keep their sign and exact digits", () => {
    expect(formatMoney(-500, "USD", "en-US")).toBe("-$5.00");
    expect(formatMoney(-1, "USD", "en-US")).toBe("-$0.01");
    expect(formatMoney(-1234, "JPY", "en-US")).toBe("-¥1,234");
    expect(formatMoney(-99, "EUR", "en-US", { signDisplay: "exceptZero" })).toBe("-€0.99");
    expect(formatMoney(99, "EUR", "en-US", { signDisplay: "exceptZero" })).toBe("+€0.99");
  });

  test("is locale-aware", () => {
    expect(plain(formatMoney(123456, "EUR", "de-DE"))).toBe("1.234,56 €");
    expect(plain(formatMoney(123456, "EUR", "fr-FR"))).toBe("1 234,56 €");
  });

  test("large amounts stay exact (no binary float noise)", () => {
    expect(formatMoney(900719925474099, "USD", "en-US")).toBe("$9,007,199,254,740.99");
    expect(formatMoney(110, "USD", "en-US")).toBe("$1.10");
  });

  test("accepts lower-case currency codes", () => {
    expect(formatMoney(100, "usd", "en-US")).toBe("$1.00");
  });

  test("rejects non-integer and unsafe amounts", () => {
    expect(() => formatMoney(12.5, "USD", "en-US")).toThrow(RangeError);
    expect(() => formatMoney(Number.NaN, "USD", "en-US")).toThrow(RangeError);
    expect(() => formatMoney(2 ** 60, "USD", "en-US")).toThrow(RangeError);
  });
});

describe("formatCompactNumber", () => {
  test("keeps small numbers whole and compacts large ones", () => {
    expect(formatCompactNumber(0, "en")).toBe("0");
    expect(formatCompactNumber(999, "en")).toBe("999");
    expect(formatCompactNumber(1000, "en")).toBe("1K");
    expect(formatCompactNumber(1234, "en")).toBe("1.2K");
    expect(formatCompactNumber(15_300, "en")).toBe("15.3K");
    expect(formatCompactNumber(1_500_000, "en")).toBe("1.5M");
  });

  test("is locale-aware", () => {
    expect(plain(formatCompactNumber(1234, "de"))).toBe("1234");
    expect(plain(formatCompactNumber(1_500_000, "de"))).toBe("1,5 Mio.");
    expect(formatCompactNumber(12_000, "ja")).toBe("1.2万");
  });

  test("full grouping for labels", () => {
    expect(formatNumber(1234567, "en")).toBe("1,234,567");
  });
});

describe("formatRelativeTime", () => {
  const now = Date.UTC(2026, 5, 15, 12, 0, 0);
  const at = (deltaMs: number): Date => new Date(now + deltaMs);

  test("picks the largest fitting unit and truncates", () => {
    expect(formatRelativeTime(at(0), now, "en").text).toBe("now");
    expect(formatRelativeTime(at(-500), now, "en").text).toBe("now");
    expect(formatRelativeTime(at(-5_000), now, "en").text).toBe("5 seconds ago");
    expect(formatRelativeTime(at(-59_999), now, "en").text).toBe("59 seconds ago");
    expect(formatRelativeTime(at(-60_000), now, "en").text).toBe("1 minute ago");
    expect(formatRelativeTime(at(-119_000), now, "en").text).toBe("1 minute ago");
    expect(formatRelativeTime(at(-3 * 3_600_000), now, "en").text).toBe("3 hours ago");
    expect(formatRelativeTime(at(-24 * 3_600_000), now, "en").text).toBe("yesterday");
    expect(formatRelativeTime(at(-8 * 86_400_000), now, "en").text).toBe("last week");
    expect(formatRelativeTime(at(-400 * 86_400_000), now, "en").text).toBe("last year");
    expect(formatRelativeTime(at(2 * 3_600_000), now, "en").text).toBe("in 2 hours");
  });

  test("is locale-aware", () => {
    expect(formatRelativeTime(at(-3 * 60_000), now, "de").text).toBe("vor 3 Minuten");
    expect(formatRelativeTime(at(-86_400_000), now, "fr").text).toBe("hier");
  });

  test("reports when the text next changes", () => {
    expect(formatRelativeTime(at(-5_000), now, "en").nextUpdateMs).toBe(1_000);
    // 90 s ago reads "1 minute ago" until 120 s: 30 s from now.
    expect(formatRelativeTime(at(-90_000), now, "en").nextUpdateMs).toBe(30_000);
    // 3h10m ago reads "3 hours ago" for another 50 minutes.
    expect(formatRelativeTime(at(-(3 * 3_600_000 + 600_000)), now, "en").nextUpdateMs).toBe(50 * 60_000);
    // Never sleeps longer than a day, never spins faster than a second.
    expect(formatRelativeTime(at(-3 * 86_400_000), now, "en").nextUpdateMs).toBe(86_400_000);
    expect(formatRelativeTime(at(-60_000), now, "en").nextUpdateMs).toBe(60_000);
    // Future: "in 2 minutes" (150 s away) changes to "in 1 minute" in 30 s.
    expect(formatRelativeTime(at(150_000), now, "en").nextUpdateMs).toBe(30_000);
    // Months and years do not need live updates.
    expect(formatRelativeTime(at(-60 * 86_400_000), now, "en").nextUpdateMs).toBeNull();
  });
});

describe("getInitial", () => {
  test("first letter, upper-cased", () => {
    expect(getInitial("alice", "en")).toBe("A");
    expect(getInitial("  bob the builder", "en")).toBe("B");
  });

  test("skips leading punctuation and symbols", () => {
    expect(getInitial("@carol", "en")).toBe("C");
    expect(getInitial("__dave__", "en")).toBe("D");
    expect(getInitial("🎮 gamer", "en")).toBe("G");
  });

  test("keeps graphemes whole and respects the locale", () => {
    expect(getInitial("émile", "fr")).toBe("É");
    expect(getInitial("istanbul", "tr")).toBe("İ");
    expect(getInitial("ñandú", "es")).toBe("Ñ");
    expect(getInitial("مريم", "ar")).toBe("م");
    expect(getInitial("山田", "ja")).toBe("山");
    expect(getInitial("42 Club", "en")).toBe("4");
  });

  test("falls back to the first grapheme, or ? when empty", () => {
    expect(getInitial("🎮🎮", "en")).toBe("🎮");
    expect(getInitial("🇺🇦", "en")).toBe("🇺🇦");
    expect(getInitial("", "en")).toBe("?");
    expect(getInitial("   ", "en")).toBe("?");
  });
});
