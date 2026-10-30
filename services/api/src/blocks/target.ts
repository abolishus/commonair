// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Lookups `me.blocks` shares: the user to block, and an existing block row. */
import { schema, type Executor } from "@commonair/db";
import { and, eq, isNull } from "drizzle-orm";

const { userBlocks: ub, users } = schema;

export interface BlockTarget {
  id: string;
  username: string;
  displayName: string;
}

/** A live account by username; null when unknown or deleted (pseudonymized accounts keep a row). */
export async function blockTarget(db: Executor, username: string): Promise<BlockTarget | null> {
  const [u] = await db
    .select({ id: users.id, username: users.username, displayName: users.name })
    .from(users)
    .where(and(eq(users.username, username), isNull(users.deletedAt)))
    .limit(1);
  return u ?? null;
}

export async function blockedRow(
  db: Executor,
  userId: string,
  blockedUserId: string,
): Promise<{ createdAt: Date } | null> {
  const [row] = await db
    .select({ createdAt: ub.createdAt })
    .from(ub)
    .where(and(eq(ub.userId, userId), eq(ub.blockedUserId, blockedUserId)))
    .limit(1);
  return row ?? null;
}
