// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PAYMENT_FRAUD_RULES } from "@commonair/contracts/enums";
import { describe, expect, test } from "vite-plus/test";
import {
  FRAUD_PAYERS,
  TREASURY_TAB_FRAUD,
  flagFor,
  fraudTipPlan,
  isSecondApproverRefusal,
  sqlState,
} from "../../src/w1/fraud.ts";
import { W1_TEST_IDS } from "../../src/w1/selectors.ts";

const NOW = new Date("2026-10-30T12:00:00.000Z");
const DAY = 86_400_000;

describe("fraudTipPlan", () => {
  test("the tips reach the concentration floor and sit one day past the hold", () => {
    const plan = fraudTipPlan(NOW, 7);
    expect(plan.cents).toHaveLength(FRAUD_PAYERS);
    const total = plan.cents.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(PAYMENT_FRAUD_RULES.concentrationMinGrossCents);
    expect(total - PAYMENT_FRAUD_RULES.concentrationMinGrossCents).toBeLessThan(FRAUD_PAYERS);
    expect(plan.at).toEqual(new Date(NOW.getTime() - 8 * DAY));
    for (const c of plan.cents) expect(Number.isInteger(c)).toBe(true);
  });

  test("a fractional hold rounds up; a hold filling the window is refused", () => {
    expect(fraudTipPlan(NOW, 2.5).at).toEqual(new Date(NOW.getTime() - 4 * DAY));
    expect(fraudTipPlan(NOW, 0).at).toEqual(new Date(NOW.getTime() - DAY));
    expect(() => fraudTipPlan(NOW, PAYMENT_FRAUD_RULES.concentrationWindowDays)).toThrow(RangeError);
    expect(() => fraudTipPlan(NOW, 7, 0)).toThrow(RangeError);
  });

  test("the payers bring everything, so the top-three share is 100 %", () => {
    expect(FRAUD_PAYERS).toBeLessThanOrEqual(PAYMENT_FRAUD_RULES.concentrationTopN);
  });
});

describe("helpers", () => {
  test("sqlState looks through wrapped driver errors", () => {
    expect(sqlState({ message: "x", cause: { code: "23514" } })).toBe("23514");
    expect(sqlState({ code: "42501" })).toBe("42501");
    expect(sqlState(new Error("plain"))).toBeNull();
    expect(sqlState(null)).toBeNull();
  });

  test("isSecondApproverRefusal matches only FORBIDDEN second_approver", () => {
    expect(isSecondApproverRefusal({ code: "FORBIDDEN", status: 403, data: { reason: "second_approver" } })).toBe(true);
    expect(isSecondApproverRefusal({ code: "FORBIDDEN", status: 403 })).toBe(false);
    expect(isSecondApproverRefusal({ code: "CONFLICT", data: { reason: "second_approver" } })).toBe(false);
    expect(isSecondApproverRefusal(null)).toBe(false);
  });

  test("flagFor picks the payee's flag of the kind", () => {
    const f = (id: string, username: string, kind: string) => ({
      id,
      kind,
      status: "open",
      payee: { username },
      heldPayouts: 0,
    });
    const items = [f("1", "a", "manual"), f("2", "b", "payer_concentration"), f("3", "a", "payer_concentration")];
    expect(flagFor(items, "a", "payer_concentration")?.id).toBe("3");
    expect(flagFor(items, "c", "payer_concentration")).toBeNull();
  });

  test("the step uses the documented fraud ids", () => {
    expect(W1_TEST_IDS.fraudFlag).toBe("fraud-flag");
    expect(W1_TEST_IDS.fraudFlagReview).toBe("fraud-flag-review");
    expect(W1_TEST_IDS.fraudFlagDecide).toBe("fraud-flag-decide");
    expect(W1_TEST_IDS.fraudDecisionClear).toBe("fraud-decision-clear");
    expect(TREASURY_TAB_FRAUD).toBe("treasury-tab-fraud");
  });
});
