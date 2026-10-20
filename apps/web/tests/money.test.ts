// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MONEY_LIMITS } from "@commonair/contracts/currency";
import { PAYMENT_KINDS, PAYMENT_STATUSES, PAYOUT_STATUSES, REVENUE_LINE_TYPES } from "@commonair/contracts/enums";
import { isNotFound } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";
import { en } from "../src/i18n/en.ts";
import {
  COST_CATEGORY,
  DEFAULT_TIER_PRICES,
  STATEMENT_COLUMNS,
  TIER_BENEFITS_MAX,
  TIER_NAME_MAX,
  canDispute,
  csvInteger,
  csvText,
  currentMonthPeriod,
  disputeAmountError,
  earnedDelta,
  egressShare,
  holdReasonLabel,
  monthKey,
  monthLabel,
  monthOptions,
  monthRange,
  normalizeReference,
  parseTransparencyPeriod,
  paymentDescription,
  paymentStatusBadge,
  payoutProgress,
  payoutStatusBadge,
  refundableCents,
  requireTreasurer,
  revenueLineBadge,
  statementCsv,
  statementFilename,
  tierDrafts,
  tiersInput,
  tiersValid,
  transparencyFlow,
  transparencyPeriodOptions,
  transparencyTotals,
  validateTiers,
  type RevenueLineDto,
  type TierDraft,
  type TransparencyMonthDto,
} from "../src/lib/money.ts";

const usd = (cents: number) => ({ cents, currency: "usd" });
const OCT_20 = Date.UTC(2026, 9, 20, 15, 30);

describe("treasury guard", () => {
  const me = { id: "u", username: "a", displayName: "A", channelSlug: null };
  const rejection = async (load: () => Promise<object | null>) =>
    requireTreasurer(load).then(
      () => null,
      (e: unknown) => e,
    );

  it.each([
    ["signed out", null],
    ["a session without a role", me],
    ["a user", { ...me, role: "user" }],
    ["an admin", { ...me, role: "admin" }],
    ["a moderator", { ...me, role: "moderator" }],
  ])("answers %s with not found", async (_, session) => {
    expect(isNotFound(await rejection(async () => session))).toBe(true);
  });

  it("lets a treasurer through", async () => {
    const treasurer = { ...me, role: "treasurer" };
    await expect(requireTreasurer(async () => treasurer)).resolves.toEqual({ me: treasurer });
  });
});

