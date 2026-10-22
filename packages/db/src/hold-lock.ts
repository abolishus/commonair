// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import type { Executor } from "./client.ts";

/** Advisory-lock key serializing a legal hold on `userId` with deletion of that user's media. */
export const legalHoldLockKey = (userId: string) => `legal_hold:${userId}`;

/**
 * Take the per-user legal-hold lock for the rest of the transaction. Every path that places a
 * hold and every path that deletes a user's media takes it first, so a hold either commits before
 * the deleter's re-check (the media stays) or waits until the object in flight is gone.
 */
export async function lockLegalHold(tx: Executor, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${legalHoldLockKey(userId)}, 0))`);
}
