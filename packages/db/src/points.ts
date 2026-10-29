// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Channel points (ADR 0026 decision 2). The API, the worker and the chat bot all move points; the
 * rules live here once. Every move is one `loyalty_transactions` row: the 0034 trigger applies it
 * to `loyalty_balances` (nothing else may write that table) and the balance CHECK refuses an
 * overdraw. Callers write the `channel.points.change` outbox event themselves (not for `watch`).
 */
import type { LOYALTY_REASONS } from "@commonair/contracts/enums";
import { and, eq } from "drizzle-orm";
import type { Executor } from "./client.ts";
import { uuidv7 } from "./ids.ts";
import { loyaltyBalances, loyaltyTransactions } from "./schema/interactive.ts";

export type LoyaltyReason = (typeof LOYALTY_REASONS)[number];

/** A spend would take the balance below zero; nothing was written. */
export class InsufficientPointsError extends Error {
  override name = "InsufficientPointsError";
  constructor(message = "Not enough points") {
    super(message);
  }
}

const BALANCE_CHECK = "loyalty_balances_points_nonneg";

/** SQLSTATE 23514 on loyalty_balances_points_nonneg (the CHECK the 0034 trigger trips). */
export function isInsufficientPoints(err: unknown): boolean {
  if (err instanceof InsufficientPointsError) return true;
  let e: unknown = err;
  // Drizzle wraps the driver's error; walk the cause chain.
  for (let depth = 0; e && depth < 5; depth++) {
    const { code, constraint_name: constraint } = e as { code?: unknown; constraint_name?: unknown };
    if (code === "23514" && constraint === BALANCE_CHECK) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Insert one ledger row inside a SAVEPOINT (so the caller's transaction survives a refusal) and
 * return the balance after it. Throws InsufficientPointsError on an overdraw; never writes
 * loyalty_balances itself (the trigger does).
 */
export async function postPointsInTx(
  tx: Executor,
  p: {
    channelId: string;
    userId: string;
    delta: number;
    reason: LoyaltyReason;
    refId: string | null;
    at?: Date;
  },
): Promise<{ id: string; balance: number }> {
  const id = uuidv7(p.at?.getTime());
  try {
    // A nested transaction on a transaction is a SAVEPOINT: a refused row rolls back to it only.
    await tx.transaction(async (sp) => {
      await sp.insert(loyaltyTransactions).values({
        id,
        channelId: p.channelId,
        userId: p.userId,
        delta: p.delta,
        reason: p.reason,
        refId: p.refId,
        ...(p.at ? { createdAt: p.at } : {}),
      });
    });
  } catch (err) {
    if (isInsufficientPoints(err)) throw new InsufficientPointsError();
    throw err;
  }
  return { id, balance: await pointsBalance(tx, p.channelId, p.userId) };
}

/** The user's balance on the channel; 0 when they never had points there. */
export async function pointsBalance(db: Executor, channelId: string, userId: string): Promise<number> {
  const [row] = await db
    .select({ points: loyaltyBalances.points })
    .from(loyaltyBalances)
    .where(and(eq(loyaltyBalances.channelId, channelId), eq(loyaltyBalances.userId, userId)));
  return row?.points ?? 0;
}