describe("months (UTC)", () => {
  it("keys the UTC month, not the local one", () => {
    expect(monthKey(OCT_20)).toBe("2026-10");
    expect(monthKey(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe("2026-12");
    expect(monthKey(Date.UTC(2027, 0, 1))).toBe("2027-01");
  });

  it("turns a month into the API's [from, to) period, across the year end", () => {
    expect(monthRange("2026-10")).toEqual({ from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" });
    expect(monthRange("2026-12")).toEqual({ from: "2026-12-01T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z" });
    expect(monthRange("2024-02")?.to).toBe("2024-03-01T00:00:00.000Z");
  });

  it.each(["", "2026-13", "2026-00", "2026-1", "26-10", "2026-10-01", "x2026-10"])("rejects %j", (key) => {
    expect(monthRange(key)).toBeNull();
  });

  it("labels months from the catalog and passes junk through", () => {
    expect(monthLabel("2026-10")).toBe("October 2026");
    expect(monthLabel("2027-01")).toBe("January 2027");
    expect(monthLabel("nope")).toBe("nope");
  });

  it("offers the current month and the eleven before it, newest first", () => {
    const options = monthOptions(OCT_20);
    expect(options).toHaveLength(12);
    expect(options[0]).toEqual({ value: "2026-10", label: "October 2026" });
    expect(options.map((o) => o.value).slice(9)).toEqual(["2026-01", "2025-12", "2025-11"]);
    expect(new Set(options.map((o) => o.value)).size).toBe(12);
    expect(monthOptions(OCT_20, 0)).toEqual([]);
    expect(monthOptions(Date.UTC(2026, 0, 31), 2).map((o) => o.value)).toEqual(["2026-01", "2025-12"]);
  });

  it("the current month period for costs", () => {
    expect(currentMonthPeriod(OCT_20)).toEqual({
      periodStart: "2026-10-01T00:00:00.000Z",
      periodEnd: "2026-11-01T00:00:00.000Z",
    });
  });
});

describe("revenue figures", () => {
  it("earned delta: up, down, flat, formatted absolute", () => {
    expect(earnedDelta(usd(1500), usd(1000), "en")).toEqual({
      direction: "up",
      sentiment: "positive",
      cents: 500,
      label: "$5.00 more than the month before",
    });
    expect(earnedDelta(usd(-200), usd(100), "en")).toMatchObject({
      direction: "down",
      sentiment: "negative",
      cents: -300,
      label: "$3.00 less than the month before",
    });
    const flat = earnedDelta(usd(0), usd(0), "en");
    expect(flat).toEqual({ direction: "flat", cents: 0, label: en["revenue.earned.flat"] });
  });

  it.each([
    [0, 5000, 0],
    [-100, 5000, 0],
    [2500, 5000, 50],
    [4999, 5000, 99],
    [5000, 5000, 100],
    [9000, 5000, 100],
    [1, 3, 33],
    [123, 0, 100],
  ])("payout progress %i of %i = %i%%", (available, minimum, expected) => {
    expect(payoutProgress(available, minimum)).toBe(expected);
  });
});

describe("CSV statement", () => {
  it.each([
    ["=SUM(A1)", "'=SUM(A1)"],
    ["+1", "'+1"],
    ["-1", "'-1"],
    ["@cmd", "'@cmd"],
    ["\tx", "'\tx"],
    ["plain", "plain"],
    ["a,b", '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ["line\nbreak", '"line\nbreak"'],
    ['=HYPERLINK("x","y")', `"'=HYPERLINK(""x"",""y"")"`],
    ["", ""],
  ])("text cell %j → %j", (input, expected) => {
    expect(csvText(input)).toBe(expected);
  });

  it("integer cells: signed integers as is, null empty, fractions refused", () => {
    expect(csvInteger(-1234)).toBe("-1234");
    expect(csvInteger(0)).toBe("0");
    expect(csvInteger(null)).toBe("");
    expect(() => csvInteger(1.5)).toThrow(RangeError);
    expect(() => csvInteger(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
  });

  const line = (over: Partial<RevenueLineDto>): RevenueLineDto => ({
    id: "019a0000-0000-7000-8000-000000000001",
    occurredAt: "2026-10-05T12:00:00+02:00",
    type: "subscription",
    tier: 2,
    quantity: 1,
    from: { id: "u1", username: "fan_one", displayName: "Fan, =One" },
    reference: "CA-ABCD1234",
    gross: usd(1000),
    deductions: usd(-150),
    net: usd(850),
    ...over,
  });

  it("header row, ISO UTC timestamps, integer cents, formatted net, CRLF", () => {
    const csv = statementCsv(
      [
        line({}),
        line({
          id: "t2",
          type: "tip",
          tier: null,
          from: null,
          gross: usd(500),
          deductions: usd(-75),
          net: usd(425),
        }),
        line({ id: "t3", type: "refund", gross: usd(-1000), deductions: usd(150), net: usd(-850) }),
        line({
          id: "t4",
          type: "payout",
          tier: null,
          from: null,
          reference: "-wire 1",
          gross: null,
          deductions: null,
          net: usd(-5000),
        }),
      ],
      "en",
    );
    const rows = csv.split("\r\n");
    expect(rows.at(-1)).toBe("");
    expect(rows[0]).toBe(STATEMENT_COLUMNS.join(","));
    expect(rows[1]).toBe("2026-10-05T10:00:00.000Z,subscription,2,1,fan_one,CA-ABCD1234,USD,1000,-150,850,$8.50");
    expect(rows[2]).toBe("2026-10-05T10:00:00.000Z,tip,,1,,CA-ABCD1234,USD,500,-75,425,$4.25");
    expect(rows[3]).toBe("2026-10-05T10:00:00.000Z,refund,2,1,fan_one,CA-ABCD1234,USD,-1000,150,-850,'-$8.50");
    expect(rows[4]).toBe("2026-10-05T10:00:00.000Z,payout,,1,,'-wire 1,USD,,,-5000,'-$50.00");
    // Display names never reach the statement; anonymous tips have no name at all.
    expect(csv).not.toContain("Fan");
  });

  it("an empty month is just the header", () => {
    expect(statementCsv([], "en")).toBe(`${STATEMENT_COLUMNS.join(",")}\r\n`);
  });

  it("file name keeps only safe characters", () => {
    expect(statementFilename("river_tide", "2026-10")).toBe("revenue-river_tide-2026-10.csv");
    expect(statementFilename("../x", "../../etc")).toBe("revenue-x-period.csv");
  });
});

describe("tier editor", () => {
  const drafts = (...prices: number[]): TierDraft[] =>
    prices.map((priceCents, i) => ({ tier: (i + 1) as 1 | 2 | 3, name: `T${i + 1}`, priceCents, benefits: "" }));

  it("defaults: three unnamed tiers at increasing prices within the limits", () => {
    const d = tierDrafts([]);
    expect(d.map((x) => [x.tier, x.name, x.priceCents])).toEqual([
      [1, "", DEFAULT_TIER_PRICES[1]],
      [2, "", DEFAULT_TIER_PRICES[2]],
      [3, "", DEFAULT_TIER_PRICES[3]],
    ]);
    expect(validateTiers(d.map((x) => ({ ...x, name: "n" })))).toEqual({});
  });

  it("fills drafts from stored tiers in tier order", () => {
    const d = tierDrafts([
      { tier: 3, name: "Gold", price: usd(3000), benefits: "all" },
      { tier: 1, name: "Bronze", price: usd(300), benefits: "" },
    ]);
    expect(d.map((x) => [x.tier, x.name, x.priceCents])).toEqual([
      [1, "Bronze", 300],
      [2, "", DEFAULT_TIER_PRICES[2]],
      [3, "Gold", 3000],
    ]);
  });

  it("accepts increasing prices at the limits", () => {
    expect(tiersValid(drafts(MONEY_LIMITS.tierMinCents, 5000, MONEY_LIMITS.tierMaxCents))).toBe(true);
  });

  it("names are required and capped", () => {
    const d = drafts(500, 1000, 2500);
    d[0] = { ...d[0]!, name: "   " };
    d[1] = { ...d[1]!, name: "x".repeat(TIER_NAME_MAX + 1) };
    const errors = validateTiers(d);
    expect(errors[1]?.name).toBe(en["revenue.tiers.error.nameRequired"]);
    expect(errors[2]?.name).toContain(String(TIER_NAME_MAX));
    expect(errors[3]).toBeUndefined();
  });

  it("benefits are capped", () => {
    const d = drafts(500, 1000, 2500);
    d[2] = { ...d[2]!, benefits: "b".repeat(TIER_BENEFITS_MAX + 1) };
    expect(validateTiers(d)[3]?.benefits).toContain(String(TIER_BENEFITS_MAX));
  });

  it.each([
    [[MONEY_LIMITS.tierMinCents - 1, 1000, 2500], 1, en["revenue.tiers.error.priceRange"]],
    [[500, 1000, MONEY_LIMITS.tierMaxCents + 1], 3, en["revenue.tiers.error.priceRange"]],
    [[500, 1000.5, 2500], 2, en["revenue.tiers.error.priceRange"]],
    [[500, 500, 2500], 2, en["revenue.tiers.error.priceOrder"]],
    [[500, 1000, 900], 3, en["revenue.tiers.error.priceOrder"]],
  ])("prices %j: tier %i says %j", (prices, tier, message) => {
    const errors = validateTiers(drafts(...prices));
    expect(errors[tier as 1 | 2 | 3]?.price).toBe(message);
    expect(tiersValid(drafts(...prices))).toBe(false);
  });

  it("a missing tier is an error", () => {
    expect(validateTiers(drafts(500, 1000))[3]?.name).toBe(en["revenue.tiers.error.missing"]);
  });

  it("builds the setTiers input trimmed, in the given currency", () => {
    const d = drafts(500, 1000, 2500).map((x) => ({ ...x, name: ` ${x.name} `, benefits: " perks " }));
    expect(tiersInput(d, "eur")).toEqual([
      { tier: 1, name: "T1", price: { cents: 500, currency: "eur" }, benefits: "perks" },
      { tier: 2, name: "T2", price: { cents: 1000, currency: "eur" }, benefits: "perks" },
      { tier: 3, name: "T3", price: { cents: 2500, currency: "eur" }, benefits: "perks" },
    ]);
  });
});

describe("treasury", () => {
  const payment = (status: (typeof PAYMENT_STATUSES)[number], amount: number, refunded: number) => ({
    status,
    amount: usd(amount),
    refunded: usd(refunded),
  });

  it("refundable rest and who can be disputed", () => {
    expect(refundableCents(payment("succeeded", 1000, 0))).toBe(1000);
    expect(refundableCents(payment("partially_refunded", 1000, 300))).toBe(700);
    expect(refundableCents(payment("refunded", 1000, 1200))).toBe(0);
    expect(canDispute(payment("succeeded", 1000, 0))).toBe(true);
    expect(canDispute(payment("partially_refunded", 1000, 300))).toBe(true);
    expect(canDispute(payment("partially_refunded", 1000, 1000))).toBe(false);
    for (const status of ["pending", "failed", "refunded", "charged_back"] as const)
      expect(canDispute(payment(status, 1000, 0))).toBe(false);
  });

  it.each([
    [1, 700, null],
    [700, 700, null],
    [0, 700, en["treasury.dispute.amountRange"]],
    [701, 700, en["treasury.dispute.amountRange"]],
    [1.5, 700, en["treasury.dispute.amountRange"]],
    [-5, 700, en["treasury.dispute.amountRange"]],
  ])("dispute amount %d of %d → %j", (amount, refundable, expected) => {
    expect(disputeAmountError(amount, refundable)).toBe(expected);
  });

  it("normalizes a typed reference", () => {
    expect(normalizeReference(" ca-abcd 1234 ")).toBe("CA-ABCD1234");
    expect(normalizeReference("")).toBe("");
    expect(normalizeReference("x".repeat(100))).toHaveLength(64);
  });

  it.each([
    ["hosting", true],
    ["bandwidth_eu-1", true],
    ["9", true],
    ["", false],
    ["Hosting", false],
    ["-x", false],
    ["has space", false],
    ["x".repeat(41), false],
  ])("cost category %j valid: %s", (value, valid) => {
    expect(COST_CATEGORY.test(value)).toBe(valid);
  });

  it("describes payments", () => {
    expect(paymentDescription({ kind: "subscription", tier: 2, quantity: 1 })).toBe("Subscription, tier 2");
    expect(paymentDescription({ kind: "subscription", tier: 1, quantity: 5 })).toBe("5 gift subs, tier 1");
    expect(paymentDescription({ kind: "subscription", tier: null, quantity: 1 })).toBe(
      en["treasury.kind.subscription"],
    );
    expect(paymentDescription({ kind: "tip", tier: null, quantity: 1 })).toBe(en["treasury.kind.tip"]);
    for (const kind of PAYMENT_KINDS) expect(paymentDescription({ kind, tier: null, quantity: 1 })).not.toBe("");
  });

  it("every status and type has a labelled badge", () => {
    for (const s of PAYMENT_STATUSES) expect(paymentStatusBadge(s).label).not.toBe("");
    for (const s of PAYOUT_STATUSES) expect(payoutStatusBadge(s).label).not.toBe("");
    for (const s of REVENUE_LINE_TYPES) expect(revenueLineBadge(s).label).not.toBe("");
    expect(revenueLineBadge("chargeback").tone).toBe("danger");
    expect(holdReasonLabel("payout_account_not_ready")).toBe(en["treasury.holdReason.accountNotReady"]);
    expect(holdReasonLabel("other_code")).toBe("Held: other_code");
  });
});

describe("transparency", () => {
  const egress = (bytes: Partial<TransparencyMonthDto["egressBySource"]>): TransparencyMonthDto["egressBySource"] => ({
    origin: 0,
    relay: 0,
    p2p: 0,
    cdn: 0,
    ...bytes,
  });
  const month = (key: string, over: Partial<TransparencyMonthDto> = {}): TransparencyMonthDto => ({
    month: key,
    revenue: usd(10_000),
    streamerPayouts: usd(6000),
    coopRetained: usd(1500),
    costs: [{ category: "hosting", amount: usd(400) }],
    surplus: usd(1100),
    patronageDistributed: usd(0),
    egressBySource: egress({ origin: 600, relay: 400 }),
    governance: [],
    members: { streamer: 0, viewer: 0, worker: 0 },
    ...over,
  });

  it("period options and parsing", () => {
    expect(transparencyPeriodOptions().map((o) => o.value)).toEqual(["3", "6", "12"]);
    expect(parseTransparencyPeriod("6")).toBe(6);
    expect(parseTransparencyPeriod("7")).toBeNull();
    expect(parseTransparencyPeriod("")).toBeNull();
  });

  it("sums the months shown", () => {
    const months = [
      month("2026-10"),
      month("2026-09", {
        revenue: usd(5000),
        streamerPayouts: usd(0),
        costs: [
          { category: "hosting", amount: usd(400) },
          { category: "bandwidth", amount: usd(250) },
        ],
        surplus: usd(-100),
      }),
    ];
    expect(transparencyTotals(months, "eur")).toEqual({
      currency: "usd",
      revenue: 15_000,
      payouts: 6000,
      costs: 1050,
      surplus: 1000,
    });
    expect(transparencyTotals([], "eur")).toEqual({ currency: "eur", revenue: 0, payouts: 0, costs: 0, surplus: 0 });
  });

  it("splits revenue into creators, each cost category and what the co-op kept", () => {
    const flow = transparencyFlow([
      month("2026-10"),
      month("2026-09", { costs: [{ category: "bandwidth", amount: usd(250) }], surplus: usd(-50) }),
    ]);
    expect(flow.map((s) => [s.id, s.value])).toEqual([
      ["creators", 17_000],
      ["cost-hosting", 400],
      ["cost-bandwidth", 250],
      ["retained", 1050],
    ]);
    expect(flow.every((s) => Number.isInteger(s.value) && s.value >= 0)).toBe(true);
    expect(transparencyFlow([]).map((s) => s.value)).toEqual([0, 0]);
  });

  it("relay share of egress, whole percent", () => {
    expect(egressShare([month("a"), month("b", { egressBySource: egress({ relay: 1000 }) })])).toEqual({
      relayBytes: 1400,
      totalBytes: 2000,
      relayPercent: 70,
    });
    expect(egressShare([month("a", { egressBySource: egress({}) })]).relayPercent).toBe(0);
  });
});
