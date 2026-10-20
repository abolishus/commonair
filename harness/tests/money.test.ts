// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The e4b-money scenario's pure parts: the split rules, expected figures and parsing. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MANUAL_REFERENCE_PATTERN } from "@commonair/contracts/currency";
import { describe, expect, test } from "vite-plus/test";
import { REPO_ROOT, ROLE_CLI, roleCliCommand } from "../src/money-db.ts";
import {
  type Cut,
  type LedgerSumRow,
  type ScenarioPlan,
  centsToInput,
  chatEventFromAttributes,
  chatEventFromFrame,
  disputePostingKey,
  disputeReachedLedger,
  expectedFigures,
  inconsistentLedgerRows,
  missingLedgerRows,
  monthlyShareCandidates,
  parseCents,
  parseReference,
  parseTier,
  parseVia,
  requireCents,
  reversalSplit,
  sameFraction,
  splitNet,
  splitPayment,
  sumNet,
  toMicros,
  unbalancedTransactions,
  utcMonth,
} from "../src/money.ts";

const CUT_90: Cut = { streamerShare: 0.9, coopShare: 0.1 };
const CUT_70: Cut = { streamerShare: 0.7, coopShare: 0.3 };

describe("splitNet / splitPayment (the ledger's rounding rule)", () => {
  test("the ledger README example: $10.99 incl. $0.99 tax at 90/10", () => {
    expect(splitPayment(1099, 99, CUT_90)).toEqual({ taxCents: 99, creatorCents: 900, coopCents: 100 });
  });

  test("odd cents floor in the co-op's favour and the parts sum to net", () => {
    expect(splitNet(999, CUT_90)).toEqual({ creatorCents: 899, coopCents: 100 });
    expect(splitNet(499, CUT_90)).toEqual({ creatorCents: 449, coopCents: 50 });
    expect(splitNet(1, CUT_90)).toEqual({ creatorCents: 0, coopCents: 1 });
    expect(splitNet(0, CUT_90)).toEqual({ creatorCents: 0, coopCents: 0 });
    expect(splitNet(999, CUT_70)).toEqual({ creatorCents: 699, coopCents: 300 });
    expect(splitNet(998, CUT_70)).toEqual({ creatorCents: 698, coopCents: 300 });
    for (let net = 0; net <= 2_000; net++) {
      const s = splitNet(net, CUT_70);
      expect(s.creatorCents + s.coopCents).toBe(net);
    }
  });

  test("zero tax leaves the whole gross to split", () => {
    expect(splitPayment(500, 0, CUT_90)).toEqual({ taxCents: 0, creatorCents: 450, coopCents: 50 });
  });

  test("exact where floats are not (100 × 0.29 is 28.999… in binary)", () => {
    expect(Math.floor(100 * 0.29)).toBe(28);
    expect(splitNet(100, { streamerShare: 0.29, coopShare: 0.71 }).creatorCents).toBe(29);
    expect(toMicros(0.7)).toBe(700_000n);
  });

  test("bad input is refused", () => {
    expect(() => splitNet(100, { streamerShare: 0.9, coopShare: 0.2 })).toThrow(/sum to 1/);
    expect(() => splitNet(-1, CUT_90)).toThrow(RangeError);
    expect(() => splitNet(1.5, CUT_90)).toThrow(RangeError);
    expect(() => splitPayment(100, 101, CUT_90)).toThrow(/tax/);
    expect(() => toMicros(1.1)).toThrow(RangeError);
  });
});

describe("reversalSplit", () => {
  const original = { grossCents: 1099, taxCents: 99 };

  test("a full reversal returns exactly the original split", () => {
    expect(reversalSplit(original, CUT_90, 0, 1099)).toEqual({ taxCents: 99, creatorCents: 900, coopCents: 100 });
  });

  test("slices of any size sum exactly to the original", () => {
    for (const slices of [[1, 333, 500, 265], [1098, 1], Array.from({ length: 1099 }, () => 1), [7, 7, 7, 1078]]) {
      let done = 0;
      const sum = { taxCents: 0, creatorCents: 0, coopCents: 0 };
      for (const s of slices) {
        const part = reversalSplit(original, CUT_70, done, s);
        expect(part.taxCents).toBeGreaterThanOrEqual(0);
        expect(part.creatorCents).toBeGreaterThanOrEqual(0);
        expect(part.coopCents).toBeGreaterThanOrEqual(0);
        expect(part.taxCents + part.creatorCents + part.coopCents).toBe(s);
        sum.taxCents += part.taxCents;
        sum.creatorCents += part.creatorCents;
        sum.coopCents += part.coopCents;
        done += s;
      }
      expect(sum).toEqual(splitPayment(1099, 99, CUT_70));
    }
  });

  test("cannot reverse more than the gross, or nothing", () => {
    expect(() => reversalSplit(original, CUT_90, 1000, 100)).toThrow(/more than/);
    expect(() => reversalSplit(original, CUT_90, 0, 0)).toThrow(/positive/);
  });
});

