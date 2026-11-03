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
import { assertCents, compareUserIds, negate } from "./math.ts";
import { type PostResult, post } from "./poster.ts";
import { creatorBalances } from "./queries.ts";
import { InsufficientBalanceError, payoutCancel, payoutReserve, payoutSent, payoutTransferReversed } from "./rules.ts";
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

/**
 * Pure: who gets paid this period. Ordered by `compareUserIds`, the order `lockCreators` locks in,
 * so the batch takes its creator locks in the one documented order (ADR 0013 decision 4).
 */
export function computePayoutBatch(creators: readonly CreatorAvailable[], minimumCents: number): PayoutBatch {
  assertCents("minimum", minimumCents);
  const sorted = [...creators].sort((a, b) => compareUserIds(a.userId, b.userId));
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
 * Take the payout batch lock for a fraud change (raise, clear, release). `runPayoutBatch` reads the
 * held payees once under this lock, so a flag change that does not wait for it could clear a payee
 * the batch still treats as held and leave a fraud_review payout with no flag behind it.
 * Lock order: payout batch → flag → payouts.
 */
export async function lockFraudPayoutBatch(tx: Executor): Promise<void> {
  const { payoutRules } = await loadMoneySettings(tx);
  await lockPayoutBatch(tx, payoutRules.currency);
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
  await lockFraudPayoutBatch(tx);
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

/**
 * Whether the user was ever a crew recipient of a posted payment (a hold lot of theirs on a payment
 * someone else owns): decision (i) sends a crew member's first payout through `new_payee`.
 */
async function isCrewRecipient(tx: Executor, userId: string): Promise<boolean> {
  // Through the user's own hold accounts (owner and account indexes), never a scan of every payment.
  const rows = await tx.execute<{ crew: boolean }>(sql`
    select exists (
      select 1 from ledger_accounts a
      join ledger_entries e on e.account_id = a.id
      join ledger_transactions t on t.id = e.transaction_id
      where a.owner_user_id = ${userId} and a.code like 'liability:creator-hold:%'
        and t.kind = 'payment' and lower(t.metadata->>'creatorUserId') <> ${userId.toLowerCase()}
    ) as crew`);
  return rows[0]?.crew === true;
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
  /** Split shortfall the owner owes (ADR 0013 decision 6); netted after the receivable. */
  splitShortfallCents?: number;
}

const owed = (b: PayableBalances) => b.liabilityCents - b.receivableCents - (b.splitShortfallCents ?? 0);

/**
 * Creators' liability, receivable and split shortfall counting only postings dated at or before
 * `asOf`, in one statement. All creators in the currency, or just `userId`.
 */
async function payableAsOf(
  tx: Executor,
  currency: string,
  asOf: Date,
  userId?: string,
): Promise<Map<string, PayableBalances>> {
  const owner = userId
    ? sql`and a.code in (${storedCode(accounts.creator(userId), currency)}, ${storedCode(accounts.creatorReceivable(userId), currency)}, ${storedCode(accounts.splitShortfall(userId), currency)})`
    : sql`and (a.code like 'liability:creator:%' or a.code like 'asset:receivable:creator:%' or a.code like 'asset:receivable:split-shortfall:%')`;
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
    const cur = out.get(id) ?? { liabilityCents: 0, receivableCents: 0, splitShortfallCents: 0 };
    // Liability is credit-normal (owed = −raw); the receivables are debit-normal.
    if (code.startsWith("liability:")) cur.liabilityCents = negate(Number(b.total));
    else if (code.startsWith("asset:receivable:split-shortfall:")) cur.splitShortfallCents = Number(b.total);
    else cur.receivableCents = Number(b.total);
    out.set(id, cur);
  }
  return out;
}

/**
 * The lowest running available balance (liability − both receivables) of one creator at any posting
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
      where a.code in (${storedCode(accounts.creator(userId), currency)}, ${storedCode(accounts.creatorReceivable(userId), currency)}, ${storedCode(accounts.splitShortfall(userId), currency)})
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
): { amountCents: number; nettedCents: number; shortfallNettedCents: number; balances: PayableBalances } {
  const amountCents = Math.min(owed(atPeriodEnd), owed(now), lowestAfterCents ?? Number.POSITIVE_INFINITY);
  // Never net more than is owed now (a later netting may have settled part of it). The creator
  // receivable first, then split shortfall (ADR 0013 decision 6).
  const nettedCents = Math.max(0, Math.min(atPeriodEnd.receivableCents, now.receivableCents));
  const shortfallNettedCents = Math.max(
    0,
    Math.min(atPeriodEnd.splitShortfallCents ?? 0, now.splitShortfallCents ?? 0),
  );
  return {
    amountCents,
    nettedCents,
    shortfallNettedCents,
    balances: {
      liabilityCents: amountCents + nettedCents + shortfallNettedCents,
      receivableCents: nettedCents,
      splitShortfallCents: shortfallNettedCents,
    },
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
      [...atEnd].map(([userId, b]) => ({ userId, availableCents: owed(b) })),
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
      if (
        r.amountCents > now.availableCents ||
        r.amountCents + r.nettedCents + r.shortfallNettedCents > now.liabilityCents
      ) {
        throw new InsufficientBalanceError(
          `payout of ${r.amountCents} (+${r.nettedCents + r.shortfallNettedCents} netted) exceeds the available ${now.availableCents} cents`,
        );
      }
      const acct = accountsByUser.get(c.userId);
      // ADR 0036: a first payout this large raises `new_payee` before it is inserted, held.
      let raised: FlagRow | null = null;
      // Also for a payee another flag already holds: clearing that flag must not release this payout unreviewed.
      if (!(await hadPayout(tx, c.userId))) {
        // Decision (i): a crew recipient's first payout always gets the four-eyes check.
        const evidence = (await isCrewRecipient(tx, c.userId))
          ? { payoutCents: r.amountCents, splitRecipient: 1 }
          : newPayeeEvidence(r.amountCents);
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
    result.carriedOver.sort((a, b) => compareUserIds(a.userId, b.userId));
    return result;
  });
}

export class PayoutStateError extends Error {
  override name = "PayoutStateError";
}

const ReserveMeta = z.object({
  amountCents: z.number().int().positive(),
  receivableNettedCents: z.number().int(),
  splitShortfallNettedCents: z.number().int().default(0),
});

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
          splitShortfallNettedCents: meta.splitShortfallNettedCents,
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

// ── Stripe Connect transfers (batch 8, M1-connect; ADR 0007 Amendment 1, decision (f)) ─────────
//
// One transfer per Stripe payout row. The run moves ready Stripe payouts to `scheduled`
// (`schedulePayoutTransfers`); the worker opens a `pending` transfer row (`openPayoutTransfer`),
// calls Stripe outside any transaction, then records the answer: `created` posts `payoutSent` and
// marks the payout `paid` (`recordPayoutTransferCreated`); a definite refusal marks it `failed` and
// cancels the payout back to the payable through `payoutCancel` (`recordPayoutTransferFailed`); a
// reversal posts `payoutTransferReversed` for the increase (`recordPayoutTransferReversal`). Each
// writes its internal outbox event and a system audit row in the same transaction.
// Migration 0049 enforces the same machine; the transfer is always updated before its payout.
// Lock order: payout batch → payout row → transfer row → creator.

type TransferRow = typeof schema.payoutTransfers.$inferSelect;
const transfers = schema.payoutTransfers;

/** Opaque `payout_transfers.failure_code` values written here (never a provider message). */
export const PAYOUT_TRANSFER_CODES = {
  /** The payee's Stripe account cannot receive payouts (or is gone): cancelled, nothing sent. */
  accountNotReady: "account_not_ready",
  /** The payee is under fraud review (ADR 0036): cancelled, nothing sent. */
  held: "held",
  /** Retries ran out without an answer: Stripe may have created it. Still pending. */
  outcomeUnknown: "outcome_unknown",
  /** Stripe created it (`provider_ref` is set), but the payout was no longer scheduled. Still pending. */
  sentUnrecorded: "sent_unrecorded",
} as const;

/** BullMQ attempts of one `payout-transfers` job; the producer and the worker's last-attempt check share it. */
export const PAYOUT_TRANSFER_ATTEMPTS = 6;
/** Base of the exponential backoff between them (30 s … 8 min: about a quarter of an hour in all). */
export const PAYOUT_TRANSFER_BACKOFF_MS = 30_000;
/**
 * Stripe keeps an idempotency key for 24 hours. Past this age a transfer still `pending` with no
 * Stripe id is never sent again: a repeat could create a second transfer, so a person settles it.
 */
export const PAYOUT_TRANSFER_KEY_WINDOW_MS = 20 * 3_600_000;

/** The idempotency key of a payout's transfer (row and Stripe call): stable across retries. */
export const payoutTransferKey = (payoutId: string): string => `payout-transfer:${payoutId}`;

/**
 * Pure: how much of a transfer a reversal event adds. Stripe reports the cumulative reversed
 * amount; the increase over what is recorded is new, a total at or below it is a redelivery or an
 * older event (0), and a total above the transfer is capped at it.
 */
export function reversalDelta(recordedCents: number, reportedTotalCents: number, amountCents: number): number {
  assertCents("recorded", recordedCents);
  assertCents("reported", reportedTotalCents);
  assertCents("amount", amountCents, { allowZero: false });
  if (recordedCents > amountCents) throw new RangeError("the recorded reversal exceeds the transfer");
  return Math.max(0, Math.min(reportedTotalCents, amountCents) - recordedCents);
}

/** The rule `fraudFlagHolds`, in SQL against `payment_fraud_flags f` (for raw subqueries). */
const HOLDING_FLAG_SQL = sql.raw(
  `(f.status in ('open', 'reviewed') or (f.status = 'confirmed' and f.released_at is null))`,
);

/**
 * After a payout run (and on every later run): move each `pending` Stripe payout whose payee's
 * Stripe account can receive payouts and who is not under fraud review to `scheduled`, and return
 * every scheduled Stripe payout still without a settled transfer (none yet, or `pending`), oldest
 * first, for the caller to enqueue one `payout-transfers` job each after commit. A payout released
 * since an earlier run (onboarding finished, a fraud flag cleared) is picked up the same way.
 * Call it only when the instance's adapter can transfer: with the manual adapter nothing moves.
 */
export async function schedulePayoutTransfers(db: Executor): Promise<{ scheduled: number; payoutIds: string[] }> {
  return db.transaction(async (tx) => {
    // The batch lock, as runPayoutBatch and the account sync: neither sees a half-scheduled run.
    await lockFraudPayoutBatch(tx);
    const p = schema.payouts;
    // Explicit `payouts.` qualifiers: the subqueries have their own user_id columns.
    const moved = await tx
      .update(p)
      .set({ status: "scheduled" })
      .where(
        and(
          eq(p.provider, "stripe"),
          eq(p.status, "pending"),
          sql`exists (select 1 from payout_accounts a where a.user_id = payouts.user_id and a.provider = 'stripe'
                        and a.payouts_enabled and a.provider_account_id is not null)`,
          sql`not exists (select 1 from payment_fraud_flags f where f.payee_user_id = payouts.user_id and ${HOLDING_FLAG_SQL})`,
        ),
      )
      .returning({ id: p.id });
    const open = await tx.execute<{ id: string }>(sql`
      select p.id::text as id from payouts p
        left join payout_transfers t on t.payout_id = p.id
       where p.provider = 'stripe' and p.status = 'scheduled' and (t.id is null or t.status = 'pending')
       order by p.id`);
    return { scheduled: moved.length, payoutIds: open.map((r) => r.id) };
  });
}

export type OpenTransfer =
  | { transfer: TransferRow }
  /** No transfer and none may be opened: the payout is not a scheduled Stripe payout (any more). */
  | { transfer: null; reason: "not_scheduled" }
  /** A scheduled Stripe payout whose payee has no Stripe account to send to. */
  | { transfer: null; reason: "no_account" };

/**
 * The payout's transfer row: the existing one, or a new `pending` one (the run's key, the payee's
 * own Stripe account, the payout's amount and currency) while the payout is a scheduled Stripe
 * payout. Two jobs racing insert one row (the unique `payout_id`); the loser reads it back.
 */
export async function openPayoutTransfer(db: Executor, opts: { payoutId: string; at: Date }): Promise<OpenTransfer> {
  return db.transaction(async (tx) => {
    const { row } = await lockedPayout(tx, opts.payoutId);
    const [existing] = await tx.select().from(transfers).where(eq(transfers.payoutId, row.id));
    if (existing) return { transfer: existing };
    if (row.provider !== "stripe" || row.status !== "scheduled") return { transfer: null, reason: "not_scheduled" };
    const [acct] = await tx
      .select({ provider: schema.payoutAccounts.provider, ref: schema.payoutAccounts.providerAccountId })
      .from(schema.payoutAccounts)
      .where(eq(schema.payoutAccounts.userId, row.userId));
    if (acct?.provider !== "stripe" || !acct.ref) return { transfer: null, reason: "no_account" };
    const [inserted] = await tx
      .insert(transfers)
      .values({
        id: uuidv7(opts.at.getTime()),
        payoutId: row.id,
        provider: "stripe",
        destinationRef: acct.ref,
        amountCents: row.amountCents,
        currency: row.currency,
        idempotencyKey: payoutTransferKey(row.id),
      })
      .onConflictDoNothing({ target: transfers.payoutId })
      .returning();
    if (inserted) return { transfer: inserted };
    const [raced] = await tx.select().from(transfers).where(eq(transfers.payoutId, row.id));
    if (!raced) throw new PayoutStateError(`payout ${row.id}: its transfer vanished`);
    return { transfer: raced };
  });
}

/** Lock the payout (with the batch lock) and then its transfer, in the documented order. */
async function lockedTransfer(tx: Executor, transferId: string) {
  const [peek] = await tx.select({ payoutId: transfers.payoutId }).from(transfers).where(eq(transfers.id, transferId));
  if (!peek) throw new PayoutStateError(`payout transfer ${transferId} not found`);
  const { row } = await lockedPayout(tx, peek.payoutId);
  const [transfer] = await tx.select().from(transfers).where(eq(transfers.id, transferId)).for("update");
  if (!transfer) throw new PayoutStateError(`payout transfer ${transferId} not found`);
  return { payout: row, transfer };
}

type TransferEvent =
  | "money.payout_transfer.created"
  | "money.payout_transfer.failed"
  | "money.payout_transfer.reversed";

/** The internal outbox event and the system audit row of one transfer change (ids, cents, codes only). */
async function recordTransferChange(
  tx: Executor,
  t: TransferRow,
  payeeUserId: string,
  type: TransferEvent,
  extra: Record<string, string | number>,
  at: Date,
): Promise<void> {
  const def = EVENTS[type];
  const payload = def.payload.parse({
    transfer_id: t.id,
    payout_id: t.payoutId,
    payee_user_id: payeeUserId,
    ...extra,
  }) as Record<string, unknown>;
  await tx.insert(schema.events).values({
    id: uuidv7(at.getTime()),
    type,
    version: def.version,
    channelId: null,
    payload,
    occurredAt: at,
  });
  await tx.insert(schema.auditLog).values({
    id: uuidv7(at.getTime()),
    actorType: "system",
    actorId: null,
    action: type.slice("money.".length),
    subjectType: "payout_transfer",
    subjectId: t.id,
    reason: "",
    details: { payoutId: t.payoutId, payeeUserId, ...extra },
    createdAt: at,
  });
}

/**
 * Stripe created the transfer: the row becomes `created` with Stripe's id, then the payout is
 * posted (`payoutSent`, clearing → cash) and marked `paid`, in one transaction. A repeat with the
 * same id changes nothing (`created: false`); another id for the same row is refused.
 */
export async function recordPayoutTransferCreated(
  db: Executor,
  opts: { transferId: string; providerRef: string; at: Date },
): Promise<{ created: boolean; transfer: TransferRow }> {
  return db.transaction(async (tx) => {
    const { payout, transfer } = await lockedTransfer(tx, opts.transferId);
    if (transfer.providerRef !== null && transfer.providerRef !== opts.providerRef)
      throw new PayoutStateError(`payout transfer ${transfer.id} already has another provider reference`);
    if (transfer.status === "created" || transfer.status === "reversed") return { created: false, transfer };
    if (transfer.status !== "pending")
      throw new PayoutStateError(`payout transfer ${transfer.id} is ${transfer.status}`);
    if (payout.status !== "scheduled") throw new PayoutStateError(`payout ${payout.id} is ${payout.status}`);
    const [updated] = await tx
      .update(transfers)
      .set({ status: "created", providerRef: opts.providerRef, failureCode: null, updatedAt: opts.at })
      .where(eq(transfers.id, transfer.id))
      .returning();
    if (!updated) throw new PayoutStateError(`payout transfer ${transfer.id} not found`);
    // The transfer first, then the payout (0049): `paid` needs a created transfer.
    await postPayout(tx, { payoutId: payout.id, paidAt: opts.at, providerRef: opts.providerRef });
    await recordTransferChange(
      tx,
      updated,
      payout.userId,
      "money.payout_transfer.created",
      { amount_cents: updated.amountCents, currency: updated.currency },
      opts.at,
    );
    return { created: true, transfer: updated };
  });
}

/**
 * The transfer will not happen (a definite refusal, or the payee was not ready or is held): the row
 * becomes `failed` with its code, then the payout is cancelled through `payoutCancel`, so the amount
 * returns to the payee's payable for a later run. Refused once Stripe gave us an id (money may have
 * left). A repeat changes nothing (`failed: false`).
 */
export async function recordPayoutTransferFailed(
  db: Executor,
  opts: { transferId: string; failureCode: string; at: Date },
): Promise<{ failed: boolean; transfer: TransferRow }> {
  if (!/^[a-z0-9_]{1,64}$/.test(opts.failureCode)) throw new RangeError("a failure code is a short opaque code");
  return db.transaction(async (tx) => {
    const { payout, transfer } = await lockedTransfer(tx, opts.transferId);
    if (transfer.status === "failed") return { failed: false, transfer };
    if (transfer.status !== "pending")
      throw new PayoutStateError(`payout transfer ${transfer.id} is ${transfer.status}`);
    if (transfer.providerRef !== null)
      throw new PayoutStateError(`payout transfer ${transfer.id} reached Stripe; it is never cancelled`);
    const [updated] = await tx
      .update(transfers)
      .set({ status: "failed", failureCode: opts.failureCode, updatedAt: opts.at })
      .where(eq(transfers.id, transfer.id))
      .returning();
    if (!updated) throw new PayoutStateError(`payout transfer ${transfer.id} not found`);
    await cancelPayout(tx, { payoutId: payout.id, at: opts.at });
    await recordTransferChange(
      tx,
      updated,
      payout.userId,
      "money.payout_transfer.failed",
      { failure_code: opts.failureCode },
      opts.at,
    );
    return { failed: true, transfer: updated };
  });
}

/**
 * A pending transfer the worker could not settle: `outcome_unknown` (retries ran out), or
 * `sent_unrecorded` with Stripe's id (the payout left `scheduled` while Stripe created it). The row
 * stays `pending`, so nothing is cancelled and nothing is sent twice; the treasurer sees the code.
 * Audited once per change. Returns whether the row changed.
 */
export async function markPayoutTransferUnsettled(
  db: Executor,
  opts: {
    transferId: string;
    code: (typeof PAYOUT_TRANSFER_CODES)["outcomeUnknown" | "sentUnrecorded"];
    providerRef?: string;
    at: Date;
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const { payout, transfer } = await lockedTransfer(tx, opts.transferId);
    if (transfer.status !== "pending") return false;
    if (opts.providerRef && transfer.providerRef !== null && transfer.providerRef !== opts.providerRef)
      throw new PayoutStateError(`payout transfer ${transfer.id} already has another provider reference`);
    const providerRef = transfer.providerRef ?? opts.providerRef ?? null;
    if (transfer.failureCode === opts.code && transfer.providerRef === providerRef) return false;
    await tx
      .update(transfers)
      .set({ failureCode: opts.code, providerRef, updatedAt: opts.at })
      .where(eq(transfers.id, transfer.id));
    await tx.insert(schema.auditLog).values({
      id: uuidv7(opts.at.getTime()),
      actorType: "system",
      actorId: null,
      action: "payout_transfer.unsettled",
      subjectType: "payout_transfer",
      subjectId: transfer.id,
      reason: "",
      details: { payoutId: transfer.payoutId, payeeUserId: payout.userId, code: opts.code },
      createdAt: opts.at,
    });
    return true;
  });
}

