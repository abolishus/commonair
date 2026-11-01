// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Move-link follow attribution (ADR 0037, decision (k)). The `channels.follow` handler calls this
 * in its transaction, only for a new follow, right after inserting the row. The follower count is
 * the `follows` trigger's (decision (aa)): never touch `channels.follower_count` here.
 *
 * Contract-step stub: W3-portability resolves the nonce and, for a live link of this channel,
 * sets `follows.source = 'move_link'` and `follows.move_link_id`. Until then it does nothing.
 */
import type { Executor } from "@commonair/db";

export interface FollowAttribution {
  followerId: string;
  channelId: string;
  /** The `channels.follow` input's `moveLink`; null for a direct follow. */
  moveLink: { nonce: string } | null;
}

export async function attributeFollow(_tx: Executor, _follow: FollowAttribution): Promise<void> {}
