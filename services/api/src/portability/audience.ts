// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Tell me if they move" grants and the move itself (ADR 0037 decision 3, batch 7 decisions (l),
 * (m)).
 *
 * - A grant is the viewer's own, per followed channel; the streamer never sees who holds one or how
 *   many there are. Setting one needs a follow; unfollowing does not withdraw it (the viewer may
 *   still want the one email), deleting the account does (cascade).
 * - `move.set` takes an https URL (the contract checks the scheme, credentials and length; this
 *   re-checks), sets `moved_to` / `moved_at` and writes the internal `channel.moved` event in the
 *   same transaction; the worker mails each grant holder once. Setting the same address again
 *   writes nothing. `move.clear` sends nothing. Subscriptions are untouched (decision (m)).
 */
import { schema } from "@commonair/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { emit } from "../events/outbox.ts";
import { channelAvatar, iso, isoOrNull } from "../lib/dto.ts";
import { badRequest, notFound, precondition } from "../lib/errors.ts";
import { channelBySlug } from "../lib/dto.ts";

const { followPortabilityGrants: grants, follows, channels, users } = schema;

export const MOVED_TO_MAX = 500;

/** The address the contract already validated, checked again (defence in depth). */
export function validMovedTo(raw: string): string | null {
  if (raw.length > MOVED_TO_MAX) return null;
  const u = URL.parse(raw);
  if (!u || u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.hostname === "") return null;
  return u.toString();
}

export async function setGrant(
  deps: Deps,
  input: { userId: string; slug: string; enabled: boolean },
): Promise<{ enabled: boolean }> {
  const c = await channelBySlug(deps, input.slug);
  if (!c) throw notFound("Channel not found");
  if (!input.enabled) {
    await deps.db.delete(grants).where(and(eq(grants.userId, input.userId), eq(grants.channelId, c.id)));
    return { enabled: false };
  }
  const [f] = await deps.db
    .select({ followerId: follows.followerId })
    .from(follows)
    .where(and(eq(follows.followerId, input.userId), eq(follows.channelId, c.id)));
  if (!f) throw precondition("following", "Follow the channel first");
  await deps.db.insert(grants).values({ userId: input.userId, channelId: c.id }).onConflictDoNothing();
  return { enabled: true };
}

/**
 * "All on / all off": `setGrant` for each listed channel in one transaction. Unknown slugs are
 * skipped, and so (when enabling) are channels the caller does not follow, as `setGrant` refuses
 * them. `updated` counts the grants actually added or removed, so a repeat reports 0.
 */
export async function setGrants(
  deps: Deps,
  input: { userId: string; slugs: readonly string[]; enabled: boolean },
): Promise<{ enabled: boolean; updated: number }> {
  const slugs = [...new Set(input.slugs)];
  return deps.db.transaction(async (tx) => {
    const ids = (await tx.select({ id: channels.id }).from(channels).where(inArray(channels.slug, slugs))).map(
      (r) => r.id,
    );
    if (ids.length === 0) return { enabled: input.enabled, updated: 0 };
    if (!input.enabled) {
      const gone = await tx
        .delete(grants)
        .where(and(eq(grants.userId, input.userId), inArray(grants.channelId, ids)))
        .returning({ channelId: grants.channelId });
      return { enabled: false, updated: gone.length };
    }
    const followed = await tx
      .select({ channelId: follows.channelId })
      .from(follows)
      .where(and(eq(follows.followerId, input.userId), inArray(follows.channelId, ids)));
    if (followed.length === 0) return { enabled: true, updated: 0 };
    const added = await tx
      .insert(grants)
      .values(followed.map((f) => ({ userId: input.userId, channelId: f.channelId })))
      .onConflictDoNothing()
      .returning({ channelId: grants.channelId });
    return { enabled: true, updated: added.length };
  });
}

export async function myGrants(deps: Deps, userId: string) {
  const rows = await deps.db
    .select({ channel: channels, createdAt: grants.createdAt, ownerImage: users.image })
    .from(grants)
    .innerJoin(channels, eq(channels.id, grants.channelId))
    .innerJoin(users, eq(users.id, channels.ownerId))
    .where(eq(grants.userId, userId))
    .orderBy(asc(channels.slug))
    .limit(1000);
  return rows.map((r) => ({
    channel: {
      id: r.channel.id,
      slug: r.channel.slug,
      displayName: r.channel.displayName,
      avatarUrl: channelAvatar(deps, r.channel, r.ownerImage),
    },
    createdAt: iso(r.createdAt),
  }));
}

export interface ChannelMoveDto {
  movedTo: string | null;
  movedAt: string | null;
}

export async function setMove(
  deps: Deps,
  input: { channelId: string; actorId: string; movedTo: string },
): Promise<ChannelMoveDto> {
  const url = validMovedTo(input.movedTo);
  if (!url) throw badRequest("Give an https address without a user name or password");
  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    const [cur] = await tx.select().from(channels).where(eq(channels.id, input.channelId)).for("update");
    if (!cur) throw notFound("Channel not found");
    if (cur.movedTo === url) return { movedTo: cur.movedTo, movedAt: isoOrNull(cur.movedAt) };
    const [row] = await tx
      .update(channels)
      .set({ movedTo: url, movedAt: now })
      .where(eq(channels.id, cur.id))
      .returning({ movedTo: channels.movedTo, movedAt: channels.movedAt });
    await emit(tx, "channel.moved", cur.id, { channel_id: cur.id, moved_to: url });
    await audit(tx, {
      actorType: "user",
      actorId: input.actorId,
      action: "portability.move.set",
      subjectType: "channel",
      subjectId: cur.id,
      channelId: cur.id,
    });
    return { movedTo: row?.movedTo ?? url, movedAt: isoOrNull(row?.movedAt ?? now) };
  });
}

export async function clearMove(deps: Deps, input: { channelId: string; actorId: string }): Promise<ChannelMoveDto> {
  return deps.db.transaction(async (tx) => {
    const [cur] = await tx
      .update(channels)
      .set({ movedTo: null, movedAt: null })
      .where(eq(channels.id, input.channelId))
      .returning({ id: channels.id });
    if (!cur) throw notFound("Channel not found");
    await audit(tx, {
      actorType: "user",
      actorId: input.actorId,
      action: "portability.move.clear",
      subjectType: "channel",
      subjectId: cur.id,
      channelId: cur.id,
    });
    return { movedTo: null, movedAt: null };
  });
}
