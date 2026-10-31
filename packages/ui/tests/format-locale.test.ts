// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The locale-aware formatters N2-ui added (ADR 0029 decision 4), in en, es and de. */
import { describe, expect, test } from "vite-plus/test";
import {
  NO_VALUE,
  currencySymbol,
  formatAmountInput,
  formatInteger,
  formatNumber,
  formatPercent,
  formatUnit,
  monthNames,
  numberSeparators,
  parseAmountInput,
} from "../src/lib/format.ts";

/** Intl uses no-break and narrow no-break spaces in es and de; compare on plain spaces. */
const plain = (s: string): string => s.replace(/[  ]/g, " ");

describe("formatPercent", () => {
  test.each([
    ["en", "12.5%", "0%", "-50%", "10.00%"],
    ["es", "12,5 %", "0 %", "-50 %", "10,00 %"],
    ["de", "12,5 %", "0 %", "-50 %", "10,00 %"],
  ])("%s", (locale, fraction, zero, negative, fixed) => {
    expect(plain(formatPercent(0.125, locale, { maximumFractionDigits: 1 }))).toBe(fraction);
    expect(plain(formatPercent(0, locale))).toBe(zero);
    expect(plain(formatPercent(-0.5, locale))).toBe(negative);
    expect(plain(formatPercent(0.1, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }))).toBe(fixed);
  });

  test("rounds at the fraction limit, never past 100% by accident of display", () => {
    expect(formatPercent(0.99995, "en", { maximumFractionDigits: 2 })).toBe("100%");
    expect(formatPercent(0.99994, "en", { maximumFractionDigits: 2 })).toBe("99.99%");
    expect(formatPercent(0.125, "en")).toBe("13%");
    expect(formatPercent(0.0049, "en")).toBe("0%");
  });

  test("a maximum below the minimum is raised to it; digits are clamped", () => {
    expect(formatPercent(0.5, "en", { minimumFractionDigits: 2, maximumFractionDigits: 0 })).toBe("50.00%");
    expect(formatPercent(0.5, "en", { minimumFractionDigits: -3 })).toBe("50%");
  });

  test("huge values and NaN", () => {
    expect(formatPercent(1e6, "en")).toBe("100,000,000%");
    expect(formatPercent(Number.NaN, "en")).toBe(NO_VALUE);
    expect(formatPercent(Number.NaN, "es")).toBe("—");
  });
});

describe("formatInteger and formatNumber", () => {
  test.each([
    ["en", "1,235", "-1,234", "1,234", "12,345.678"],
    // Spanish groups only from five digits (minimum grouping digits 2).
    ["es", "1235", "-1234", "1234", "12.345,678"],
    ["de", "1.235", "-1.234", "1.234", "12.345,678"],
  ])("%s", (locale, rounded, negative, four, fractional) => {
    expect(formatInteger(1234.5, locale)).toBe(rounded);
    expect(formatInteger(-1234.4, locale)).toBe(negative);
    expect(formatInteger(1234, locale)).toBe(four);
    expect(formatInteger(0, locale)).toBe("0");
    expect(formatNumber(12345.678, locale)).toBe(fractional);
  });

  test("huge numbers keep every digit group; NaN is a dash", () => {
    expect(formatInteger(1e21, "de")).toBe("1.000.000.000.000.000.000.000");
    expect(formatInteger(Number.MAX_SAFE_INTEGER, "en")).toBe("9,007,199,254,740,991");
    expect(formatInteger(Number.NaN, "en")).toBe(NO_VALUE);
  });
});

