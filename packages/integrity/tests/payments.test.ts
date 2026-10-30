// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  DEFAULT_PAYMENT_FRAUD_RULES as RULES,
  type FraudPayment,
  type PaymentFraudRules,
  fraudScan,
  newPayee,
  payeeGross,
  payerConcentration,
  payerVelocity,
  reachesShare,
  scanSignals,
  shareBps,
} from "../src/payments/index.ts";

const T0 = new Date("2026-10-01T12:00:00.000Z").getTime();
const MIN = 60_000;
const DAY = 86_400_000;
const OLD = new Date(T0 - 365 * DAY);

let n = 0;
function pay(
  payer: string | null,
  payee: string,
  cents: number,
  atMs: number,
  payerCreatedAt: Date | null = payer === null ? null : OLD,
): FraudPayment {
  n += 1;
  return {
    paymentId: `p${String(n).padStart(6, "0")}`,
    payerUserId: payer,
    payeeUserId: payee,
    amountCents: cents,
    succeededAt: new Date(atMs),
    payerCreatedAt,
  };
}

/** `count` payments from `payer` to `payee`, `stepMs` apart from `startMs`. */
const burst = (payer: string, payee: string, count: number, startMs: number, stepMs = MIN) =>
  Array.from({ length: count }, (_, i) => pay(payer, payee, 100, startMs + i * stepMs));

describe("basis points", () => {
  test("shareBps floors and handles an empty whole", () => {
    expect(shareBps(1, 3)).toBe(3333);
    expect(shareBps(2, 3)).toBe(6666);
    expect(shareBps(8, 10)).toBe(8000);
    expect(shareBps(0, 10)).toBe(0);
    expect(shareBps(5, 0)).toBe(0);
    expect(shareBps(10, 10)).toBe(10_000);
  });
  test("reachesShare is exact at the boundary and above 2^53", () => {
    expect(reachesShare(80, 100, 0.8)).toBe(true);
    expect(reachesShare(79, 100, 0.8)).toBe(false);
    // 7999.99… bps floors to 7999 but must not reach 80 %.
    expect(reachesShare(799_999, 1_000_000, 0.8)).toBe(false);
    expect(reachesShare(800_000, 1_000_000, 0.8)).toBe(true);
    const big = 9_000_000_000_000;
    expect(reachesShare(big * 0.8, big, 0.8)).toBe(true);
    expect(reachesShare(big * 0.8 - 1, big, 0.8)).toBe(false);
    expect(reachesShare(0, 0, 0.5)).toBe(false);
  });
});

describe("payerVelocity", () => {
  test("exactly the maximum in the window does not flag; one more does", () => {
    const max = RULES.velocityMaxPayments;
    expect(payerVelocity(burst("a", "x", max, T0), RULES)).toEqual([]);
    const hits = payerVelocity(burst("a", "x", max + 1, T0), RULES);
    expect(hits).toEqual([
      {
        payeeUserId: "x",
        windowStart: new Date(T0),
        evidence: { payerUserId: "a", payments: max + 1, windowStart: new Date(T0).toISOString() },
      },
    ]);
  });

  test("the window is half-open: a payment exactly one window later starts a new window", () => {
    const window = RULES.velocityWindowMinutes * MIN;
    const max = RULES.velocityMaxPayments;
    // max payments spread inside [T0, T0 + window), the next exactly at T0 + window.
    const step = Math.floor(window / max);
    const inside = burst("a", "x", max, T0, step);
    expect(payerVelocity([...inside, pay("a", "x", 100, T0 + window)], RULES)).toEqual([]);
    // One millisecond earlier and it is inside the first window.
    expect(payerVelocity([...inside, pay("a", "x", 100, T0 + window - 1)], RULES)).toHaveLength(1);
  });

  test("sliding windows find a burst that straddles fixed hour boundaries", () => {
    const max = RULES.velocityMaxPayments;
    const start = T0 + 50 * MIN;
    // Slow payments before, then max + 1 within 20 minutes across the hour.
    const slow = burst("a", "x", 5, T0 - 6 * 60 * MIN, 60 * MIN);
    const fast = burst("a", "y", max + 1, start, 2 * MIN);
    const hits = payerVelocity([...slow, ...fast], RULES);
    expect(hits.map((h) => h.payeeUserId)).toEqual(["y"]);
    expect(hits[0]?.windowStart).toEqual(new Date(start));
  });

  test("every payee of the flagged window is flagged, payees outside it are not", () => {
    const max = RULES.velocityMaxPayments;
    const ps = [
      ...burst("a", "x", max - 1, T0),
      pay("a", "y", 100, T0 + 30 * MIN),
      pay("a", "z", 100, T0 + 31 * MIN),
      pay("a", "w", 100, T0 + 5 * 60 * MIN),
    ];
    expect(payerVelocity(ps, RULES).map((h) => h.payeeUserId)).toEqual(["x", "y", "z"]);
  });

  test("payments from different payers do not add up; payerless payments are ignored", () => {
    const max = RULES.velocityMaxPayments;
    const ps = [...burst("a", "x", max, T0), ...burst("b", "x", max, T0)];
    for (let i = 0; i < max + 5; i++) ps.push(pay(null, "x", 100, T0 + i));
    expect(payerVelocity(ps, RULES)).toEqual([]);
  });

  test("anonymous payments still count by payer id (the reader keeps the payer)", () => {
    // Anonymity is a display choice: the reader hands the payer's id in either way.
    const ps = burst("anon-payer", "x", RULES.velocityMaxPayments + 1, T0);
    expect(payerVelocity(ps, RULES)).toHaveLength(1);
  });

  test("a payee hit by two payers keeps the earliest window", () => {
    const max = RULES.velocityMaxPayments;
    const ps = [...burst("b", "x", max + 1, T0 + 10 * MIN, 1000), ...burst("a", "x", max + 1, T0 + 2 * DAY, 1000)];
    const [hit] = payerVelocity(ps, RULES);
    expect(hit?.evidence.payerUserId).toBe("b");
    expect(hit?.windowStart).toEqual(new Date(T0 + 10 * MIN));
  });

  test("input order does not matter", () => {
    const ps = burst("a", "x", RULES.velocityMaxPayments + 1, T0);
    expect(payerVelocity([...ps].reverse(), RULES)).toEqual(payerVelocity(ps, RULES));
  });
});

