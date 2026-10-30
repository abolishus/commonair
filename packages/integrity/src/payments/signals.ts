// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Payment fraud floor signals (ADR 0036 decision 1): pure, explainable, exact. Shares are compared
 * with integer arithmetic (BigInt cross-multiplication) and reported in basis points (floored), so
 * a boundary like "exactly 80 %" is decided the same way on every machine and evidence never holds
 * a float. Inputs carry ids, cents and times only.
 */
import { PAYMENT_FRAUD_RULES } from "@commonair/contracts/enums";

/** `PAYMENT_FRAUD_RULES` with its numbers widened, so tests and callers can pass other thresholds. */
export type PaymentFraudRules = { readonly [K in keyof typeof PAYMENT_FRAUD_RULES]: number };

export const DEFAULT_PAYMENT_FRAUD_RULES: PaymentFraudRules = PAYMENT_FRAUD_RULES;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
export const BPS = 10_000;

/**
 * One succeeded payment as the signals see it. `amountCents` is net of refunds; fully refunded or
 * charged-back payments are never handed in (the reader drops them). An anonymous payment still
 * has its payer's id: anonymity hides the payer from the channel, not from the fraud floor.
 */
export interface FraudPayment {
  paymentId: string;
  /** Null when the payer's account is gone (`on delete set null`). */
  payerUserId: string | null;
  payeeUserId: string;
  amountCents: number;
  succeededAt: Date;
  /** The payer account's creation time; null with the payer. */
  payerCreatedAt: Date | null;
}

export type FraudEvidence = Record<string, string | number>;

/** A signal's verdict on one payee. `windowStart` is where its evidence begins (the no-re-raise rule). */
export interface FraudHit {
  payeeUserId: string;
  windowStart: Date;
  evidence: FraudEvidence;
}

/** floor(part / whole × 10 000); 0 for an empty whole. */
export function shareBps(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Number((BigInt(part) * BigInt(BPS)) / BigInt(whole));
}

/** part / whole ≥ threshold, decided exactly (threshold as a fraction, read in basis points). */
export function reachesShare(part: number, whole: number, threshold: number): boolean {
  if (whole <= 0) return false;
  const thresholdBps = BigInt(Math.round(threshold * BPS));
  return BigInt(part) * BigInt(BPS) >= thresholdBps * BigInt(whole);
}

const byTime = (a: FraudPayment, b: FraudPayment) =>
  a.succeededAt.getTime() - b.succeededAt.getTime() || a.paymentId.localeCompare(b.paymentId);

/**
 * `payer_velocity`: a payer with more than `velocityMaxPayments` succeeded payments (to any
 * channel) inside any window of `velocityWindowMinutes` (half-open: [first, first + window)) flags
 * every payee paid in that window. One hit per payee: the earliest window that flags it (ties: the
 * one with most payments, then the payer id), evidence `{ payerUserId, payments, windowStart }`.
 */
export function payerVelocity(payments: readonly FraudPayment[], rules: PaymentFraudRules): FraudHit[] {
  const windowMs = rules.velocityWindowMinutes * MINUTE_MS;
  const byPayer = new Map<string, FraudPayment[]>();
  for (const p of payments) {
    if (p.payerUserId === null) continue;
    const list = byPayer.get(p.payerUserId);
    if (list) list.push(p);
    else byPayer.set(p.payerUserId, [p]);
  }
  const best = new Map<string, { at: number; payments: number; payer: string }>();
  for (const [payer, list] of byPayer) {
    list.sort(byTime);
    let end = 0;
    for (let start = 0; start < list.length; start++) {
      const from = list[start]?.succeededAt.getTime() ?? 0;
      if (end < start) end = start;
      while (end + 1 < list.length && (list[end + 1]?.succeededAt.getTime() ?? 0) - from < windowMs) end++;
      const count = end - start + 1;
      if (count <= rules.velocityMaxPayments) continue;
      for (let i = start; i <= end; i++) {
        const payee = list[i]?.payeeUserId;
        if (payee === undefined) continue;
        const cur = best.get(payee);
        const better =
          !cur ||
          from < cur.at ||
          (from === cur.at && (count > cur.payments || (count === cur.payments && payer < cur.payer)));
        if (better) best.set(payee, { at: from, payments: count, payer });
      }
    }
  }
  return [...best]
    .map(([payeeUserId, b]) => ({
      payeeUserId,
      windowStart: new Date(b.at),
      evidence: { payerUserId: b.payer, payments: b.payments, windowStart: new Date(b.at).toISOString() },
    }))
    .sort((a, b) => a.payeeUserId.localeCompare(b.payeeUserId));
}

/** One payer's contribution to a payee's gross. */
export interface PayerGross {
  payerUserId: string | null;
  cents: number;
  /** Of `cents`, what was paid while the payer's account was younger than `newPayerAccountDays`. */
  newPayerCents: number;
}

/** A payee's gross over the concentration window, by payer. */
export interface PayeeGross {
  payeeUserId: string;
  grossCents: number;
  /** The earliest payment counted. */
  firstAt: Date;
  payers: PayerGross[];
}

/**
 * Group payments at or after `since` by payee and payer. A payment whose payer's account was
 * younger than `newPayerAccountDays` when it was made counts as new-payer money; a payment whose
 * payer is gone counts in the gross only (it can never make a payee look more concentrated).
 */