describe("formatUnit", () => {
  test.each([
    ["en", "1.5 kB", "3 seconds"],
    ["es", "1,5 kB", "3 segundos"],
    ["de", "1,5 kB", "3 Sekunden"],
  ])("%s", (locale, bytes, seconds) => {
    expect(plain(formatUnit(1.5, "kilobyte", locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }))).toBe(
      bytes,
    );
    expect(plain(formatUnit(3, "second", locale, { unitDisplay: "long" }))).toBe(seconds);
  });

  test("defaults to at most three fraction digits; NaN is a dash", () => {
    expect(formatUnit(1.23456, "kilobyte", "en")).toBe("1.235 kB");
    expect(formatUnit(0, "byte", "en")).toBe("0 byte");
    expect(formatUnit(Number.NaN, "byte", "en")).toBe(NO_VALUE);
  });
});

describe("monthNames", () => {
  test.each([
    ["en", "January", "December"],
    ["es", "enero", "diciembre"],
    ["de", "Januar", "Dezember"],
  ])("%s lists twelve months from January", (locale, first, last) => {
    const names = monthNames(locale);
    expect(names).toHaveLength(12);
    expect(names[0]).toBe(first);
    expect(names[11]).toBe(last);
    expect(new Set(names).size).toBe(12);
  });

  test("short names", () => {
    expect(monthNames("en", "short")[8]).toBe("Sep");
  });
});

describe("numberSeparators and currencySymbol", () => {
  test("separators per locale", () => {
    expect(numberSeparators("en")).toEqual({ decimal: ".", group: "," });
    expect(numberSeparators("es")).toEqual({ decimal: ",", group: "." });
    expect(numberSeparators("de")).toEqual({ decimal: ",", group: "." });
    expect(plain(numberSeparators("fr").group)).toBe(" ");
  });

  test("symbols per locale, the code upper-cased", () => {
    expect(currencySymbol("USD", "en")).toBe("$");
    expect(currencySymbol("USD", "es")).toBe("US$");
    expect(currencySymbol("usd", "de")).toBe("$");
    expect(currencySymbol("EUR", "es")).toBe("€");
  });
});

describe("parseAmountInput and formatAmountInput", () => {
  test.each([
    ["en", "1,234.56", "1234.56"],
    ["es", "1.234,56", "1234,56"],
    ["de", "1.234,56", "1234,56"],
  ])("%s reads its own separators and round-trips", (locale, grouped, input) => {
    expect(parseAmountInput(grouped, "USD", locale)).toBe(123456);
    expect(formatAmountInput(123456, "USD", locale)).toBe(input);
    expect(parseAmountInput(input, "USD", locale)).toBe(123456);
    expect(parseAmountInput("12", "USD", locale)).toBe(1200);
    expect(formatAmountInput(0, "USD", locale)).toBe(input.includes(",") ? "0,00" : "0.00");
  });

  test("rejects what is not an amount", () => {
    for (const text of ["", " ", ".", "-5", "abc", "1.2.3", "1.005"])
      expect(parseAmountInput(text, "USD", "en")).toBe(null);
    expect(parseAmountInput("12,5", "JPY", "de")).toBe(null);
    expect(parseAmountInput("9".repeat(20), "USD", "en")).toBe(null);
  });

  test("zero-decimal and three-decimal currencies", () => {
    expect(parseAmountInput("1234", "JPY", "en")).toBe(1234);
    expect(formatAmountInput(1234, "JPY", "de")).toBe("1234");
    expect(parseAmountInput("1.5", "KWD", "en")).toBe(1500);
    expect(formatAmountInput(1500, "kwd", "en")).toBe("1.500");
  });

  test("a whitespace group separator accepts any space (fr)", () => {
    expect(parseAmountInput("1 234,5", "EUR", "fr")).toBe(123450);
    expect(parseAmountInput("1 234,5", "EUR", "fr")).toBe(123450);
  });

  test("negative and huge minor amounts format without float noise; non-integers are empty", () => {
    expect(formatAmountInput(-5, "USD", "en")).toBe("-0.05");
    expect(formatAmountInput(Number.MAX_SAFE_INTEGER, "USD", "en")).toBe("90071992547409.91");
    expect(formatAmountInput(1.5, "USD", "en")).toBe("");
    expect(formatAmountInput(Number.NaN, "USD", "en")).toBe("");
  });
});
