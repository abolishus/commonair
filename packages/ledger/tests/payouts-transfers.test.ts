// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** M1-connect's pure pieces: the reversal difference and the transfer key (ADR 0007 Amendment 1). */
import { describe, expect, test } from "vite-plus/test";
import {
  PAYOUT_TRANSFER_ATTEMPTS,
  PAYOUT_TRANSFER_BACKOFF_MS,
  PAYOUT_TRANSFER_CODES,
  PAYOUT_TRANSFER_KEY_WINDOW_MS,
  payoutTransferKey,
  reversalDelta,
} from "../src/index.ts";

describe("reversalDelta", () => {
  test("a first partial reversal is all new", () => {
    expect(reversalDelta(0, 1_200, 5_000)).toBe(1_200);
  });

  test("a later total adds only its increase", () => {
    expect(reversalDelta(1_200, 5_000, 5_000)).toBe(3_800);
  });

  test("a redelivery, or an older event, adds nothing", () => {
    expect(reversalDelta(1_200, 1_200, 5_000)).toBe(0);
    expect(reversalDelta(3_000, 1_200, 5_000)).toBe(0);
    expect(reversalDelta(5_000, 5_000, 5_000)).toBe(0);
    expect(reversalDelta(0, 0, 5_000)).toBe(0);
  });

  test("a reported total above the transfer is capped at it", () => {
    expect(reversalDelta(0, 9_999, 5_000)).toBe(5_000);
    expect(reversalDelta(4_000, 9_999, 5_000)).toBe(1_000);
  });

  test("cents only: negative, fractional and impossible inputs are refused", () => {
    expect(() => reversalDelta(-1, 100, 5_000)).toThrow(/recorded/);
    expect(() => reversalDelta(0, -1, 5_000)).toThrow(/reported/);
    expect(() => reversalDelta(0, 1.5, 5_000)).toThrow(/reported/);
    expect(() => reversalDelta(0, 100, 0)).toThrow(/amount/);
    expect(() => reversalDelta(6_000, 100, 5_000)).toThrow(/exceeds/);
  });
});

describe("transfer constants", () => {
  test("the key is the payout's own, the same on every retry", () => {
    expect(payoutTransferKey("p1")).toBe("payout-transfer:p1");
    expect(payoutTransferKey("p1")).toBe(payoutTransferKey("p1"));
  });

  test("failure codes are short opaque codes", () => {
    for (const code of Object.values(PAYOUT_TRANSFER_CODES)) expect(code).toMatch(/^[a-z0-9_]{1,64}$/);
  });

  test("the retries end well inside Stripe's 24-hour idempotency window", () => {
    let total = 0;
    for (let i = 0; i < PAYOUT_TRANSFER_ATTEMPTS - 1; i++) total += PAYOUT_TRANSFER_BACKOFF_MS * 2 ** i;
    expect(total).toBeLessThan(PAYOUT_TRANSFER_KEY_WINDOW_MS);
    expect(PAYOUT_TRANSFER_KEY_WINDOW_MS).toBeLessThan(24 * 3_600_000);
  });
});
