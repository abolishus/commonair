// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The fraud scan's SQL inputs: ids, cents and times only (no names, no messages, no addresses).
 * Channel payments only (subscriptions, gifts, tips); member shares pay the co-op, not a payee.
 */
import { sql } from "drizzle-orm";
import type { Executor } from "@commonair/db";
import type { FraudPayment, ScanKind } from "./signals.ts";

const toDate = (v: string | Date): Date => (v instanceof Date ? v : new Date(v));

/**
 * Succeeded channel payments in [since, until), net of refunds. Fully refunded and charged-back
 * payments are left out; a partially refunded one counts what stayed paid.
 */
export async function readFraudPayments(db: Executor, opts: { since: Date; until: Date }): Promise<FraudPayment[]> {
  const rows = await db.execute<{
    id: string;
    payer: string | null;
    payee: string;
    cents: string;
    at: string | Date;
    payer_created: string | Date | null;
  }>(sql`
    select p.id, p.user_id as payer, c.owner_id as payee,
           (p.amount_cents - p.refunded_cents)::text as cents,
           p.succeeded_at as at, u.created_at as payer_created
    from payments p
    join channels c on c.id = p.channel_id
    left join users u on u.id = p.user_id
    where p.kind in ('subscription', 'tip')
      and p.status in ('succeeded', 'partially_refunded')
      and p.succeeded_at is not null
      and p.succeeded_at >= ${opts.since.toISOString()}::timestamptz
      and p.succeeded_at < ${opts.until.toISOString()}::timestamptz
      and p.amount_cents > p.refunded_cents
    order by p.succeeded_at, p.id`);
  return rows.map((r) => ({
    paymentId: r.id,
    payerUserId: r.payer,
    payeeUserId: r.payee,
    amountCents: Number(r.cents),
    succeededAt: toDate(r.at),
    payerCreatedAt: r.payer_created === null ? null : toDate(r.payer_created),
  }));
}

/** The latest decision time per (payee, kind) for the scan's kinds, keyed `${payee}:${kind}`. */
export async function latestFraudDecisions(db: Executor): Promise<Map<string, Date>> {
  const rows = await db.execute<{ payee: string; kind: ScanKind; at: string | Date }>(sql`
    select payee_user_id as payee, kind::text as kind, max(decided_at) as at
    from payment_fraud_flags
    where status in ('cleared', 'confirmed') and kind in ('payer_velocity', 'payer_concentration')
    group by payee_user_id, kind`);
  return new Map(rows.map((r) => [decisionKey(r.payee, r.kind), toDate(r.at)]));
}

/** Payees that already have an undecided flag of the kind (the scan skips them), keyed as above. */
export async function undecidedFraudFlags(db: Executor): Promise<Set<string>> {
  const rows = await db.execute<{ payee: string; kind: ScanKind }>(sql`
    select payee_user_id as payee, kind::text as kind
    from payment_fraud_flags
    where status in ('open', 'reviewed') and kind in ('payer_velocity', 'payer_concentration')`);
  return new Set(rows.map((r) => decisionKey(r.payee, r.kind)));
}

export const decisionKey = (payeeUserId: string, kind: ScanKind) => `${payeeUserId}:${kind}`;
