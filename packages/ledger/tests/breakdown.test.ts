// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { accounts } from "../src/accounts.ts";
import {
  BreakdownError,
  type BreakdownTransaction,
  type BuiltBreakdown,
  breakdownSettlement,
  buildBreakdown,
  coopNet,
  reconciles,
  settlementCode,
  settlementMovement,
} from "../src/breakdown.ts";
import { PaymentMetaV2, ReversalMetaV2 } from "../src/meta.ts";
import type { Posting } from "../src/posting.ts";
import {
  type PlatformCut,
  type Settlement,
  chargeback,
  chargebackReversal,
  holdRelease,
  holdReleaseDueAt,
  paymentSucceeded,
  refund,
} from "../src/rules.ts";

const CREATOR = "01890000-0000-7000-8000-00000000c0de";
const CREW = "01890000-0000-7000-8000-00000000c0df";
const PAYMENT = "01890000-0000-7000-8000-0000000000aa";
const OTHER = "01890000-0000-7000-8000-0000000000bb";
const HISTORY = "01890000-0000-7000-8000-0000000000cc";
const T0 = new Date("2026-03-15T12:00:00Z");
const DAY = 86_400_000;

/** Deterministic PRNG so the property test is reproducible. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const int = (r: () => number, max: number) => Math.floor(r() * (max + 1));

let txN = 0;
/** A posting as the database returns it: stored codes, an id. */
function asTx(p: Posting): BreakdownTransaction {
  txN += 1;
  return {
    id: `01890000-0000-7000-8000-${String(txN).padStart(12, "0")}`,
    kind: p.kind,
    occurredAt: p.occurredAt,
    metadata: JSON.parse(JSON.stringify(p.metadata)) as unknown,
    entries: p.entries.map((e) => ({ code: `${e.code}@${p.currency}`, amountCents: e.amountCents, memo: e.memo })),
  };
}

const facts = (succeededAt: Date | null = T0) => ({ id: PAYMENT, kind: "tip", currency: "usd", succeededAt }) as const;

function paid(o: { gross: number; tax?: number; fee?: number; cut?: PlatformCut; settlement?: Settlement }) {
  return paymentSucceeded({
    paymentId: PAYMENT,
    paymentKind: "tip",
    provider: "stripe",
    settlement: o.settlement ?? "cash",
    creatorUserId: CREATOR,
    grossCents: o.gross,
    taxCents: o.tax ?? 0,
    feeCents: o.fee ?? 0,
    currency: "usd",
    cut: o.cut ?? { streamerShare: 0.9, coopShare: 0.1 },
    cutHistoryId: null,
    occurredAt: T0,
  });
}

const sum = (b: BuiltBreakdown, pick: (l: BuiltBreakdown["lines"][number]) => boolean) =>
  b.lines.filter(pick).reduce((s, l) => s + l.amount.cents, 0);
const grossSide = (b: BuiltBreakdown) => sum(b, (l) => ["tax", "creator", "coop_share"].includes(l.kind));

