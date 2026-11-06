// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stripe Connect transfers on the API side (batch 8, M1-connect; ADR 0007 Amendment 1):
 *
 * - `startPayoutTransfers`, called by `money.treasurer.runPayouts` after its transaction commits:
 *   with an adapter that can transfer, it moves ready Stripe payouts to `scheduled` and enqueues one
 *   `payout-transfers` job per payout still without a settled transfer (`payoutTransferJobId`, so a
 *   repeated run never queues one payout twice). The worker does the rest (`money/transfers.ts`).
 *   With the manual adapter it does nothing: nothing moves.
 * - `money.treasurer.transfers`: the transfers by payout run (the payouts' period start), newest
 *   first, with status, amounts, reversed cents and the opaque failure code.
 */
import { Queue } from "bullmq";
import { and, desc, eq, lt } from "drizzle-orm";
import { Valkey } from "iovalkey";
import { B8_JOBS, QUEUES, payoutTransferJobId, type PayoutTransferJob } from "@commonair/contracts/internal";
import { type Executor, schema } from "@commonair/db";
import { PAYOUT_TRANSFER_ATTEMPTS, PAYOUT_TRANSFER_BACKOFF_MS, schedulePayoutTransfers } from "@commonair/ledger";
import { createAdapter } from "@commonair/payments";
import { valkeyTls } from "@commonair/service";
import type { Deps } from "../deps.ts";
import { decodeCursor, encodeCursor, pageOf } from "../lib/cursor.ts";
import { os } from "../lib/orpc.ts";
import { isIdCursor } from "./reports-lib.ts";

const { payoutTransfers, payouts, users } = schema;

// ── The producer ─────────────────────────────────────────────────────────────────────────────

export interface PayoutTransferQueue {
  enqueue(payoutIds: readonly string[]): Promise<void>;
  close(): Promise<void>;
}

export function createPayoutTransferQueue(valkeyUrl: string, prefix: string): PayoutTransferQueue {
  // BullMQ refuses ioredis key prefixes and needs maxRetriesPerRequest: null.
  const conn = new Valkey(valkeyUrl, {
    ...valkeyTls(valkeyUrl),
    maxRetriesPerRequest: null,
    connectionName: "api-payout-transfers-queue",
  });
  const queue = new Queue(QUEUES.payments, { connection: conn, prefix });
  return {
    async enqueue(payoutIds) {
      if (payoutIds.length === 0) return;
      await queue.addBulk(
        payoutIds.map((payoutId) => {
          const data: PayoutTransferJob = { payoutId };
          return {
            name: B8_JOBS.payoutTransfers,
            data,
            opts: {
              jobId: payoutTransferJobId(payoutId),
              attempts: PAYOUT_TRANSFER_ATTEMPTS,
              backoff: { type: "exponential", delay: PAYOUT_TRANSFER_BACKOFF_MS },
              // Removed once finished: a later run may queue the same payout again (a transfer left
              // pending), and BullMQ ignores an id it still holds. The row is the record, not the job.
              removeOnComplete: true,
              removeOnFail: true,
            },
          };
        }),
      );
    },
    async close() {
      await queue.close();
      conn.disconnect();
    },
  };
}

const queues = new WeakMap<Deps, PayoutTransferQueue>();

/** One producer per deps, created on first use; tests may install their own. */
export function payoutTransferQueue(deps: Deps): PayoutTransferQueue {
  let q = queues.get(deps);
  if (!q) {
    q = createPayoutTransferQueue(deps.env.VALKEY_URL, deps.env.WORKER_BULL_PREFIX);
    queues.set(deps, q);
  }
  return q;
}

export function setPayoutTransferQueue(deps: Deps, q: PayoutTransferQueue): void {
  queues.set(deps, q);
}

export async function closePayoutTransferQueue(deps: Deps): Promise<void> {
  const q = queues.get(deps);
  queues.delete(deps);
  await q?.close();
}

/**
 * After a payout run commits: schedule the ready Stripe payouts and queue their transfers. Never
 * throws (the run stands either way): a failure is logged, and the next run picks the same payouts
 * up again, because they stay `scheduled` with no settled transfer.
 */
export async function startPayoutTransfers(deps: Deps): Promise<{ scheduled: number; enqueued: number }> {
  try {
    const adapter = createAdapter(deps.env);
    if (!adapter.transfer) return { scheduled: 0, enqueued: 0 };
    const { scheduled, payoutIds } = await schedulePayoutTransfers(deps.db);
    await payoutTransferQueue(deps).enqueue(payoutIds);
    if (payoutIds.length > 0) deps.logger.info("payout transfers queued", { scheduled, enqueued: payoutIds.length });
    return { scheduled, enqueued: payoutIds.length };
  } catch (err) {
    deps.logger.warn("payout transfers not started; the next run retries", {
      errorName: err instanceof Error ? err.name : "UnknownError",
    });
    return { scheduled: 0, enqueued: 0 };
  }
}

// ── money.treasurer.transfers ───────────────────────────────────────────────────────────────

const money = (cents: number, currency: string) => ({ cents, currency });

type TransferJoin = {
  t: typeof payoutTransfers.$inferSelect;
  periodStart: Date;
  u: { id: string; username: string; name: string };
};

/** The treasurer's view of one transfer (`money.treasurer.transfers`, `settleTransfer`). */
export function transferView({ t, periodStart, u }: TransferJoin) {
  return {
    id: t.id,
    payoutId: t.payoutId,
    user: { id: u.id, username: u.username, displayName: u.name },
    periodStart: periodStart.toISOString(),
    amount: money(t.amountCents, t.currency),
    reversed: money(t.reversedCents, t.currency),
    status: t.status,
    failureCode: t.failureCode,
    providerRef: t.providerRef,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/** One transfer with its payout's run and payee, or null. */
export async function transferRow(db: Executor, transferId: string): Promise<TransferJoin | null> {
  const [row] = await db
    .select({
      t: payoutTransfers,
      periodStart: payouts.periodStart,
      u: { id: users.id, username: users.username, name: users.name },
    })
    .from(payoutTransfers)
    .innerJoin(payouts, eq(payouts.id, payoutTransfers.payoutId))
    .innerJoin(users, eq(users.id, payouts.userId))
    .where(eq(payoutTransfers.id, transferId));
  return row ?? null;
}

export const treasurerTransferHandlers = {
  transfers: os.money.treasurer.transfers.handler(async ({ context, input }) => {
    const { db } = context.deps;
    // uuidv7 ids are time-ordered and unique, so the id alone is an exact keyset.
    const cur = decodeCursor(input.cursor, isIdCursor);
    const rows = await db
      .select({
        t: payoutTransfers,
        periodStart: payouts.periodStart,
        u: { id: users.id, username: users.username, name: users.name },
      })
      .from(payoutTransfers)
      .innerJoin(payouts, eq(payouts.id, payoutTransfers.payoutId))
      .innerJoin(users, eq(users.id, payouts.userId))
      .where(
        and(
          input.periodStart ? eq(payouts.periodStart, new Date(input.periodStart)) : undefined,
          input.status ? eq(payoutTransfers.status, input.status) : undefined,
          cur ? lt(payoutTransfers.id, cur.id) : undefined,
        ),
      )
      .orderBy(desc(payoutTransfers.id))
      .limit(input.limit + 1);
    return pageOf(rows, input.limit, transferView, ({ t }) => encodeCursor({ id: t.id }));
  }),
};
