// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** M1-coop-money's `e5-coop` steps: the pure parts (the setting read, the fixture period, the balance check). */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  PATRONAGE_PAY,
  PATRONAGE_PAYOUTS,
  SHARE_BUY_STRIPE,
  cardPaymentsOn,
  fixturePeriod,
  offBalance,
} from "../../src/b8/coop-money.ts";

describe("coop-money", () => {
  test("cardPaymentsOn reads only { enabled: true }", () => {
    expect(cardPaymentsOn([{ key: "shares.cardPayments", value: { enabled: true } }])).toBe(true);
    expect(cardPaymentsOn([{ key: "shares.cardPayments", value: { enabled: false } }])).toBe(false);
    expect(cardPaymentsOn([{ key: "shares.cardPayments", value: { enabled: "true" } }])).toBe(false);
    expect(cardPaymentsOn([{ key: "shares.cardPayments", value: null }])).toBe(false);
    expect(cardPaymentsOn([])).toBe(false);
  });

  test("fixturePeriod: one far-past month per run, stable for a run", () => {
    const a = fixturePeriod("run-a");
    expect(fixturePeriod("run-a")).toEqual(a);
    expect(a.periodStart.getUTCDate()).toBe(1);
    expect(a.periodEnd.getTime()).toBeGreaterThan(a.periodStart.getTime());
    expect(a.periodEnd.getUTCFullYear()).toBeLessThan(2051);
    expect(a.periodStart.getUTCFullYear()).toBeGreaterThanOrEqual(1950);
    const months = new Set(Array.from({ length: 50 }, (_, i) => fixturePeriod(`run-${i}`).periodStart.getTime()));
    expect(months.size).toBeGreaterThan(40);
  });

  test("offBalance keeps only postings that do not sum to zero", () => {
    expect(
      offBalance([
        { key: "a", sum: "0" },
        { key: "b", sum: "-5" },
        { key: "c", sum: "12" },
      ]),
    ).toEqual([
      { key: "b", sum: "-5" },
      { key: "c", sum: "12" },
    ]);
  });

  test("the step names the batch 8 selectors (docs/testing/b8-selectors.md)", () => {
    const doc = readFileSync(new URL("../../../docs/testing/b8-selectors.md", import.meta.url), "utf8");
    for (const id of [SHARE_BUY_STRIPE, PATRONAGE_PAYOUTS, PATRONAGE_PAY]) expect(doc).toContain(`\`${id}\``);
  });

  test("the module no longer carries the contract step's stub", () => {
    const src = readFileSync(new URL("../../src/b8/coop-money.ts", import.meta.url), "utf8");
    expect(src).not.toContain("M1-coop-money not merged");
    expect(src).toContain("export async function stepShareStripe");
    expect(src).toContain("export async function stepPatronagePayout");
  });
});
