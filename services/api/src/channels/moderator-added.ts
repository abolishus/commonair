// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `moderator_added` notice (overhaul wave 4, D7; ux-journeys J5-g): a member the owner makes
 * a moderator or editor of their channel is told, in the granting transaction. Ids and enums only;
 * the inbox joins the channel's name at read time.
 */
import type { ModeratorAddedNotificationPayload } from "@commonair/contracts/notify";
import { schema, type Executor } from "@commonair/db";

export async function moderatorAddedNoticeTx(
  tx: Executor,
  p: {
    channel: { id: string; slug: string };
    userId: string;
    role: ModeratorAddedNotificationPayload["role"];
  },
): Promise<void> {
  const payload: ModeratorAddedNotificationPayload = { channelId: p.channel.id, slug: p.channel.slug, role: p.role };
  await tx.insert(schema.notifications).values({ userId: p.userId, type: "moderator_added", payload });
}
