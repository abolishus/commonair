// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `ChatMessage` DTOs from stored rows (chat history and the held queue share them): badges from
 * the author's channel roles, subscriptions and platform role, and the quoted reply (blank once
 * the quoted message was deleted).
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { dto } from "@commonair/contracts";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { iso } from "../lib/dto.ts";

const { chatMessages, channelRoles, users, subscriptions } = schema;
type ChannelRow = typeof schema.channels.$inferSelect;
type Badge = dto.ChatMessage["user"]["badges"][number];

/** Mirrors services/chat `CHAT_COLOR_COUNT` and `colorFor` (a test pins them equal). */
export const CHAT_COLOR_COUNT = 12;

/** The design-token name color chat gives `userId` on live messages ("chat-1" … "chat-12"). */
export function nameColor(userId: string): string {
  // FNV-1a (32-bit), as chat computes it, so history and released messages match live ones.
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `chat-${((h >>> 0) % CHAT_COLOR_COUNT) + 1}`;
}

export type MessageRow = { m: typeof chatMessages.$inferSelect; u: typeof users.$inferSelect };

export async function badgesFor(deps: Pick<Deps, "db">, c: ChannelRow, userIds: string[]) {
  const ids = [...new Set(userIds)];
  const out = new Map<string, Badge[]>();
  if (ids.length === 0) return out;
  const [roles, subs, people] = await Promise.all([
    deps.db
      .select()
      .from(channelRoles)
      .where(and(eq(channelRoles.channelId, c.id), inArray(channelRoles.userId, ids))),
    deps.db
      .select({ userId: subscriptions.subscriberId, tier: subscriptions.tier })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.channelId, c.id),
          eq(subscriptions.status, "active"),
          inArray(subscriptions.subscriberId, ids),
        ),
      ),
    deps.db
      .select({ id: users.id, role: users.role, accountType: users.accountType })
      .from(users)
      .where(inArray(users.id, ids)),
  ]);
  for (const id of ids) out.set(id, []);
  for (const p of people) {
    const b = out.get(p.id) ?? [];
    if (p.id === c.ownerId) b.push({ type: "broadcaster" });
    if (p.role === "admin" || p.role === "moderator") b.push({ type: "staff" });
    if (p.accountType === "bot") b.push({ type: "bot" });
  }
  for (const r of roles) {
    if (r.role === "moderator") out.get(r.userId)?.push({ type: "moderator" });
    if (r.role === "vip") out.get(r.userId)?.push({ type: "vip" });
  }
  for (const s of subs) out.get(s.userId)?.push({ type: "subscriber", tier: s.tier });
  return out;
}

/** One stored message as the wire DTO. Pure; `badges` and `reply` come from the lookups above. */
export function messageDto(
  { m, u }: MessageRow,
  badges: Badge[],
  reply: { id: string; username: string; body: string; deleted: boolean } | undefined,
): dto.ChatMessage {
  return {
    id: m.id,
    channelId: m.channelId,
    user: {
      id: u.id,
      username: u.username,
      displayName: u.name,
      color: nameColor(u.id),
      badges,
      accountType: u.accountType,
    },
    body: m.body,
    emotes: m.emotes,
    isAction: m.isAction,
    replyTo: reply ? { id: reply.id, username: reply.username, body: reply.deleted ? "" : reply.body } : null,
    createdAt: iso(m.createdAt),
  };
}

/** DTOs for `rows`, in the order given. */
export async function messageDtos(
  deps: Pick<Deps, "db">,
  c: ChannelRow,
  rows: readonly MessageRow[],
): Promise<dto.ChatMessage[]> {
  const replyIds = rows.map((r) => r.m.replyToId).filter((x): x is string => x !== null);
  const replies = replyIds.length
    ? await deps.db
        .select({
          id: chatMessages.id,
          body: chatMessages.body,
          deletedAt: chatMessages.deletedAt,
          username: users.username,
        })
        .from(chatMessages)
        .innerJoin(users, eq(users.id, chatMessages.userId))
        // A held quote is treated as missing, as chat's own reply lookup does: viewers never saw it.
        .where(and(inArray(chatMessages.id, replyIds), isNull(chatMessages.heldAt)))
    : [];
  const replyBy = new Map(replies.map((r) => [r.id, r]));
  const badges = await badgesFor(
    deps,
    c,
    rows.map((r) => r.u.id),
  );
  return rows.map((row) => {
    const reply = row.m.replyToId ? replyBy.get(row.m.replyToId) : undefined;
    return messageDto(
      row,
      badges.get(row.u.id) ?? [],
      reply && { id: reply.id, username: reply.username, body: reply.body, deleted: reply.deletedAt !== null },
    );
  });
}
