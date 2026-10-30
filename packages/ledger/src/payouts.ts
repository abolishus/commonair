// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Payout batch and lifecycle. The batch reserves each payout in the ledger (creator liability
 * → payout clearing) in the same transaction that writes the `payouts` row, so the reserved
 * money is no longer "available" to anything else: a later batch cannot pay it twice, and a
 * later chargeback cannot draw on it. Sending moves clearing → cash and is never refused
 * for balance reasons; a failed payout cancels the reservation.
 *
 * The payment fraud floor (ADR 0036) hooks in here: a payee with a holding fraud flag gets every
 * payout created `held` / `fraud_review`, a first large payout raises a `new_payee` flag, and
 * sending refuses a held payee. The same rule is enforced by `payouts_fraud_guard` (migration
 * 0038); these checks only give clearer errors and keep batches from tripping it.
 */
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  FRAUD_REVIEW_HOLD,
  PAYMENT_FRAUD_RULES,
  type ACTOR_TYPES,
  type PAYMENT_FRAUD_KINDS,
} from "@commonair/contracts/enums";
import { EVENTS } from "@commonair/contracts/events";
import { type Executor, schema, uuidv7 } from "@commonair/db";
import { accounts, assertCurrency, parseStoredCode, storedCode } from "./accounts.ts";
import { lockCreator, lockPayoutBatch } from "./locks.ts";
import { assertCents, negate } from "./math.ts";
import { type PostResult, post } from "./poster.ts";
import { creatorBalances } from "./queries.ts";
import { InsufficientBalanceError, payoutCancel, payoutReserve, payoutSent } from "./rules.ts";
import { loadMoneySettings } from "./settings.ts";

export interface CreatorAvailable {
  userId: string;
  availableCents: number;
}

export interface PayoutBatch {
  payouts: { userId: string; amountCents: number }[];
  /** Below the minimum (or nothing available): carried to the next period. */
  carriedOver: CreatorAvailable[];
}

/** Pure: who gets paid this period. Ordered by user id for determinism. */
export function computePayoutBatch(creators: readonly CreatorAvailable[], minimumCents: number): PayoutBatch {
  assertCents("minimum", minimumCents);
  const sorted = [...creators].sort((a, b) => a.userId.localeCompare(b.userId));
  const batch: PayoutBatch = { payouts: [], carriedOver: [] };
  for (const c of sorted) {
    if (c.availableCents > 0 && c.availableCents >= minimumCents) {
      batch.payouts.push({ userId: c.userId, amountCents: c.availableCents });
    } else {
      batch.carriedOver.push(c);
    }
  }
  return batch;
}

export interface PayoutRunResult {
  /** Rows created as `pending` (payout account ready). */
  created: number;
  /** Rows created as `held` (payout account missing or not enabled, or a fraud hold); the money is reserved. */
  held: number;
  totalCents: number;
  carriedOver: CreatorAvailable[];
}

export const PAYOUT_ACCOUNT_NOT_READY = "payout_account_not_ready";

// ── Fraud floor (ADR 0036) ────────────────────────────────────────────────────────────────────

export { FRAUD_REVIEW_HOLD };
export type PaymentFraudKind = (typeof PAYMENT_FRAUD_KINDS)[number];
type FlagRow = typeof schema.paymentFraudFlags.$inferSelect;
const flags = schema.paymentFraudFlags;

/**
 * The one release-eligibility rule (the same as `payouts_fraud_guard`): a flag holds the payee's
 * payouts while it is open or reviewed, or confirmed and not yet released by an admin. A cleared
 * flag, or a released confirmed one, holds nothing.
 */
export function fraudFlagHolds(f: { status: string; releasedAt: Date | null }): boolean {
  return f.status === "open" || f.status === "reviewed" || (f.status === "confirmed" && f.releasedAt === null);
}

/** `fraudFlagHolds` as a SQL condition on `payment_fraud_flags`. */
export const fraudFlagHoldsSql = (): SQL =>
  or(inArray(flags.status, ["open", "reviewed"]), and(eq(flags.status, "confirmed"), isNull(flags.releasedAt))) ??
  sql`false`;