describe("expectedFigures", () => {
  const plan = (cut: Cut): ScenarioPlan => ({
    tierPrices: [499, 999, 2499],
    cut,
    subTier: 2,
    giftTier: 1,
    giftCount: 2,
    tipCents: 500,
  });

  test("90/10: the scenario's figures", () => {
    const e = expectedFigures(plan(CUT_90));
    expect(e.sub.split.creatorCents).toBe(899);
    expect(e.gift.grossCents).toBe(998);
    expect(e.gift.split.creatorCents).toBe(898);
    expect(e.tip.split.creatorCents).toBe(450);
    expect(e.afterPayments).toMatchObject({
      available: 0,
      held: 2247,
      owed: 0,
      earned: 2247,
      bySource: { subscriptions: 899, gifts: 898, tips: 450 },
      activeByTier: { 1: 2, 2: 1, 3: 0 },
    });
    expect(sumNet(e.afterPayments.ledger)).toBe(2247);
    expect(e.afterReversals).toMatchObject({
      held: 898,
      earned: 898,
      bySource: { subscriptions: 0, gifts: 898, tips: 0 },
      activeByTier: { 1: 2, 2: 0, 3: 0 },
    });
    expect(e.afterReversals.ledger.map((r) => r.type)).toEqual(["subscription", "gift", "tip", "refund", "chargeback"]);
    expect(sumNet(e.afterReversals.ledger)).toBe(898);
    expect(e.afterReversals.ledger.find((r) => r.type === "refund")).toEqual({
      type: "refund",
      tier: null,
      quantity: 1,
      gross: -500,
      deductions: 50,
      net: -450,
    });
    expect(e.transparencyRevenueDelta).toBe(998);
    expect(inconsistentLedgerRows(e.afterReversals.ledger)).toEqual([]);
  });

  test("70/30 changes every share, not the gross", () => {
    const e = expectedFigures(plan(CUT_70));
    expect([e.sub.split.creatorCents, e.gift.split.creatorCents, e.tip.split.creatorCents]).toEqual([699, 698, 350]);
    expect(e.afterPayments.held).toBe(1747);
    expect(e.afterReversals.held).toBe(698);
    expect(e.transparencyRevenueDelta).toBe(998);
  });

  test("a gift count below one is refused", () => {
    expect(() => expectedFigures({ ...plan(CUT_90), giftCount: 0 })).toThrow(RangeError);
  });

  test("monthly share: per subscription or over the tier, deduplicated", () => {
    expect(monthlyShareCandidates(499, 2, CUT_90)).toEqual([898]);
    expect(monthlyShareCandidates(495, 2, CUT_90)).toEqual([890, 891]);
    expect(monthlyShareCandidates(999, 0, CUT_90)).toEqual([0]);
  });
});

describe("ledger row checks", () => {
  const want = expectedFigures({
    tierPrices: [499, 999, 2499],
    cut: CUT_90,
    subTier: 2,
    giftTier: 1,
    giftCount: 2,
    tipCents: 500,
  }).afterPayments.ledger;

  test("rows match regardless of order; each observed row matches once", () => {
    expect(missingLedgerRows(want, [...want].reverse())).toEqual([]);
    expect(missingLedgerRows(want, want.slice(1))).toEqual([want[0]]);
    const twice = [want[0], want[0]].filter((r) => r !== undefined);
    expect(
      missingLedgerRows(
        twice,
        [want[0]].filter((r) => r !== undefined),
      ),
    ).toHaveLength(1);
  });

  test("a wrong net or quantity is missing; an unknown quantity is tolerated", () => {
    const gift = want[1];
    if (!gift) throw new Error("no gift row");
    expect(missingLedgerRows([gift], [{ ...gift, net: gift.net - 1 }])).toEqual([gift]);
    expect(missingLedgerRows([gift], [{ ...gift, quantity: 1 }])).toEqual([gift]);
    expect(missingLedgerRows([gift], [{ ...gift, quantity: null }])).toEqual([]);
  });

  test("gross + deductions must equal net; payouts are skipped", () => {
    expect(
      inconsistentLedgerRows([
        { type: "tip", tier: null, quantity: 1, gross: 500, deductions: -50, net: 450 },
        { type: "tip", tier: null, quantity: 1, gross: 500, deductions: -50, net: 451 },
        { type: "payout", tier: null, quantity: null, gross: null, deductions: null, net: -1000 },
      ]),
    ).toEqual([{ type: "tip", tier: null, quantity: 1, gross: 500, deductions: -50, net: 451 }]);
  });

  test("unbalanced transactions (sums arrive as bigint strings)", () => {
    const row = (sum: string | number | bigint) => ({
      transactionId: "t",
      refId: "r",
      kind: "payment",
      idempotencyKey: "payment:r",
      currency: "usd",
      sum,
    });
    expect(unbalancedTransactions([row("0"), row(0), row(0n)])).toEqual([]);
    expect(unbalancedTransactions([row("0"), row("-1"), row("9007199254740993")])).toEqual([
      row("-1"),
      row("9007199254740993"),
    ]);
  });
});

