// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `money-fraud-scan` (ADR 0036): run the payment fraud signals over the concentration window,
 * raise a flag for each new hit and hold the payee's payouts, one transaction per payee, with the
 * audit row (actor `system`) and the internal `money.fraud.flag` event in it. A (payee, kind) with
 * an undecided flag is skipped; one decided at or after the evidence's start is raised again only
 * on evidence newer than the decision (`fraudScan`), so a clear is not undone by the next tick.
 */
import {
  DEFAULT_PAYMENT_FRAUD_RULES,
  type PaymentFraudRules,
  type ScanHit,
  decisionKey,
  fraudScan,
  latestFraudDecisions,
  readFraudPayments,
  undecidedFraudFlags,
} from "@commonair/integrity";
import { raiseFraudFlag } from "@commonair/ledger";
import { meter } from "@commonair/observability";
import type { WorkerContext } from "../context.ts";

const DAY_MS = 86_400_000;

const m = meter("commonair.worker");

/** Fraud scan instruments (no-ops until telemetry is initialised). Counts only, never ids. */
export const fraudMetrics = {
  flags: m.createCounter("worker.money.fraud_flags", {
    description:
      "Fraud scan hits by kind and outcome (raised; existing: an undecided flag already holds the payee; race: raised elsewhere first)",
  }),
  held: m.createCounter("worker.money.fraud_held_payouts", {
    description: "Payouts moved to held / fraud_review when a fraud flag was raised",
  }),
};

export interface FraudScanResult {
  flagged: number;
  held: number;
}

export async function runFraudScan(
  ctx: Pick<WorkerContext, "db" | "logger" | "now">,
  rules: PaymentFraudRules = DEFAULT_PAYMENT_FRAUD_RULES,
): Promise<FraudScanResult> {
  const now = ctx.now();
  const since = new Date(now.getTime() - rules.concentrationWindowDays * DAY_MS);
  const [payments, decisions, undecided] = await Promise.all([
    readFraudPayments(ctx.db, { since, until: now }),
    latestFraudDecisions(ctx.db),
    undecidedFraudFlags(ctx.db),
  ]);
  const hits = fraudScan(payments, rules, now, (payee, kind) => decisions.get(decisionKey(payee, kind)) ?? null);

  const byPayee = new Map<string, ScanHit[]>();
  for (const hit of hits) {
    if (undecided.has(decisionKey(hit.payeeUserId, hit.kind))) {
      fraudMetrics.flags.add(1, { kind: hit.kind, outcome: "existing" });
      continue;
    }
    const list = byPayee.get(hit.payeeUserId);
    if (list) list.push(hit);
    else byPayee.set(hit.payeeUserId, [hit]);
  }

  const result: FraudScanResult = { flagged: 0, held: 0 };
  for (const [payee, list] of byPayee) {
    const r = await ctx.db.transaction(async (tx) => {
      let flagged = 0;
      let held = 0;
      for (const hit of list) {
        const raised = await raiseFraudFlag(tx, {
          payeeUserId: payee,
          kind: hit.kind,
          evidence: hit.evidence,
          raisedById: null,
          actorType: "system",
          at: now,
        });
        fraudMetrics.flags.add(1, { kind: hit.kind, outcome: raised ? "raised" : "race" });
        if (!raised) continue;
        flagged += 1;
        held += raised.held;
      }
      return { flagged, held };
    });
    result.flagged += r.flagged;
    result.held += r.held;
  }
  if (result.held > 0) fraudMetrics.held.add(result.held);
  // Counts only: who was flagged is in the audit log, not the log stream.
  if (result.flagged > 0 || hits.length > 0)
    ctx.logger.info("fraud scan", { payments: payments.length, hits: hits.length, ...result });
  return result;
}