/**
 * Stripe reversed part or all of a created transfer: post `payoutTransferReversed` for the increase
 * of the cumulative total over what is recorded (the payee's payable gets it back, so a later run
 * pays it), raise `reversed_cents`, and mark the transfer `reversed` once every cent is. A total at
 * or below the recorded one posts nothing (a redelivery; the cumulative key catches it too).
 */
export async function recordPayoutTransferReversal(
  db: Executor,
  opts: { transferId: string; reversedTotalCents: number; at: Date },
): Promise<{ postedCents: number; transfer: TransferRow }> {
  return db.transaction(async (tx) => {
    const { payout, transfer } = await lockedTransfer(tx, opts.transferId);
    if (transfer.status !== "created" && transfer.status !== "reversed")
      throw new PayoutStateError(
        `payout transfer ${transfer.id} is ${transfer.status}; only a created one is reversed`,
      );
    const delta = reversalDelta(transfer.reversedCents, opts.reversedTotalCents, transfer.amountCents);
    if (delta === 0) return { postedCents: 0, transfer };
    const total = transfer.reversedCents + delta;
    const [updated] = await tx
      .update(transfers)
      .set({
        reversedCents: total,
        status: total === transfer.amountCents ? "reversed" : transfer.status,
        updatedAt: opts.at,
      })
      .where(eq(transfers.id, transfer.id))
      .returning();
    if (!updated) throw new PayoutStateError(`payout transfer ${transfer.id} not found`);
    await lockCreator(tx, payout.userId);
    await post(
      tx,
      payoutTransferReversed({
        payoutId: payout.id,
        transferId: transfer.id,
        userId: payout.userId,
        amountCents: delta,
        cumulativeCents: total,
        currency: transfer.currency,
        occurredAt: opts.at,
      }),
    );
    await recordTransferChange(
      tx,
      updated,
      payout.userId,
      "money.payout_transfer.reversed",
      { amount_cents: delta, reversed_cents: total, currency: transfer.currency },
      opts.at,
    );
    return { postedCents: delta, transfer: updated };
  });
}