describe("dispute ledger matching", () => {
  const pay = "0190a000-0000-7000-8000-000000000001";
  const disp = "0190a000-0000-7000-8000-0000000000d1";
  const row = (over: Partial<LedgerSumRow>): LedgerSumRow => ({
    transactionId: "t",
    refId: pay,
    kind: "payment",
    idempotencyKey: `payment:${pay}`,
    currency: "usd",
    sum: "0",
    ...over,
  });
  const dispute = { id: disp, paymentId: pay, kind: "refund" };

  test("posting key is kind:disputeId", () => {
    expect(disputePostingKey(dispute)).toBe(`refund:${disp}`);
    expect(disputePostingKey({ id: disp, kind: "chargeback" })).toBe(`chargeback:${disp}`);
  });

  test("matches the reversal posted against the payment", () => {
    const rows = [row({}), row({ kind: "refund", idempotencyKey: `refund:${disp}` })];
    expect(disputeReachedLedger(rows, dispute)).toBe(true);
  });

  test("a row whose refId is the dispute id does not count (reversals reference the payment)", () => {
    expect(disputeReachedLedger([row({ refId: disp, kind: "refund", idempotencyKey: "x" })], dispute)).toBe(false);
  });

  test("the payment's own posting, another kind, or another dispute do not count", () => {
    expect(disputeReachedLedger([row({})], dispute)).toBe(false);
    expect(disputeReachedLedger([row({ kind: "chargeback", idempotencyKey: `chargeback:${disp}` })], dispute)).toBe(
      false,
    );
    expect(
      disputeReachedLedger(
        [row({ kind: "refund", idempotencyKey: "refund:0190a000-0000-7000-8000-0000000000d2" })],
        dispute,
      ),
    ).toBe(false);
    expect(
      disputeReachedLedger(
        [row({ refId: "0190a000-0000-7000-8000-000000000002", idempotencyKey: `refund:${disp}` })],
        dispute,
      ),
    ).toBe(false);
    expect(disputeReachedLedger([], dispute)).toBe(false);
  });

  test("chargeback-reversal of the same dispute is not the chargeback itself", () => {
    const cb = { ...dispute, kind: "chargeback" };
    expect(disputeReachedLedger([row({ idempotencyKey: `chargeback-reversal:${disp}` })], cb)).toBe(false);
  });
});