describe("payerConcentration", () => {
  const floor = RULES.concentrationMinGrossCents;

  /** Gross split across payers given in cents, all old accounts. */
  const spread = (payee: string, centsByPayer: number[]) =>
    centsByPayer.map((c, i) => pay(`payer${i}`, payee, c, T0 + i * MIN));

  test("below the gross floor nothing flags, however concentrated", () => {
    const ps = [pay("a", "x", floor - 1, T0)];
    expect(payerConcentration(payeeGross(ps, RULES), RULES)).toEqual([]);
  });

  test("at the floor one payer bringing everything flags", () => {
    const ps = [pay("a", "x", floor, T0)];
    expect(payerConcentration(payeeGross(ps, RULES), RULES)).toEqual([
      {
        payeeUserId: "x",
        windowStart: new Date(T0),
        evidence: { grossCents: floor, topShareBps: 10_000, newPayerShareBps: 0, payers: 1 },
      },
    ]);
  });

  test("top-N share exactly at the threshold flags, one cent less does not", () => {
    // Top 3 bring 80 000 of 100 000 (exactly 80 %); the rest is spread thin.
    const top = [30_000, 25_000, 25_000];
    const tail = Array.from({ length: 20 }, () => 1000);
    const at = payerConcentration(payeeGross(spread("x", [...top, ...tail]), RULES), RULES);
    expect(at).toHaveLength(1);
    expect(at[0]?.evidence).toMatchObject({ grossCents: 100_000, topShareBps: 8000, payers: 23 });

    // Top 3 bring 79 999 of 100 000.
    const under = [30_000, 25_000, 24_999];
    const tail2 = [...Array.from({ length: 19 }, () => 1000), 1001];
    expect(payerConcentration(payeeGross(spread("x", [...under, ...tail2]), RULES), RULES)).toEqual([]);
  });

  test("new payers' share flags even when the payers are many", () => {
    // 20 payers of 2 500 each: top 3 = 15 %; half of them are accounts a day old.
    const ps = Array.from({ length: 20 }, (_, i) =>
      pay(`p${i}`, "x", 2500, T0 + i * MIN, i < 10 ? new Date(T0 - DAY) : OLD),
    );
    const hits = payerConcentration(payeeGross(ps, RULES), RULES);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.evidence).toMatchObject({ grossCents: 50_000, topShareBps: 1500, newPayerShareBps: 5000 });
    // One fewer new payer: 45 %, and nothing flags.
    const fewer = ps.map((p, i) => (i === 9 ? { ...p, payerCreatedAt: OLD } : p));
    expect(payerConcentration(payeeGross(fewer, RULES), RULES)).toEqual([]);
  });

  test("account age is judged at payment time, at the day boundary", () => {
    const days = RULES.newPayerAccountDays;
    // Created exactly `days` before the payment: not new. One millisecond later: new.
    const notNew = pay("a", "x", floor, T0, new Date(T0 - days * DAY));
    const isNew = pay("a", "x", floor, T0, new Date(T0 - days * DAY + 1));
    const [g1] = payeeGross([notNew], RULES);
    const [g2] = payeeGross([isNew], RULES);
    expect(g1?.payers[0]?.newPayerCents).toBe(0);
    expect(g2?.payers[0]?.newPayerCents).toBe(floor);
  });

  test("payments from deleted payers count in the gross only", () => {
    const ps = [
      ...Array.from({ length: 10 }, (_, i) => pay(`p${i}`, "x", 4000, T0 + i)),
      pay(null, "x", 60_000, T0 + 100),
    ];
    const [g] = payeeGross(ps, RULES);
    expect(g?.grossCents).toBe(100_000);
    // Known top 3 = 12 000 of 100 000; the payerless 60 000 never counts as one payer.
    expect(payerConcentration(payeeGross(ps, RULES), RULES)).toEqual([]);
  });

  test("payeeGross respects `since` and ignores non-positive amounts", () => {
    const ps = [pay("a", "x", 1000, T0 - 31 * DAY), pay("a", "x", 2000, T0), pay("a", "x", 0, T0 + 1)];
    const [g] = payeeGross(ps, RULES, new Date(T0 - 30 * DAY));
    expect(g).toMatchObject({ grossCents: 2000, firstAt: new Date(T0) });
  });

  test("refunds are excluded: the reader hands in net amounts and drops refunded payments", () => {
    // 60 000 paid, 20 000 of it refunded: 40 000 net, under the floor.
    const ps = [pay("a", "x", 60_000 - 20_000, T0)];
    expect(payerConcentration(payeeGross(ps, RULES), RULES)).toEqual([]);
  });

  test("evidence holds integers only", () => {
    const ps = spread("x", [33_333, 33_333, 33_334]);
    const [hit] = payerConcentration(payeeGross(ps, RULES), RULES);
    for (const v of Object.values(hit?.evidence ?? {})) expect(Number.isInteger(v)).toBe(true);
  });
});