/**
 * Stripe says the payee's account cannot take transfers (it was deleted, or lost the capability):
 * mark it not ready, as `account.updated` does, so later runs hold their payouts until the payee
 * onboards again. Audited like the sync (`payout_account.set`, system). Returns whether it changed.
 */
export async function markStripeAccountNotReady(db: Executor, opts: { userId: string; at: Date }): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockFraudPayoutBatch(tx);
    const a = schema.payoutAccounts;
    const changed = await tx
      .update(a)
      .set({ payoutsEnabled: false, updatedAt: opts.at })
      .where(and(eq(a.userId, opts.userId), eq(a.provider, "stripe"), eq(a.payoutsEnabled, true)))
      .returning({ userId: a.userId });
    if (changed.length === 0) return false;
    await tx.insert(schema.auditLog).values({
      id: uuidv7(opts.at.getTime()),
      actorType: "system",
      actorId: null,
      action: "payout_account.set",
      subjectType: "user",
      subjectId: opts.userId,
      reason: "",
      details: { provider: "stripe", payoutsEnabled: false, payoutsReleased: 0 },
      createdAt: opts.at,
    });
    return true;
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A transfer by Stripe's id, or else by our row id from its metadata (a reversal may beat the `created` update). */
export async function findPayoutTransfer(
  db: Executor,
  ref: { providerRef: string; transferId: string | null },
): Promise<TransferRow | null> {
  const [byRef] = await db
    .select()
    .from(transfers)
    .where(and(eq(transfers.provider, "stripe"), eq(transfers.providerRef, ref.providerRef)));
  if (byRef) return byRef;
  if (!ref.transferId || !UUID.test(ref.transferId)) return null;
  const [byId] = await db.select().from(transfers).where(eq(transfers.id, ref.transferId));
  return byId ?? null;
}