describe("parsing", () => {
  test("parseCents: signed integers only, empty is null", () => {
    expect(parseCents("500")).toBe(500);
    expect(parseCents(" -450 ")).toBe(-450);
    expect(parseCents("-0")).toBe(0);
    expect(Object.is(parseCents("-0"), -0)).toBe(false);
    expect(parseCents("")).toBeNull();
    expect(parseCents(null)).toBeNull();
    expect(parseCents(undefined)).toBeNull();
    for (const bad of ["5.00", "1e3", "abc", "0x10", "99999999999999999999"])
      expect(() => parseCents(bad)).toThrow(/cents/);
    expect(requireCents("7", "x")).toBe(7);
    expect(() => requireCents("", "revenue-held")).toThrow(/revenue-held/);
  });

  test("parseTier: 1–3 or Twitch's 1000–3000", () => {
    expect(parseTier("2")).toBe(2);
    expect(parseTier("2000")).toBe(2);
    expect(parseTier(3000)).toBe(3);
    expect(parseTier(1)).toBe(1);
    for (const bad of ["", null, undefined, "4", "1500", "x", 0]) expect(parseTier(bad)).toBeNull();
  });

  test("centsToInput follows the currency's minor units", () => {
    expect(centsToInput(500, "usd")).toBe("5.00");
    expect(centsToInput(5, "usd")).toBe("0.05");
    expect(centsToInput(0, "eur")).toBe("0.00");
    expect(centsToInput(123_456, "usd")).toBe("1234.56");
    expect(centsToInput(500, "jpy")).toBe("500");
    expect(centsToInput(1_234, "kwd")).toBe("1.234");
    expect(() => centsToInput(-1, "usd")).toThrow(RangeError);
  });

  test("parseReference: canonical, forgiving and extracted from text", () => {
    expect(parseReference("CA-7K2M9QXZ")).toBe("CA-7K2M9QXZ");
    expect(parseReference(" ca-7k2m9qxz ")).toBe("CA-7K2M9QXZ");
    expect(parseReference("CA 7K2M 9QXZ")).toBe("CA-7K2M9QXZ");
    expect(parseReference("ca-oo1ll1il")).toBe("CA-00111111");
    expect(parseReference("Quote reference CA-7K2M9QXZ on your transfer.")).toBe("CA-7K2M9QXZ");
    expect(parseReference("CA-123")).toBeNull();
    expect(parseReference("CA-UUUUUUUU")).toBeNull();
    expect(parseReference("no reference here")).toBeNull();
    for (const r of ["CA-7K2M9QXZ", "CA-00111111"]) expect(MANUAL_REFERENCE_PATTERN.test(r)).toBe(true);
  });

  test("parseVia", () => {
    expect(parseVia("web")).toBe("web");
    expect(parseVia(" API ")).toBe("api");
    expect(() => parseVia("both")).toThrow(/expected one of web, api/);
  });

  test("sameFraction compares as millionths", () => {
    expect(sameFraction("0.9", 0.9)).toBe(true);
    expect(sameFraction("0.90", 0.9)).toBe(true);
    expect(sameFraction(0.1, 0.1)).toBe(true);
    expect(sameFraction("0.1", 0.9)).toBe(false);
    expect(sameFraction(null, 0.9)).toBe(false);
    expect(sameFraction("", 0.9)).toBe(false);
    expect(sameFraction("90", 0.9)).toBe(false);
  });

  test("utcMonth", () => {
    expect(utcMonth(new Date("2026-10-31T23:59:59Z"))).toBe("2026-10");
    expect(utcMonth(new Date("2026-11-01T00:00:00+01:00"))).toBe("2026-10");
  });
});

describe("chat events", () => {
  test("frames: subscribe, gift and anonymous tip payloads", () => {
    expect(chatEventFromFrame("channel.subscribe", { user_login: "a_1", tier: "2000", is_gift: false })).toEqual({
      type: "channel.subscribe",
      user: "a_1",
      tier: 2,
      cents: null,
      total: null,
    });
    expect(
      chatEventFromFrame("channel.subscription.gift", {
        user_login: "a_1",
        tier: "1000",
        total: 2,
        is_anonymous: false,
      }),
    ).toEqual({ type: "channel.subscription.gift", user: "a_1", tier: 1, cents: null, total: 2 });
    expect(
      chatEventFromFrame("channel.tip", {
        user_login: null,
        is_anonymous: true,
        amount: { value: 500, decimal_places: 2, currency: "usd" },
      }),
    ).toEqual({ type: "channel.tip", user: "", tier: null, cents: 500, total: null });
    // Anonymous hides the login even if a payload carried one.
    expect(chatEventFromFrame("channel.tip", { user_login: "a_1", is_anonymous: true }).user).toBe("");
  });

  test("rows: data-* attributes", () => {
    expect(chatEventFromAttributes({ type: "channel.tip", user: "", tier: "", cents: "500", total: null })).toEqual({
      type: "channel.tip",
      user: "",
      tier: null,
      cents: 500,
      total: null,
    });
    expect(
      chatEventFromAttributes({ type: "channel.subscription.gift", user: "a_1", tier: "1", cents: null, total: "2" }),
    ).toEqual({ type: "channel.subscription.gift", user: "a_1", tier: 1, cents: null, total: 2 });
  });
});

describe("operator role CLI", () => {
  test("command line and script path", () => {
    expect(roleCliCommand("tr_x", "treasurer", "bun")).toEqual(["bun", ROLE_CLI, "tr_x", "treasurer"]);
    expect(existsSync(join(REPO_ROOT, ROLE_CLI))).toBe(true);
  });
});