export function payeeGross(
  payments: readonly FraudPayment[],
  rules: PaymentFraudRules,
  since: Date | null = null,
): PayeeGross[] {
  const newMs = rules.newPayerAccountDays * DAY_MS;
  const out = new Map<string, { gross: number; first: number; payers: Map<string, PayerGross>; anon: number }>();
  for (const p of payments) {
    const at = p.succeededAt.getTime();
    if (since && at < since.getTime()) continue;
    if (p.amountCents <= 0) continue;
    let g = out.get(p.payeeUserId);
    if (!g) {
      g = { gross: 0, first: at, payers: new Map(), anon: 0 };
      out.set(p.payeeUserId, g);
    }
    g.gross += p.amountCents;
    g.first = Math.min(g.first, at);
    if (p.payerUserId === null) {
      g.anon += p.amountCents;
      continue;
    }
    const isNew = p.payerCreatedAt !== null && at - p.payerCreatedAt.getTime() < newMs;
    const cur = g.payers.get(p.payerUserId) ?? { payerUserId: p.payerUserId, cents: 0, newPayerCents: 0 };
    cur.cents += p.amountCents;
    if (isNew) cur.newPayerCents += p.amountCents;
    g.payers.set(p.payerUserId, cur);
  }
  return [...out]
    .map(([payeeUserId, g]) => ({
      payeeUserId,
      grossCents: g.gross,
      firstAt: new Date(g.first),
      payers: [
        ...[...g.payers.values()].sort(
          (a, b) => b.cents - a.cents || (a.payerUserId ?? "").localeCompare(b.payerUserId ?? ""),
        ),
        ...(g.anon > 0 ? [{ payerUserId: null, cents: g.anon, newPayerCents: 0 }] : []),
      ],
    }))
    .sort((a, b) => a.payeeUserId.localeCompare(b.payeeUserId));
}

/**
 * `payer_concentration`: a payee whose gross reaches `concentrationMinGrossCents` and either the
 * top `concentrationTopN` payers bring at least `concentrationShare` of it, or new payers bring at
 * least `newPayerShare` of it. Evidence `{ grossCents, topShareBps, newPayerShareBps, payers }`
 * (`payers`: distinct known payers).
 */
export function payerConcentration(gross: readonly PayeeGross[], rules: PaymentFraudRules): FraudHit[] {
  const hits: FraudHit[] = [];
  for (const g of gross) {
    if (g.grossCents < rules.concentrationMinGrossCents) continue;
    const known = g.payers.filter((p) => p.payerUserId !== null).sort((a, b) => b.cents - a.cents);
    const top = known.slice(0, Math.max(0, rules.concentrationTopN)).reduce((s, p) => s + p.cents, 0);
    const fresh = known.reduce((s, p) => s + p.newPayerCents, 0);
    if (
      !reachesShare(top, g.grossCents, rules.concentrationShare) &&
      !reachesShare(fresh, g.grossCents, rules.newPayerShare)
    )
      continue;
    hits.push({
      payeeUserId: g.payeeUserId,
      windowStart: g.firstAt,
      evidence: {
        grossCents: g.grossCents,
        topShareBps: shareBps(top, g.grossCents),
        newPayerShareBps: shareBps(fresh, g.grossCents),
        payers: known.length,
      },
    });
  }
  return hits;
}

/** `new_payee`: a payee's first payout ever at or above `newPayeeFirstPayoutCents`; evidence `{ payoutCents }`. */
export function newPayee(firstPayoutCents: number, rules: PaymentFraudRules): FraudEvidence | null {
  return firstPayoutCents >= rules.newPayeeFirstPayoutCents ? { payoutCents: firstPayoutCents } : null;
}

/** The scan's signals over one window of payments (`now` ends it; concentration looks back its own days). */
export function scanSignals(
  payments: readonly FraudPayment[],
  rules: PaymentFraudRules,
  now: Date,
): { payer_velocity: FraudHit[]; payer_concentration: FraudHit[] } {
  const since = new Date(now.getTime() - rules.concentrationWindowDays * DAY_MS);
  return {
    payer_velocity: payerVelocity(payments, rules),
    payer_concentration: payerConcentration(payeeGross(payments, rules, since), rules),
  };
}

export type ScanKind = "payer_velocity" | "payer_concentration";

export interface ScanHit extends FraudHit {
  kind: ScanKind;
}

/**
 * The scan with ADR 0036's no-re-raise rule: a (payee, kind) whose latest flag was decided at or
 * after the start of a hit's evidence window is not raised on that evidence; only payments after
 * the decision count, so a cleared payee is flagged again only on new evidence. `decidedAt`
 * answers the latest decision time of a (payee, kind), or null.
 */
export function fraudScan(
  payments: readonly FraudPayment[],
  rules: PaymentFraudRules,
  now: Date,
  decidedAt: (payeeUserId: string, kind: ScanKind) => Date | null,
): ScanHit[] {
  const first = scanSignals(payments, rules, now);
  const rescans = new Map<number, ReturnType<typeof scanSignals>>();
  const rescan = (after: Date) => {
    const key = after.getTime();
    let r = rescans.get(key);
    if (!r) {
      r = scanSignals(
        payments.filter((p) => p.succeededAt.getTime() > key),
        rules,
        now,
      );
      rescans.set(key, r);
    }
    return r;
  };
  const out: ScanHit[] = [];
  for (const kind of ["payer_velocity", "payer_concentration"] as const) {
    for (const hit of first[kind]) {
      const decided = decidedAt(hit.payeeUserId, kind);
      if (decided === null || decided.getTime() < hit.windowStart.getTime()) {
        out.push({ kind, ...hit });
        continue;
      }
      const fresh = rescan(decided)[kind].find((h) => h.payeeUserId === hit.payeeUserId);
      if (fresh) out.push({ kind, ...fresh });
    }
  }
  return out;
}
