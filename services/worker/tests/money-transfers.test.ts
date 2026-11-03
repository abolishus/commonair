// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** M1-connect's pure pieces of the `payout-transfers` job: failure codes and the adapter it uses. */
import { describe, expect, test } from "vite-plus/test";
import { StripeRequestError } from "@commonair/payments";
import { PAYOUT_TRANSFER_ATTEMPTS } from "@commonair/ledger";
import { job } from "../src/jobs/payout-transfers.ts";
import { failureCodeOf, isAccountRefusal, transferAdapterFromEnv } from "../src/money/transfers.ts";

const refusal = (code: string | null, status = 400) =>
  new StripeRequestError("refused", status, "invalid_request_error", code);

describe("failure codes", () => {
  test("Stripe's own code when it is a short code", () => {
    expect(failureCodeOf(refusal("resource_missing"))).toBe("resource_missing");
    expect(failureCodeOf(refusal("amount_too_small"))).toBe("amount_too_small");
  });

  test("otherwise the HTTP status, never the message", () => {
    expect(failureCodeOf(refusal(null))).toBe("stripe_400");
    expect(failureCodeOf(refusal("Not A Code!", 402))).toBe("stripe_402");
    expect(failureCodeOf(refusal("x".repeat(80), 403))).toBe("stripe_403");
    for (const c of ["resource_missing", null, "Weird"]) expect(failureCodeOf(refusal(c))).toMatch(/^[a-z0-9_]{1,64}$/);
  });

  test("an account refusal marks the account not ready; other refusals do not", () => {
    expect(isAccountRefusal(refusal("resource_missing"))).toBe(true);
    expect(isAccountRefusal(refusal("account_invalid"))).toBe(true);
    expect(isAccountRefusal(refusal("amount_too_small"))).toBe(false);
    expect(isAccountRefusal(refusal(null))).toBe(false);
  });
});

describe("the adapter", () => {
  test("manual by default: no transfer, nothing moves", () => {
    expect("transfer" in transferAdapterFromEnv({})).toBe(false);
    expect(transferAdapterFromEnv({ PAYMENTS_PROVIDER: "manual" }).provider).toBe("manual");
  });

  test("stripe with a test key can transfer; a live key never loads", () => {
    expect(
      typeof transferAdapterFromEnv({ PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_1" }).transfer,
    ).toBe("function");
    expect(() => transferAdapterFromEnv({ PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_live_1" })).toThrow(
      /live Stripe keys are refused/,
    );
  });
});

describe("the job", () => {
  test("retries with backoff, as many attempts as the last-attempt check counts", () => {
    expect(job.attempts).toBe(PAYOUT_TRANSFER_ATTEMPTS);
    expect(job.backoffMs).toBeGreaterThan(0);
  });
});
