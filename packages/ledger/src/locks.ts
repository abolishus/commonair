// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Transaction-scoped advisory locks that serialize money movements whose amounts depend on
 * balances read just before posting. Lock order, always: payout batch → payment → creator.
 * Nothing takes a lock earlier in that order while holding a later one, so they cannot deadlock.
 */
import { sql } from "drizzle-orm";
import type { Executor } from "@commonair/db";

async function lock(tx: Executor, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

/** Serializes payout batches, payout sends and cancellations in one currency. */
export function lockPayoutBatch(tx: Executor, currency: string): Promise<void> {
  return lock(tx, `ledger:payout-batch:${currency}`);
}

/** Serializes reversals of one payment (so concurrent disputes cannot over-reverse it). */
export function lockPayment(tx: Executor, paymentId: string): Promise<void> {
  return lock(tx, `ledger:payment:${paymentId}`);
}

/** Serializes postings that read and then draw on one creator's balances. */
export function lockCreator(tx: Executor, userId: string): Promise<void> {
  return lock(tx, `ledger:creator:${userId}`);
}
