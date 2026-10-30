// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `notifications.unreadCount` (ADR 0028): the bell's badge. The list and mark-read stay in `me`. */
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { NOTIFY_RULES } from "@commonair/contracts/notify";
import { schema } from "@commonair/db";
import { os, requireCaller } from "../../lib/orpc.ts";

const { notifications } = schema;

export const unreadCount = os.notifications.unreadCount.handler(async ({ context }) => {
  const caller = requireCaller(context);
  const cap = NOTIFY_RULES.unreadCountCap;
  // Stops at cap + 1 rows on `notifications_user_unread_idx`: a member with thousands of unread
  // rows costs the same as one with a hundred.
  const unread = context.deps.db
    .select({ one: sql`1`.as("one") })
    .from(notifications)
    .where(and(eq(notifications.userId, caller.user.id), isNull(notifications.readAt)))
    .limit(cap + 1)
    .as("unread");
  const [row] = await context.deps.db.select({ n: count() }).from(unread);
  const n = row?.n ?? 0;
  return { count: Math.min(n, cap), capped: n > cap };
});