describe("newPayee", () => {
  test("at or above the threshold", () => {
    const at = RULES.newPayeeFirstPayoutCents;
    expect(newPayee(at - 1, RULES)).toBeNull();
    expect(newPayee(at, RULES)).toEqual({ payoutCents: at });
    expect(newPayee(at + 1, RULES)).toEqual({ payoutCents: at + 1 });
  });
  test("rules are a parameter", () => {
    const rules: PaymentFraudRules = { ...RULES, newPayeeFirstPayoutCents: 10 };
    expect(newPayee(10, rules)).toEqual({ payoutCents: 10 });
  });
});

describe("fraudScan (no re-raise after a decision)", () => {
  const now = new Date(T0 + 10 * DAY);
  const concentrated = (fromMs: number) => [pay("a", "x", RULES.concentrationMinGrossCents, fromMs)];

  test("concentration looks back its window only", () => {
    const ps = concentrated(now.getTime() - (RULES.concentrationWindowDays * DAY + 1));
    expect(scanSignals(ps, RULES, now).payer_concentration).toEqual([]);
    expect(scanSignals(concentrated(now.getTime() - DAY), RULES, now).payer_concentration).toHaveLength(1);
  });

  test("undecided payees are raised", () => {
    const hits = fraudScan(concentrated(T0), RULES, now, () => null);
    expect(hits.map((h) => [h.kind, h.payeeUserId])).toEqual([["payer_concentration", "x"]]);
  });

  test("a decision at or after the window start suppresses the same evidence", () => {
    expect(fraudScan(concentrated(T0), RULES, now, () => new Date(T0))).toEqual([]);
    expect(fraudScan(concentrated(T0), RULES, now, () => new Date(T0 + DAY))).toEqual([]);
  });

  test("a decision before the evidence starts does not", () => {
    expect(fraudScan(concentrated(T0), RULES, now, () => new Date(T0 - 1))).toHaveLength(1);
  });

  test("new evidence after the decision is raised, counting only that evidence", () => {
    const decided = new Date(T0 + DAY);
    const ps = [...concentrated(T0), pay("b", "x", RULES.concentrationMinGrossCents, T0 + 2 * DAY)];
    const [hit] = fraudScan(ps, RULES, now, () => decided);
    expect(hit?.kind).toBe("payer_concentration");
    expect(hit?.evidence.grossCents).toBe(RULES.concentrationMinGrossCents);
    expect(hit?.windowStart).toEqual(new Date(T0 + 2 * DAY));
  });

  test("decisions are per kind", () => {
    const max = RULES.velocityMaxPayments;
    const ps = burst("a", "x", max + 1, T0).map((p) => ({ ...p, amountCents: 5000 }));
    const all = fraudScan(ps, RULES, now, () => null);
    expect(all.map((h) => h.kind).sort()).toEqual(["payer_concentration", "payer_velocity"]);
    const onlyVelocity = fraudScan(ps, RULES, now, (_p, kind) =>
      kind === "payer_concentration" ? new Date(T0 + DAY) : null,
    );
    expect(onlyVelocity.map((h) => h.kind)).toEqual(["payer_velocity"]);
  });
});