describe("buildBreakdown", () => {
  test("a plain tip: creator, co-op share and processor fee; co-op net can be negative", () => {
    const b = buildBreakdown(facts(), [asTx(paid({ gross: 500, fee: 45 }))], 30);
    expect(b.lines.map((l) => [l.kind, l.amount.cents])).toEqual([
      ["creator", 450],
      ["coop_share", 50],
      ["processor_fee", 45],
      ["coop_net", 5],
    ]);
    expect(grossSide(b)).toBe(500);
    const small = buildBreakdown(facts(), [asTx(paid({ gross: 200, fee: 36 }))], 30);
    expect(small.lines.find((l) => l.kind === "coop_net")?.amount.cents).toBe(20 - 36);
    expect(small.lines.find((l) => l.kind === "coop_net")?.transactionId).toBeNull();
  });

  test("tax gets a line only when charged; the creator line names its recipient", () => {
    const b = buildBreakdown(facts(), [asTx(paid({ gross: 1100, tax: 100 }))], 30);
    expect(b.lines[0]).toMatchObject({ kind: "tax", amount: { cents: 100, currency: "usd" } });
    expect(b.lines.find((l) => l.kind === "creator")?.recipientUserId).toBe(CREATOR);
    expect(grossSide(b)).toBe(1100);
  });

  test("the hold date falls back to holdReleaseDueAt, and a release replaces it", () => {
    const pay = asTx(paid({ gross: 1000 }));
    const open = buildBreakdown(facts(), [pay], 14);
    expect(open.holdReleasesAt).toBe(holdReleaseDueAt(T0, 14).toISOString());
    expect(open.holdReleasedAt).toBeNull();
    const releasedAt = new Date(T0.getTime() + 14 * DAY);
    const release = asTx(
      holdRelease({
        paymentId: PAYMENT,
        creatorUserId: CREATOR,
        amountCents: 900,
        currency: "usd",
        occurredAt: releasedAt,
      }),
    );
    const done = buildBreakdown(facts(), [release, pay], 14);
    expect(done.holdReleasesAt).toBeNull();
    expect(done.holdReleasedAt).toBe(releasedAt.toISOString());
    expect(done.timeline.map((e) => [e.kind, e.amount?.cents])).toEqual([
      ["paid", 1000],
      ["hold_released", 900],
    ]);
  });

  test("a refund that empties the hold lot leaves no release date; a partial one keeps it", () => {
    const pay = asTx(paid({ gross: 1000 }));
    const refundOf = (disputeId: string, amountCents: number, alreadyReversedCents: number, lot: number) =>
      asTx(
        refund({
          disputeId,
          paymentId: PAYMENT,
          provider: "stripe",
          creatorUserId: CREATOR,
          currency: "usd",
          occurredAt: new Date(T0.getTime() + DAY),
          original: { grossCents: 1000, taxCents: 0 },
          cut: { streamerShare: 0.9, coopShare: 0.1 },
          alreadyReversedCents,
          amountCents,
          balances: { liabilityCents: 0, holdLots: [{ paymentId: PAYMENT, cents: lot }] },
        }),
      );
    const partial = refundOf(OTHER, 400, 0, 900);
    const half = buildBreakdown(facts(), [pay, partial], 14);
    expect(half.holdReleasesAt).toBe(holdReleaseDueAt(T0, 14).toISOString());
    const rest = refundOf(HISTORY, 600, 400, 900 - ReversalMetaV2.parse(partial.metadata).shares[0]!.fromOwnLotCents);
    const empty = buildBreakdown(facts(), [pay, partial, rest], 14);
    expect(empty.holdReleasesAt).toBeNull();
    expect(empty.holdReleasedAt).toBeNull();
  });

  test("succeededAt comes from the row, else the posting", () => {
    const later = new Date(T0.getTime() + 1000);
    expect(buildBreakdown(facts(later), [asTx(paid({ gross: 100 }))], 0).succeededAt).toBe(later.toISOString());
    expect(buildBreakdown(facts(null), [asTx(paid({ gross: 100 }))], 0).succeededAt).toBe(T0.toISOString());
  });

  test("the cut and its history id come from the posting", () => {
    const p = paid({ gross: 1000, cut: { streamerShare: 0.85, coopShare: 0.15 } });
    const meta = PaymentMetaV2.parse(p.metadata);
    const tx = asTx({ ...p, metadata: { ...p.metadata, cutHistoryId: HISTORY } });
    const b = buildBreakdown(facts(), [tx], 30);
    expect(b.cut).toEqual({ historyId: HISTORY, streamerShare: 0.85, coopShare: 0.15 });
    expect(meta.cutHistoryId).toBeNull();
  });

  test("a two-share PaymentMetaV2 yields two creator lines (Ledger Splits needs no change here)", () => {
    const p = paid({ gross: 1000, fee: 10 });
    const meta = PaymentMetaV2.parse(p.metadata);
    const shares = [
      { userId: CREW, role: "crew" as const, bps: 2_000, creatorCents: 180 },
      { userId: CREATOR, role: "owner" as const, bps: 8_000, creatorCents: 720 },
    ];
    const tx = asTx({ ...p, metadata: PaymentMetaV2.parse({ ...meta, shares }) });
    const b = buildBreakdown(facts(), [tx], 30);
    const creators = b.lines.filter((l) => l.kind === "creator");
    expect(creators.map((l) => [l.recipientUserId, l.amount.cents])).toEqual([
      [CREATOR, 720],
      [CREW, 180],
    ]);
    expect(grossSide(b)).toBe(1000);
    expect(reconciles(b, settlementMovement([tx]))).toBe(true);
  });

  test("v1 or unparsable metadata throws (there is no v1 reader)", () => {
    const p = paid({ gross: 1000 });
    const v1 = asTx({ ...p, metadata: { ...p.metadata, v: 1 } });
    expect(() => buildBreakdown(facts(), [v1], 30)).toThrow(BreakdownError);
    const none = asTx({ ...p, metadata: {} });
    expect(() => buildBreakdown(facts(), [none], 30)).toThrow(BreakdownError);
    expect(() => buildBreakdown(facts(), [], 30)).toThrow(BreakdownError);
    expect(() => buildBreakdown(facts(), [asTx(p), asTx(p)], 30)).toThrow(BreakdownError);
    const pay = asTx(p);
    const bad = asTx(
      refund({
        disputeId: OTHER,
        paymentId: PAYMENT,
        provider: "stripe",
        creatorUserId: CREATOR,
        currency: "usd",
        occurredAt: T0,
        original: { grossCents: 1000, taxCents: 0 },
        cut: { streamerShare: 0.9, coopShare: 0.1 },
        alreadyReversedCents: 0,
        amountCents: 100,
        balances: { liabilityCents: 0, holdLots: [{ paymentId: PAYMENT, cents: 900 }] },
      }),
    );
    expect(() => buildBreakdown(facts(), [pay, { ...bad, metadata: { v: 1 } }], 30)).toThrow(BreakdownError);
    // A tampered split (components no longer summing) is refused, not shown.
    const meta = ReversalMetaV2.parse(bad.metadata);
    expect(() =>
      buildBreakdown(facts(), [pay, { ...bad, metadata: { ...meta, coopCents: meta.coopCents - 1 } }], 30),
    ).toThrow(BreakdownError);
  });

  test("a won chargeback restores positively and returns the dispute fee as a negative fee", () => {
    const pay = asTx(paid({ gross: 1000, fee: 59 }));
    const cbPosting = chargeback({
      disputeId: OTHER,
      paymentId: PAYMENT,
      provider: "stripe",
      creatorUserId: CREATOR,
      currency: "usd",
      occurredAt: new Date(T0.getTime() + DAY),
      original: { grossCents: 1000, taxCents: 0 },
      cut: { streamerShare: 0.9, coopShare: 0.1 },
      alreadyReversedCents: 0,
      amountCents: 1000,
      balances: { liabilityCents: 0, holdLots: [{ paymentId: PAYMENT, cents: 900 }] },
      disputeFeeCents: 1500,
    });
    const cb = asTx(cbPosting);
    const m = ReversalMetaV2.parse(cbPosting.metadata);
    const won = asTx(
      chargebackReversal({
        disputeId: OTHER,
        paymentId: PAYMENT,
        creatorUserId: CREATOR,
        provider: "stripe",
        currency: "usd",
        occurredAt: new Date(T0.getTime() + 2 * DAY),
        chargeback: {
          amountCents: -m.revenueGrossCents,
          taxCents: -m.taxCents,
          creatorCents: -m.creatorCents,
          coopCents: -m.coopCents,
        },
        receivableCents: 0,
        feeRefundCents: 1500,
      }),
    );
    const b = buildBreakdown(facts(), [pay, cb, won], 30);
    expect(b.timeline.map((e) => [e.kind, e.amount?.cents])).toEqual([
      ["paid", 1000],
      ["charged_back", -1000],
      ["chargeback_won", 1000],
    ]);
    expect(b.lines.filter((l) => l.kind === "dispute_fee").map((l) => l.amount.cents)).toEqual([1500, -1500]);
    expect(sum(b, (l) => l.kind === "reversal" && l.transactionId === won.id)).toBe(1000);
    expect(b.lines.find((l) => l.kind === "coop_net")?.amount.cents).toBe(100 - 59);
    expect(reconciles(b, settlementMovement([pay, cb, won]))).toBe(true);
  });

  test("an extra transaction moving settlement is a mismatch, not a line", () => {
    const pay = asTx(paid({ gross: 1000, fee: 30 }));
    const tamper: BreakdownTransaction = {
      id: OTHER,
      kind: "manual_adjustment",
      occurredAt: T0,
      metadata: {},
      entries: [
        { code: `${accounts.cash("stripe")}@usd`, amountCents: -7 },
        { code: `${accounts.paymentFees()}@usd`, amountCents: 7 },
      ],
    };
    const b = buildBreakdown(facts(), [pay, tamper], 30);
    expect(b.timeline).toHaveLength(1);
    expect(breakdownSettlement(b)).toBe(970);
    expect(settlementMovement([pay, tamper])).toBe(963);
    expect(reconciles(b, settlementMovement([pay, tamper]))).toBe(false);
  });

  test("settlementCode follows the posting's settlement", () => {
    expect(settlementCode({ provider: "manual", settlement: "receivable" })).toBe(
      accounts.providerReceivable("manual"),
    );
    expect(settlementCode({ provider: "stripe", settlement: "cash" })).toBe(accounts.cash("stripe"));
  });
});