/** Whether the payee has a holding flag (other than `exceptFlagId`). */
export async function payeeHasHoldingFlag(tx: Executor, payeeUserId: string, exceptFlagId?: string): Promise<boolean> {
  const rows = await tx
    .select({ id: flags.id })
    .from(flags)
    .where(
      and(
        eq(flags.payeeUserId, payeeUserId),
        fraudFlagHoldsSql(),
        exceptFlagId ? sql`${flags.id} <> ${exceptFlagId}` : undefined,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Payees with a holding flag. */
async function holdingPayees(tx: Executor): Promise<Set<string>> {
  const rows = await tx.selectDistinct({ id: flags.payeeUserId }).from(flags).where(fraudFlagHoldsSql());
  return new Set(rows.map((r) => r.id));
}

/** How many of the payee's payouts are held for fraud review now. */
export async function fraudHeldPayouts(tx: Executor, payeeUserId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.payouts)
    .where(
      and(
        eq(schema.payouts.userId, payeeUserId),
        eq(schema.payouts.status, "held"),
        eq(schema.payouts.holdReason, FRAUD_REVIEW_HOLD),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Move the payee's `pending`/`scheduled` payouts, and its `held` / `payout_account_not_ready` ones,
 * to `held` / `fraud_review`. The re-tag keeps the account-ready release paths (which release only
 * `payout_account_not_ready`) from hitting `payouts_fraud_guard`. `paid` and `failed` stay as they
 * are. Returns how many moved.
 */
export async function holdPayoutsForFraud(tx: Executor, payeeUserId: string): Promise<number> {
  const p = schema.payouts;
  const moved = await tx
    .update(p)
    .set({ status: "held", holdReason: FRAUD_REVIEW_HOLD })
    .where(
      and(
        eq(p.userId, payeeUserId),
        or(
          inArray(p.status, ["pending", "scheduled"]),
          and(eq(p.status, "held"), eq(p.holdReason, PAYOUT_ACCOUNT_NOT_READY)),
        ),
      ),
    )
    .returning({ id: p.id });
  return moved.length;
}

/**
 * After a clear or a release: when the payee has no holding flag left, move their `fraud_review`
 * payouts to `pending`, or to `held` / `payout_account_not_ready` when their payout account is not
 * ready. Call it after the flag update in the same transaction (the trigger reads the new status).
 * Returns how many payouts became `pending` and how many stayed held for the account.
 */
export async function releaseFraudHolds(
  tx: Executor,
  payeeUserId: string,
): Promise<{ released: number; accountNotReady: number }> {
  if (await payeeHasHoldingFlag(tx, payeeUserId)) return { released: 0, accountNotReady: 0 };
  const [acct] = await tx
    .select({ enabled: schema.payoutAccounts.payoutsEnabled })
    .from(schema.payoutAccounts)
    .where(eq(schema.payoutAccounts.userId, payeeUserId));
  const ready = acct?.enabled === true;
  const p = schema.payouts;
  const moved = await tx
    .update(p)
    .set(ready ? { status: "pending", holdReason: null } : { status: "held", holdReason: PAYOUT_ACCOUNT_NOT_READY })
    .where(and(eq(p.userId, payeeUserId), eq(p.status, "held"), eq(p.holdReason, FRAUD_REVIEW_HOLD)))
    .returning({ id: p.id });
  return ready ? { released: moved.length, accountNotReady: 0 } : { released: 0, accountNotReady: moved.length };
}

export interface NewFraudFlag {
  payeeUserId: string;
  kind: PaymentFraudKind;
  /** Ids, counts and cents only (ADR 0036 decision 5). */
  evidence: Record<string, string | number>;
  /** Null when the scan or the batch raised it. */
  raisedById: string | null;
  note?: string;
  at: Date;
}

/**
 * Insert an open flag; null when an undecided flag of that kind already exists for the payee (the
 * partial unique index). `raised_at` is stamped from `at` (millisecond precision, so the list's
 * keyset cursor round-trips exactly).
 */
export async function insertFraudFlag(tx: Executor, f: NewFraudFlag): Promise<FlagRow | null> {
  const [row] = await tx
    .insert(flags)
    .values({
      id: uuidv7(f.at.getTime()),
      payeeUserId: f.payeeUserId,
      kind: f.kind,
      evidence: f.evidence,
      raisedById: f.raisedById,
      raisedAt: f.at,
      note: f.note ?? "",
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

export type FraudAction = "money.fraud.raise" | "money.fraud.review" | "money.fraud.decide" | "money.fraud.release";

/**
 * The audit row and the internal `money.fraud.flag` outbox row for one change to a flag, in the
 * caller's transaction. Details and payload are ids and enums only: the treasurers' note is never
 * copied (ADR 0036 decision 5).
 */
export async function recordFraudFlag(
  tx: Executor,
  r: {
    flag: Pick<FlagRow, "id" | "payeeUserId" | "kind" | "status" | "releasedAt">;
    action: FraudAction;
    actorType: (typeof ACTOR_TYPES)[number];
    actorId: string | null;
    at: Date;
  },
): Promise<{ heldPayouts: number }> {
  const heldPayouts = await fraudHeldPayouts(tx, r.flag.payeeUserId);
  const [channel] = await tx
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(eq(schema.channels.ownerId, r.flag.payeeUserId))
    .limit(1);
  const channelId = channel?.id ?? null;
  const def = EVENTS["money.fraud.flag"];
  const payload = def.payload.parse({
    flag_id: r.flag.id,
    payee_user_id: r.flag.payeeUserId,
    kind: r.flag.kind,
    status: r.flag.status,
    released: r.flag.releasedAt !== null,
    held_payouts: heldPayouts,
  }) as Record<string, unknown>;
  await tx.insert(schema.events).values({
    id: uuidv7(r.at.getTime()),
    type: "money.fraud.flag",
    version: def.version,
    channelId,
    payload,
    occurredAt: r.at,
  });
  await tx.insert(schema.auditLog).values({
    id: uuidv7(r.at.getTime()),
    actorType: r.actorType,
    actorId: r.actorId,
    action: r.action,
    subjectType: "payment_fraud_flag",
    subjectId: r.flag.id,
    channelId,
    reason: "",
    details: { flagId: r.flag.id, kind: r.flag.kind, status: r.flag.status },
    createdAt: r.at,
  });
  return { heldPayouts };
}

/**
 * Raise a flag and hold the payee's payouts, with its audit and outbox rows, in the caller's
 * transaction (the scan and `raise`). Takes the payout batch lock first (lock order: payout batch
 * → payment → creator), so a batch running now cannot create a `pending` payout after the re-tag.
 * Null when an undecided flag of that kind already holds the payee.
 */
export async function raiseFraudFlag(
  tx: Executor,
  f: NewFraudFlag & { actorType: (typeof ACTOR_TYPES)[number] },
): Promise<{ flag: FlagRow; held: number; heldPayouts: number } | null> {
  const { payoutRules } = await loadMoneySettings(tx);
  await lockPayoutBatch(tx, payoutRules.currency);
  const flag = await insertFraudFlag(tx, f);
  if (!flag) return null;
  const held = await holdPayoutsForFraud(tx, f.payeeUserId);
  const { heldPayouts } = await recordFraudFlag(tx, {
    flag,
    action: "money.fraud.raise",
    actorType: f.actorType,
    actorId: f.raisedById,
    at: f.at,
  });
  return { flag, held, heldPayouts };
}

/** `new_payee` (ADR 0036 decision 1): the first payout ever at or above the threshold; evidence `{ payoutCents }`. */
export function newPayeeEvidence(
  firstPayoutCents: number,
  rules: { newPayeeFirstPayoutCents: number } = PAYMENT_FRAUD_RULES,
): { payoutCents: number } | null {
  return firstPayoutCents >= rules.newPayeeFirstPayoutCents ? { payoutCents: firstPayoutCents } : null;
}

/** Whether the creator ever had a payout (any status): `new_payee` judges only the first. */
async function hadPayout(tx: Executor, userId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: schema.payouts.id })
    .from(schema.payouts)
    .where(eq(schema.payouts.userId, userId))
    .orderBy(desc(schema.payouts.periodStart))
    .limit(1);
  return rows.length > 0;
}

export interface PayableBalances {
  /** Released earnings not yet reserved (natural terms: owed). */
  liabilityCents: number;
  /** Clawback shortfall the creator owes. */
  receivableCents: number;
}

/**
 * Creators' liability and receivable counting only postings dated at or before `asOf`, in one
 * statement. All creators in the currency, or just `userId`.
 */
async function payableAsOf(
  tx: Executor,
  currency: string,
  asOf: Date,
  userId?: string,
): Promise<Map<string, PayableBalances>> {
  const owner = userId
    ? sql`and a.code in (${storedCode(accounts.creator(userId), currency)}, ${storedCode(accounts.creatorReceivable(userId), currency)})`
    : sql`and (a.code like 'liability:creator:%' or a.code like 'asset:receivable:creator:%')`;
  const rows = await tx.execute<{ code: string; total: string }>(sql`
    select a.code,
           coalesce(sum(e.amount_cents) filter (where t.occurred_at <= ${asOf.toISOString()}::timestamptz), 0)::text as total
    from ledger_accounts a
    left join ledger_entries e on e.account_id = a.id
    left join ledger_transactions t on t.id = e.transaction_id
    where a.currency = ${currency} ${owner}
    group by a.code`);
  const out = new Map<string, PayableBalances>();
  for (const b of rows) {
    const code = parseStoredCode(b.code).code;
    const id = code.slice(code.lastIndexOf(":") + 1);
    const cur = out.get(id) ?? { liabilityCents: 0, receivableCents: 0 };
    // Liability is credit-normal (owed = −raw); the receivable is debit-normal.
    if (code.startsWith("liability:")) cur.liabilityCents = negate(Number(b.total));
    else cur.receivableCents = Number(b.total);
    out.set(id, cur);
  }
  return out;
}

/**
 * The lowest running available balance (liability − receivable) of one creator at any posting
 * date after `asOf`, counting every posting whatever its date (later reservations, cancels,
 * reversals, releases, and anything dated in the future); null when nothing is dated after it.
 * Postings sharing a timestamp count together.
 */
async function lowestAvailableAfter(
  tx: Executor,
  userId: string,
  currency: string,
  asOf: Date,
): Promise<number | null> {
  const rows = await tx.execute<{ lowest: string | null }>(sql`
    with d as (
      select t.occurred_at as at, -sum(e.amount_cents) as delta
      from ledger_entries e
      join ledger_accounts a on a.id = e.account_id
      join ledger_transactions t on t.id = e.transaction_id
      where a.code in (${storedCode(accounts.creator(userId), currency)}, ${storedCode(accounts.creatorReceivable(userId), currency)})
      group by t.occurred_at
    ), r as (
      select at, sum(delta) over (order by at) as running from d
    )
    select min(running)::text as lowest from r where at > ${asOf.toISOString()}::timestamptz`);
  const v = rows[0]?.lowest;
  return v === null || v === undefined ? null : Number(v);
}

/**
 * What a payout for the period ending at `periodEnd` may reserve: the available balance as of
 * `periodEnd`, capped by what is available now and by the lowest running available balance at
 * any posting date after `periodEnd` (`lowestAfterCents`). The reservation is dated
 * `periodEnd`, so it lowers every later running balance too; the cap keeps all of them from
 * going below zero (a later reversal, or a later period's reservation, may already have drawn
 * on the money). Only the receivable owed by `periodEnd` is netted. Returns the balances to
 * hand `payoutReserve`, shaped so that it reserves exactly `amountCents` and nets exactly
 * `nettedCents`.
 */
export function reservableAt(
  atPeriodEnd: PayableBalances,
  now: PayableBalances,
  lowestAfterCents: number | null = null,
): { amountCents: number; nettedCents: number; balances: PayableBalances } {
  const amountCents = Math.min(
    atPeriodEnd.liabilityCents - atPeriodEnd.receivableCents,
    now.liabilityCents - now.receivableCents,
    lowestAfterCents ?? Number.POSITIVE_INFINITY,
  );
  // Never net more than is owed now (a later netting may have settled part of it).
  const nettedCents = Math.max(0, Math.min(atPeriodEnd.receivableCents, now.receivableCents));
  return {
    amountCents,
    nettedCents,
    balances: { liabilityCents: amountCents + nettedCents, receivableCents: nettedCents },
  };
}

/**
 * Compute the payout batch for the period: every creator whose available balance at
 * `periodEnd` reaches the minimum gets a `payouts` row and a ledger reservation of that amount,
 * atomically, dated `periodEnd`. Only postings dated at or before `periodEnd` count, so holds
 * released (or clawbacks owed) after it fall into the next period's run and the period's
 * statement never shows more paid out than was available at its end. Nor more than stayed
 * available at every posting date since (see `reservableAt`), so a late run never drives a
 * creator's running balance below zero at any date. Idempotent per
 * (user, periodStart). Each creator's balance is re-read under the creator lock right before
 * reserving, so concurrent reversals and releases are accounted for.
 */
export async function runPayoutBatch(
  db: Executor,
  opts: { periodStart: Date; periodEnd: Date; currency: string; minimumCents: number },
): Promise<PayoutRunResult> {
  assertCurrency(opts.currency);
  assertCents("minimum", opts.minimumCents);
  if (!(opts.periodStart < opts.periodEnd)) throw new RangeError("periodStart must be before periodEnd");
  return db.transaction(async (tx) => {
    await lockPayoutBatch(tx, opts.currency);
    const atEnd = await payableAsOf(tx, opts.currency, opts.periodEnd);
    const candidates = computePayoutBatch(
      [...atEnd].map(([userId, b]) => ({ userId, availableCents: b.liabilityCents - b.receivableCents })),
      opts.minimumCents,
    );
    const already = new Set(
      (
        await tx
          .select({ userId: schema.payouts.userId })
          .from(schema.payouts)
          .where(eq(schema.payouts.periodStart, opts.periodStart))
      ).map((r) => r.userId),
    );
    const accountsByUser = new Map(
      (
        await tx
          .select({
            userId: schema.payoutAccounts.userId,
            provider: schema.payoutAccounts.provider,
            enabled: schema.payoutAccounts.payoutsEnabled,
          })
          .from(schema.payoutAccounts)
      ).map((a) => [a.userId, a]),
    );

    const fraudHeld = await holdingPayees(tx);
    const flaggedAt = new Date();

    const result: PayoutRunResult = { created: 0, held: 0, totalCents: 0, carriedOver: candidates.carriedOver };
    for (const c of candidates.payouts) {
      if (already.has(c.userId)) continue;
      await lockCreator(tx, c.userId);
      const then = (await payableAsOf(tx, opts.currency, opts.periodEnd, c.userId)).get(c.userId);
      const now = await creatorBalances(tx, c.userId, opts.currency);
      const lowest = await lowestAvailableAfter(tx, c.userId, opts.currency, opts.periodEnd);
      const r = then ? reservableAt(then, now, lowest) : null;
      if (!r || r.amountCents <= 0 || r.amountCents < opts.minimumCents) {
        result.carriedOver.push({ userId: c.userId, availableCents: r?.amountCents ?? 0 });
        continue;
      }
      // payoutReserve checks only the shaped balances; check against today's real ones too.
      if (r.amountCents > now.availableCents || r.amountCents + r.nettedCents > now.liabilityCents) {
        throw new InsufficientBalanceError(
          `payout of ${r.amountCents} (+${r.nettedCents} netted) exceeds the available ${now.availableCents} cents`,
        );
      }
      const acct = accountsByUser.get(c.userId);
      // ADR 0036: a first payout this large raises `new_payee` before it is inserted, held.
      let raised: FlagRow | null = null;
      if (!fraudHeld.has(c.userId) && !(await hadPayout(tx, c.userId))) {
        const evidence = newPayeeEvidence(r.amountCents);
        if (evidence) {
          raised = await insertFraudFlag(tx, {
            payeeUserId: c.userId,
            kind: "new_payee",
            evidence,
            raisedById: null,
            at: flaggedAt,
          });
          fraudHeld.add(c.userId);
        }
      }
      // Fraud wins over account readiness: the hold is lifted by people, not by the account.
      const fraud = fraudHeld.has(c.userId);
      const ready = !fraud && acct?.enabled === true;
      const [row] = await tx
        .insert(schema.payouts)
        .values({
          userId: c.userId,
          periodStart: opts.periodStart,
          periodEnd: opts.periodEnd,
          amountCents: r.amountCents,
          currency: opts.currency,
          status: ready ? "pending" : "held",
          provider: acct?.provider ?? "manual",
          holdReason: ready ? null : fraud ? FRAUD_REVIEW_HOLD : PAYOUT_ACCOUNT_NOT_READY,
        })
        .onConflictDoNothing({ target: [schema.payouts.userId, schema.payouts.periodStart] })
        .returning({ id: schema.payouts.id });
      if (raised) {
        // `runPayoutBatch`'s caller audits only `payout.run`: the flag's own rows are written here.
        await recordFraudFlag(tx, {
          flag: raised,
          action: "money.fraud.raise",
          actorType: "system",
          actorId: null,
          at: flaggedAt,
        });
      }
      if (!row) continue;
      await post(
        tx,
        payoutReserve({
          payoutId: row.id,
          userId: c.userId,
          amountCents: r.amountCents,
          currency: opts.currency,
          occurredAt: opts.periodEnd,
          balances: r.balances,
          minimumCents: opts.minimumCents,
        }),
      );
      if (ready) result.created += 1;
      else result.held += 1;
      result.totalCents += r.amountCents;
    }
    result.carriedOver.sort((a, b) => a.userId.localeCompare(b.userId));
    return result;
  });
}

export class PayoutStateError extends Error {
  override name = "PayoutStateError";
}

const ReserveMeta = z.object({ amountCents: z.number().int().positive(), receivableNettedCents: z.number().int() });

async function lockedPayout(tx: Executor, payoutId: string) {
  const [peek] = await tx
    .select({ currency: schema.payouts.currency })
    .from(schema.payouts)
    .where(eq(schema.payouts.id, payoutId));
  if (!peek) throw new PayoutStateError(`payout ${payoutId} not found`);
  await lockPayoutBatch(tx, peek.currency);
  const [row] = await tx.select().from(schema.payouts).where(eq(schema.payouts.id, payoutId)).for("update");
  if (!row) throw new PayoutStateError(`payout ${payoutId} not found`);
  const [reservation] = await tx
    .select({ id: schema.ledgerTransactions.id, metadata: schema.ledgerTransactions.metadata })
    .from(schema.ledgerTransactions)
    .where(eq(schema.ledgerTransactions.idempotencyKey, `payout-reserve:${payoutId}`));
  return { row, reservation };
}

/**
 * Record that a payout was sent: post clearing → cash and mark the row paid. Never refused
 * for balance reasons (the money has left). Idempotent.
 */
export async function postPayout(
  db: Executor,
  opts: { payoutId: string; paidAt: Date; providerRef?: string | null },
): Promise<PostResult> {
  return db.transaction(async (tx) => {
    const { row, reservation } = await lockedPayout(tx, opts.payoutId);
    if (row.ledgerTransactionId) return { transactionId: row.ledgerTransactionId, created: false };
    if (row.status !== "pending" && row.status !== "scheduled") {
      throw new PayoutStateError(`payout ${row.id} is ${row.status}`);
    }
    if (!reservation) throw new PayoutStateError(`payout ${row.id} was never reserved in the ledger`);
    // ADR 0036: refused before `payouts_fraud_guard` would, with an error the caller can map.
    if (await payeeHasHoldingFlag(tx, row.userId)) {
      throw new PayoutStateError(`payout ${row.id} is held: its payee is under fraud review`);
    }
    const r = await post(
      tx,
      payoutSent({
        payoutId: row.id,
        userId: row.userId,
        provider: row.provider,
        amountCents: row.amountCents,
        currency: row.currency,
        occurredAt: opts.paidAt,
      }),
    );
    await tx
      .update(schema.payouts)
      .set({
        status: "paid",
        paidAt: opts.paidAt,
        providerRef: opts.providerRef ?? row.providerRef,
        ledgerTransactionId: r.transactionId,
      })
      .where(and(eq(schema.payouts.id, row.id), isNull(schema.payouts.ledgerTransactionId)));
    return r;
  });
}

/**
 * A payout failed (or was cancelled) before money left: release the reservation back to the
 * creator's earnings (restoring any netted receivable) and mark the row failed. Idempotent.
 */
export async function cancelPayout(
  db: Executor,
  opts: { payoutId: string; at: Date; reason?: string },
): Promise<PostResult | null> {
  return db.transaction(async (tx) => {
    const { row, reservation } = await lockedPayout(tx, opts.payoutId);
    if (row.status === "paid" || row.ledgerTransactionId) throw new PayoutStateError(`payout ${row.id} was paid`);
    let result: PostResult | null = null;
    if (reservation) {
      const meta = ReserveMeta.parse(reservation.metadata);
      await lockCreator(tx, row.userId);
      result = await post(
        tx,
        payoutCancel({
          payoutId: row.id,
          userId: row.userId,
          amountCents: meta.amountCents,
          receivableNettedCents: meta.receivableNettedCents,
          currency: row.currency,
          occurredAt: opts.at,
        }),
      );
    }
    if (row.status !== "failed") {
      await tx
        .update(schema.payouts)
        .set({ status: "failed", holdReason: opts.reason ?? row.holdReason })
        .where(eq(schema.payouts.id, row.id));
    }
    return result;
  });
}
