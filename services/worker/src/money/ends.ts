// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What every money job does when a subscription ends: one `channel.subscription.end` outbox row in
 * the transaction that ended it, and, after commit, a chat `invalidate` so the badge goes.
 */
import { InvalidateMessage } from "@commonair/contracts/chat";
import { BUS, EVENTS } from "@commonair/contracts/events";
import { schema, uuidv7, type Executor } from "@commonair/db";
import { inArray } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";

export interface EndedSubscription {
  id: string;
  subscriberId: string;
  channelId: string;
  tier: number;
  isGift: boolean;
}

/** EventSub tier codes: tier 1–3 → "1000" | "2000" | "3000". */
export function tierCode(tier: number): "1000" | "2000" | "3000" {
  if (tier === 1) return "1000";
  if (tier === 2) return "2000";
  if (tier === 3) return "3000";
  throw new RangeError(`tier must be 1–3, got ${tier}`);
}

/** Insert one validated `channel.subscription.end` row per ended subscription, inside `tx`. */
export async function emitSubscriptionEnds(tx: Executor, ended: readonly EndedSubscription[], now: Date) {
  if (ended.length === 0) return;
  const channelIds = [...new Set(ended.map((e) => e.channelId))];
  const userIds = [...new Set(ended.map((e) => e.subscriberId))];
  const channels = await tx
    .select({
      id: schema.channels.id,
      ownerId: schema.channels.ownerId,
      slug: schema.channels.slug,
      displayName: schema.channels.displayName,
    })
    .from(schema.channels)
    .where(inArray(schema.channels.id, channelIds));
  const users = await tx
    .select({ id: schema.users.id, username: schema.users.username, name: schema.users.name })
    .from(schema.users)
    .where(inArray(schema.users.id, userIds));
  const channelById = new Map(channels.map((c) => [c.id, c]));
  const userById = new Map(users.map((u) => [u.id, u]));
  const def = EVENTS["channel.subscription.end"];
  const rows = ended.map((e) => {
    const c = channelById.get(e.channelId);
    const u = userById.get(e.subscriberId);
    // Both are foreign keys with `restrict`, so a missing row is a broken invariant, not data.
    if (!c || !u) throw new Error("subscription references a missing channel or user");
    const payload = def.payload.parse({
      broadcaster_user_id: c.ownerId,
      broadcaster_user_login: c.slug,
      broadcaster_user_name: c.displayName,
      user_id: u.id,
      user_login: u.username,
      user_name: u.name,
      tier: tierCode(e.tier),
      is_gift: e.isGift,
    }) as Record<string, unknown>;
    return {
      id: uuidv7(now.getTime()),
      type: "channel.subscription.end",
      version: def.version,
      channelId: e.channelId,
      payload,
      occurredAt: now,
    };
  });
  await tx.insert(schema.events).values(rows);
}

/** After commit: drop chat's cached badge for each subscriber. Best effort: chat re-reads on a miss. */
export async function publishBadgeInvalidations(ctx: WorkerContext, ended: readonly EndedSubscription[]) {
  const seen = new Set<string>();
  for (const e of ended) {
    const key = `${e.channelId}:${e.subscriberId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const msg = InvalidateMessage.parse({ op: "invalidate", scope: "user", userId: e.subscriberId });
    try {
      await ctx.valkey.publish(BUS.chatControl(e.channelId), JSON.stringify(msg));
    } catch (err) {
      ctx.logger.warn("chat badge invalidate failed", { channelId: e.channelId, err });
    }
  }
}
