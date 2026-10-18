// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { eq } from "drizzle-orm";
import { type Executor, schema } from "@commonair/db";
import { ensureAccounts } from "./accounts.ts";
import { type Posting, validatePosting } from "./posting.ts";

export interface PostResult {
  transactionId: string;
  /** False when the idempotency key had already been posted (nothing new was written). */
  created: boolean;
}

export class IdempotencyConflictError extends Error {
  override name = "IdempotencyConflictError";
}

/**
 * Post a balanced set of entries in one database transaction (a savepoint when `db` is
 * already a transaction, so callers can post atomically with their own writes).
 * Idempotent by `idempotencyKey`: a repeat returns the existing transaction id. The database
 * re-checks balance and append-only rules at commit; this validates first so a bad posting
 * never reaches it.
 */
export async function post(db: Executor, posting: Posting): Promise<PostResult> {
  validatePosting(posting);
  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(schema.ledgerTransactions)
      .values({
        kind: posting.kind,
        description: posting.description,
        occurredAt: posting.occurredAt,
        refType: posting.refType,
        refId: posting.refId,
        idempotencyKey: posting.idempotencyKey,
        reversesId: posting.reversesId ?? null,
        metadata: posting.metadata,
      })
      .onConflictDoNothing({ target: schema.ledgerTransactions.idempotencyKey })
      .returning({ id: schema.ledgerTransactions.id });

    if (!inserted) {
      const [existing] = await tx
        .select({
          id: schema.ledgerTransactions.id,
          kind: schema.ledgerTransactions.kind,
          refId: schema.ledgerTransactions.refId,
        })
        .from(schema.ledgerTransactions)
        .where(eq(schema.ledgerTransactions.idempotencyKey, posting.idempotencyKey));
      if (!existing) throw new Error(`ledger transaction ${posting.idempotencyKey} vanished after conflict`);
      // The same key for a different event is a caller bug; refuse rather than silently drop it.
      if (existing.kind !== posting.kind || existing.refId !== posting.refId) {
        throw new IdempotencyConflictError(
          `idempotency key ${posting.idempotencyKey} was already used for a different ${existing.kind} posting`,
        );
      }
      return { transactionId: existing.id, created: false };
    }

    const ids = await ensureAccounts(
      tx,
      posting.entries.map((e) => e.code),
      posting.currency,
    );
    await tx.insert(schema.ledgerEntries).values(
      posting.entries.map((e) => {
        const accountId = ids.get(e.code);
        if (!accountId) throw new Error(`no account for ${e.code}`);
        return {
          transactionId: inserted.id,
          accountId,
          amountCents: e.amountCents,
          currency: posting.currency,
          memo: e.memo ?? null,
        };
      }),
    );
    return { transactionId: inserted.id, created: true };
  });
}
