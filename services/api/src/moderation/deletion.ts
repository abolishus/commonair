// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Account deletion requests (docs/testing/e4c-selectors.md "Account deletion"). The API schedules
 * them; the worker's `deletions` job completes due requests and fills `retained` with the held
 * tables it left untouched. Requests for one user are serialized on the user's row.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { schema, type Executor } from "@commonair/db";
import { iso } from "../lib/dto.ts";

const { accountDeletions, users } = schema;
type DeletionRow = typeof accountDeletions.$inferSelect;

export const DELETION_GRACE_DAYS = 30;

export const toDeletion = (d: DeletionRow) => ({
  id: d.id,
  status: d.status,
  scheduledFor: iso(d.scheduledFor),
  retained: d.retained,
});

/** Lock the user row so concurrent requests for one account cannot both insert. */
export async function lockUser(tx: Executor, userId: string): Promise<void> {
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
}

export async function scheduledDeletion(tx: Executor, userId: string): Promise<DeletionRow | undefined> {
  const [d] = await tx
    .select()
    .from(accountDeletions)
    .where(and(eq(accountDeletions.userId, userId), eq(accountDeletions.status, "scheduled")))
    .orderBy(desc(accountDeletions.requestedAt))
    .limit(1);
  return d;
}

/** The most recent request that is scheduled or completed (a canceled one reads as none). */
export async function currentDeletion(db: Executor, userId: string): Promise<DeletionRow | undefined> {
  const [d] = await db
    .select()
    .from(accountDeletions)
    .where(and(eq(accountDeletions.userId, userId), inArray(accountDeletions.status, ["scheduled", "completed"])))
    .orderBy(desc(accountDeletions.requestedAt))
    .limit(1);
  return d;
}
