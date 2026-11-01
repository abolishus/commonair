// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Move-link follow attribution (ADR 0037, decision (k)). The `channels.follow` handler calls this
 * in its transaction, only for a new follow, right after inserting the row. The follower count is
 * the `follows` trigger's (decision (aa)): never touch `channels.follower_count` here.
 *
 * A nonce that names a live link of this channel sets `follows.source = 'move_link'` and
 * `follows.move_link_id`. A revoked, expired, unknown or other channel's link attributes nothing:
 * the visitor still follows (as `direct`), and the answer does not reveal which case it was.
 */
import { type Executor, schema } from "@commonair/db";
import { and, eq } from "drizzle-orm";
import { findLink, linkState } from "./links.ts";

export interface FollowAttribution {
  followerId: string;
  channelId: string;
  /** The `channels.follow` input's `moveLink`; null for a direct follow. */
  moveLink: { nonce: string } | null;
  /** The caller's clock (`deps.now()`); the wall clock when the call site does not pass one. */
  now?: Date;
}

export async function attributeFollow(tx: Executor, follow: FollowAttribution): Promise<void> {
  if (!follow.moveLink) return;
  const link = await findLink(tx, follow.channelId, follow.moveLink.nonce);
  if (!link || linkState(link, follow.now ?? new Date()) !== "active") return;
  await tx
    .update(schema.follows)
    .set({ source: "move_link", moveLinkId: link.id })
    .where(and(eq(schema.follows.followerId, follow.followerId), eq(schema.follows.channelId, follow.channelId)));
}
