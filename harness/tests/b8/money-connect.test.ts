// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** M1-connect's `e4b-money` steps: the fixture amount and the entry points the scenario imports. */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  PAYOUT_TRANSFERS,
  PAYOUT_TRANSFER_STATUS,
  TREASURY_TAB_TRANSFERS,
  connectTipCents,
  stepConnectTransfer,
  stepTransferReversed,
} from "../../src/b8/money-connect.ts";

describe("connectTipCents", () => {
  test("the payee's share reaches the payout minimum", () => {
    for (const [minimum, share] of [
      [2_500, 0.9],
      [2_500, 1],
      [10_000, 0.85],
      [0, 0.9],
    ] as const) {
      const gross = connectTipCents(minimum, share);
      expect(Number.isSafeInteger(gross)).toBe(true);
      expect(Math.floor(gross * share)).toBeGreaterThanOrEqual(minimum);
    }
  });

  test("never so large that the first payout raises new_payee", () => {
    expect(() => connectTipCents(60_000, 0.9)).toThrow(/new_payee/);
    expect(connectTipCents(2_500, 0.9, 50_000)).toBeLessThan(50_000);
  });

  test("a share outside (0, 1] is refused", () => {
    expect(() => connectTipCents(2_500, 0)).toThrow(RangeError);
    expect(() => connectTipCents(2_500, 1.5)).toThrow(RangeError);
  });
});

describe("the steps", () => {
  test("are the filled entry points, not the contract step's stub", () => {
    expect(typeof stepConnectTransfer).toBe("function");
    expect(typeof stepTransferReversed).toBe("function");
    const src = readFileSync(new URL("../../src/b8/money-connect.ts", import.meta.url), "utf8");
    expect(src).not.toContain("not merged");
  });

  test("read the test ids docs/testing/b8-selectors.md names", () => {
    const doc = readFileSync(new URL("../../../docs/testing/b8-selectors.md", import.meta.url), "utf8");
    for (const id of [TREASURY_TAB_TRANSFERS, PAYOUT_TRANSFERS, PAYOUT_TRANSFER_STATUS])
      expect(doc).toContain(`\`${id}\``);
  });
});
