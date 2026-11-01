// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Transaction-scoped advisory locks that serialize money movements whose amounts depend on
 * balances read just before posting. Lock order, always: payout batch → payment → creators,
 * where "creators" is every recipient a posting touches (a split payment's owner and crew),
 * taken in `compareUserIds` order (lowercased user id, byte order) through `lockCreators`;
 * `runPayoutBatch` takes its creator locks in that same order. Nothing takes a lock earlier in
 * that order while holding a later one, and creator locks are always taken ascending, so they
 * cannot deadlock (ADR 0013 decision 4).
 */
import { sql } from "drizzle-orm";
import type { Executor } from "@commonair/db";
import { compareUserIds } from "./math.ts";

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
  return lock(tx, `ledger:creator:${userId.toLowerCase()}`);
}

/** The user ids `lockCreators` locks, in the order it locks them: deduplicated, lowercased, sorted. */
export function creatorLockOrder(userIds: readonly string[]): string[] {
  return [...new Set(userIds.map((u) => u.toLowerCase()))].sort(compareUserIds);
}

/**
 * Lock every recipient a posting touches, in the one documented order. Callers holding a creator
 * lock already must not call this with an id that sorts before it.
 */
export async function lockCreators(tx: Executor, userIds: readonly string[]): Promise<string[]> {
  const order = creatorLockOrder(userIds);
  for (const id of order) await lockCreator(tx, id);
  return order;
}