describe("property: breakdowns of real postings", () => {
  test("gross side = gross, reversals sum to their amounts, fees outside, coop_net, reconciles", () => {
    const r = prng(20261030);
    for (let run = 0; run < 400; run++) {
      txN = 0;
      const gross = 1 + int(r, 50_000);
      const tax = int(r, Math.floor(gross / 4));
      const k = int(r, 100);
      const cut = { streamerShare: k / 100, coopShare: (100 - k) / 100 };
      const fee = int(r, Math.min(gross + 100, 2_000));
      const settlement: Settlement = r() < 0.2 ? "receivable" : "cash";
      const provider = r() < 0.5 ? "stripe" : "manual";
      const base = paymentSucceeded({
        paymentId: PAYMENT,
        paymentKind: r() < 0.5 ? "tip" : "subscription",
        provider,
        settlement,
        creatorUserId: CREATOR,
        grossCents: gross,
        taxCents: tax,
        feeCents: fee,
        currency: "usd",
        cut,
        cutHistoryId: r() < 0.5 ? null : HISTORY,
        occurredAt: T0,
      });
      const meta = PaymentMetaV2.parse(base.metadata);
      const txs: BreakdownTransaction[] = [asTx(base)];
      let hold = meta.creatorCents;
      if (r() < 0.4 && hold > 0) {
        txs.push(
          asTx(
            holdRelease({
              paymentId: PAYMENT,
              creatorUserId: CREATOR,
              amountCents: hold,
              currency: "usd",
              occurredAt: new Date(T0.getTime() + DAY),
            }),
          ),
        );
        hold = 0;
      }
      let reversed = 0;
      const open: { disputeId: string; meta: ReversalMetaV2; fee: number }[] = [];
      const expected = { disputeFees: 0, feeRefunds: 0, coopReversed: 0 };
      const steps = int(r, 4);
      for (let s = 0; s < steps; s++) {
        const at = new Date(T0.getTime() + (s + 2) * DAY);
        const left = gross - reversed;
        const winOne = open.length > 0 && r() < 0.3;
        if (winOne) {
          const c = open.splice(int(r, open.length - 1), 1)[0];
          if (!c) continue;
          const feeRefund = int(r, c.fee);
          const p = chargebackReversal({
            disputeId: c.disputeId,
            paymentId: PAYMENT,
            creatorUserId: CREATOR,
            provider,
            settlement,
            currency: "usd",
            occurredAt: at,
            chargeback: {
              amountCents: -c.meta.revenueGrossCents,
              taxCents: -c.meta.taxCents,
              creatorCents: -c.meta.creatorCents,
              coopCents: -c.meta.coopCents,
            },
            receivableCents: int(r, 5_000),
            feeRefundCents: feeRefund,
          });
          reversed += c.meta.revenueGrossCents;
          expected.feeRefunds += feeRefund;
          expected.coopReversed -= c.meta.coopCents;
          txs.push(asTx(p));
          continue;
        }
        if (left <= 0) continue;
        const amount = 1 + int(r, left - 1);
        const input = {
          disputeId: `01890000-0000-7000-8000-1${String(run).padStart(5, "0")}${String(s).padStart(6, "0")}`,
          paymentId: PAYMENT,
          provider,
          settlement,
          creatorUserId: CREATOR,
          currency: "usd",
          occurredAt: at,
          original: { grossCents: gross, taxCents: tax },
          cut,
          alreadyReversedCents: reversed,
          amountCents: amount,
          balances: {
            liabilityCents: int(r, 3_000),
            holdLots: [
              { paymentId: PAYMENT, cents: hold },
              { paymentId: OTHER, cents: int(r, 2_000) },
            ],
          },
        };
        const isChargeback = r() < 0.5;
        const disputeFee = isChargeback ? int(r, 1_500) : 0;
        const p = isChargeback ? chargeback({ ...input, disputeFeeCents: disputeFee }) : refund(input);
        const m = ReversalMetaV2.parse(p.metadata);
        hold = Math.max(0, hold - m.shares[0]!.fromOwnLotCents);
        reversed += amount;
        expected.disputeFees += disputeFee;
        expected.coopReversed += m.coopCents;
        if (isChargeback) open.push({ disputeId: input.disputeId, meta: m, fee: disputeFee });
        txs.push(asTx(p));
      }

      // Shuffle: the builder orders by time itself.
      const shuffled = [...txs].sort(() => r() - 0.5);
      const b = buildBreakdown({ id: PAYMENT, kind: "tip", currency: "usd", succeededAt: T0 }, shuffled, 30);
      const ctx = { run, gross, tax, cut, fee, steps };

      expect(grossSide(b), JSON.stringify(ctx)).toBe(gross);
      expect(b.gross.cents).toBe(gross);
      for (const tx of txs.filter((t) => ["refund", "chargeback", "chargeback_reversal"].includes(t.kind))) {
        const m = ReversalMetaV2.parse(tx.metadata);
        expect(sum(b, (l) => l.kind === "reversal" && l.transactionId === tx.id)).toBe(m.revenueGrossCents);
        expect(
          b.lines.filter((l) => l.kind === "reversal" && l.transactionId === tx.id).every((l) => l.component),
        ).toBe(true);
      }
      expect(sum(b, (l) => l.kind === "processor_fee")).toBe(fee);
      expect(sum(b, (l) => l.kind === "dispute_fee")).toBe(expected.disputeFees - expected.feeRefunds);
      const net = b.lines.filter((l) => l.kind === "coop_net");
      expect(net).toHaveLength(1);
      expect(net[0]?.amount.cents).toBe(
        meta.coopCents + expected.coopReversed - fee - expected.disputeFees + expected.feeRefunds,
      );
      expect(coopNet(b.lines.filter((l) => l.kind !== "coop_net"))).toBe(net[0]?.amount.cents);
      expect(reconciles(b, settlementMovement(shuffled)), JSON.stringify(ctx)).toBe(true);
      // An emptied lot is never released, so it has no release date either.
      const released = txs.some((t) => t.kind === "hold_release");
      expect(b.holdReleasesAt === null, JSON.stringify(ctx)).toBe(released || hold === 0);
      expect(b.holdReleasedAt === null).toBe(!released);
      expect(b.timeline).toHaveLength(txs.length);
      const times = b.timeline.map((e) => Date.parse(e.at));
      expect([...times].sort((x, y) => x - y)).toEqual(times);
    }
  });
});
