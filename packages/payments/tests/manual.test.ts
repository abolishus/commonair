// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MANUAL_REFERENCE_PATTERN } from "@commonair/contracts/currency";
import { describe, expect, test } from "vite-plus/test";
import { AdapterUnavailableError, createAdapter } from "../src/factory.ts";
import { fillInstructions, formatPlainAmount } from "../src/format.ts";
import { manualAdapter } from "../src/manual.ts";
import type { CheckoutRequest } from "../src/adapter.ts";

const request: CheckoutRequest = {
  paymentId: "0190a000-0000-7000-8000-000000000001",
  kind: "subscription",
  amountCents: 1099,
  currency: "usd",
  tier: 2,
  quantity: 1,
  recurring: true,
  payerUserId: "0190a000-0000-7000-8000-000000000002",
  creatorUserId: "0190a000-0000-7000-8000-000000000003",
  successUrl: "http://localhost:3000/alice",
  cancelUrl: "http://localhost:3000/alice",
};

describe("formatPlainAmount", () => {
  test("two minor units", () => {
    expect(formatPlainAmount(1099, "usd")).toBe("10.99 USD");
    expect(formatPlainAmount(5, "eur")).toBe("0.05 EUR");
    expect(formatPlainAmount(0, "usd")).toBe("0.00 USD");
    expect(formatPlainAmount(100_000_000, "usd")).toBe("1000000.00 USD");
  });
  test("zero and three minor units", () => {
    expect(formatPlainAmount(500, "jpy")).toBe("500 JPY");
    expect(formatPlainAmount(1234, "kwd")).toBe("1.234 KWD");
  });
  test("negative amounts", () => {
    expect(formatPlainAmount(-250, "usd")).toBe("-2.50 USD");
  });
  test("refuses fractions", () => {
    expect(() => formatPlainAmount(1.5, "usd")).toThrow(RangeError);
  });
});

describe("fillInstructions", () => {
  test("fills every placeholder and leaves other braces", () => {
    expect(
      fillInstructions("Send {amount} quoting {reference}. Again: {reference} {other}", {
        reference: "CA-00000001",
        amount: "5.00 USD",
      }),
    ).toBe("Send 5.00 USD quoting CA-00000001. Again: CA-00000001 {other}");
  });
  test("does not re-expand placeholders inside values", () => {
    expect(fillInstructions("{reference}", { reference: "{amount}", amount: "x" })).toBe("{amount}");
  });
  test("a template without placeholders is returned as is", () => {
    expect(fillInstructions("Pay the treasurer.", { reference: "r", amount: "a" })).toBe("Pay the treasurer.");
  });
});

describe("manualAdapter", () => {
  test("returns instructions with a fresh reference and the formatted amount", async () => {
    const adapter = manualAdapter({ instructions: "Send {amount} with {reference}." });
    expect(adapter.provider).toBe("manual");
    const start = await adapter.startCheckout(request);
    expect(start.kind).toBe("instructions");
    if (start.kind !== "instructions") return;
    expect(start.providerRef).toMatch(MANUAL_REFERENCE_PATTERN);
    expect(start.instructions).toBe(`Send 10.99 USD with ${start.providerRef}.`);
  });
  test("each checkout gets its own reference", async () => {
    let n = 0;
    const adapter = manualAdapter({ instructions: "{reference}", reference: () => `CA-0000000${++n}` });
    const a = await adapter.startCheckout(request);
    const b = await adapter.startCheckout(request);
    expect(a.providerRef).toBe("CA-00000001");
    expect(b.providerRef).toBe("CA-00000002");
  });
});

describe("createAdapter", () => {
  test("manual by default", () => {
    expect(createAdapter({ PAYMENTS_PROVIDER: "manual", MANUAL_PAYMENT_INSTRUCTIONS: "x" }).provider).toBe("manual");
  });
  test("stripe is not built yet", () => {
    expect(() => createAdapter({ PAYMENTS_PROVIDER: "stripe", MANUAL_PAYMENT_INSTRUCTIONS: "x" })).toThrow(
      AdapterUnavailableError,
    );
  });
});
