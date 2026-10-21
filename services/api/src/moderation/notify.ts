// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * In-app notifications for trust & safety staff and owners. Payloads carry ids and enums only:
 * never report details, requester data, URLs or frames.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { PLATFORM_ROLES } from "@commonair/contracts/enums";
import { schema, type Executor } from "@commonair/db";

type Role = (typeof PLATFORM_ROLES)[number];
type Payload = Record<string, string | number | boolean | null>;

/** Notify every (not deleted) user holding one of `roles`. Returns how many were notified. */
export async function notifyRoles(tx: Executor, roles: readonly Role[], payload: Payload): Promise<number> {
  const staff = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(inArray(schema.users.role, [...roles]), isNull(schema.users.deletedAt)));
  if (staff.length === 0) return 0;
  await tx
    .insert(schema.notifications)
    .values(staff.map((s) => ({ userId: s.id, type: "moderation" as const, payload })));
  return staff.length;
}

export async function notifyUser(tx: Executor, userId: string, payload: Payload): Promise<void> {
  const [u] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId));
  if (u) await tx.insert(schema.notifications).values({ userId, type: "moderation", payload });
}
