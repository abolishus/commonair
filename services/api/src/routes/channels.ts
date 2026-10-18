// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { schema, uuidv7 } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { broadcasterFields, emit, userFields } from "../events/outbox.ts";
import { channelBySlug, iso, loadUsersPublic, toChannelDto, toPanelDto, userByUsername } from "../lib/dto.ts";
import { publishControl } from "../lib/control.ts";
import { decodeCursor, encodeCursor, isKeyCursor, pageOf } from "../lib/cursor.ts";
import { badRequest, forbidden, notFound } from "../lib/errors.ts";
import { redactKeys, scanAndRevoke, type LeakSource } from "../lib/leaks.ts";
import { os, requireCaller, requireChannel, type Ctx } from "../lib/orpc.ts";

const { channels, channelPanels, categories, follows, users, channelRoles, modActions } = schema;

/** Revoke any active stream key found in `text`, and store the text with keys redacted. */
async function scrubKeys(deps: Deps, text: string, source: LeakSource): Promise<string> {
  const revoked = await scanAndRevoke(deps, text, source);
  return revoked > 0 || /live_[A-Za-z0-9_-]{43}/.test(text) ? redactKeys(text) : text;
}

const UPLOAD_TYPES: Record<string, readonly string[]> = {
  avatar: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  banner: ["image/png", "image/jpeg", "image/webp"],
  panel: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  emote: ["image/png", "image/webp", "image/gif"],
  alert_image: ["image/png", "image/jpeg", "image/webp", "image/gif"],
  alert_sound: ["audio/mpeg", "audio/ogg"],
};
const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
};
const UPLOAD_TTL_SECONDS = 600;

const ROLE_ACTIONS = {
  moderator: { add: "add_moderator", remove: "remove_moderator" },
  vip: { add: "add_vip", remove: "remove_vip" },
  editor: { add: null, remove: null },
} as const;

export const channelsRoutes = {
  get: os.channels.get.handler(async ({ context: { deps }, input }) => {
    const c = await channelBySlug(deps, input.channel);
    if (!c) throw notFound("Channel not found");
    return toChannelDto(deps, c);
  }),

  update: os.channels.update.handler(async ({ context, input }) => {
    const { deps } = context;
    const c = requireChannel(context);
    const set: Partial<typeof channels.$inferInsert> = {};
    let categoryMature = false;
    if (input.categoryId !== undefined) {
      if (input.categoryId !== null) {
        const [cat] = await deps.db.select().from(categories).where(eq(categories.id, input.categoryId));
        if (!cat) throw badRequest("Unknown category");
        categoryMature = cat.mature;
      }
      set.categoryId = input.categoryId;
    }
    if (input.title !== undefined) set.title = await scrubKeys(deps, input.title.trim(), "description");
    if (input.description !== undefined) set.description = await scrubKeys(deps, input.description, "description");
    if (input.tags !== undefined) set.tags = [...new Set(input.tags.map((t) => t.toLowerCase()))];
    if (input.language !== undefined) set.language = input.language.toLowerCase();
    if (input.mature !== undefined) set.mature = input.mature;
    // A mature category forces the label; streamers cannot opt out of it.
    if (categoryMature) set.mature = true;
    if (input.theme !== undefined) set.theme = input.theme;
    if (input.vodEnabled !== undefined) set.vodEnabled = input.vodEnabled;
    if (input.vodRetentionDays !== undefined) set.vodRetentionDays = input.vodRetentionDays;

    const announced = ["title", "categoryId", "tags", "language", "mature"].some((k) => k in set);
    const updated = await deps.db.transaction(async (tx) => {
      const [row] = await tx.update(channels).set(set).where(eq(channels.id, c.id)).returning();
      if (!row) throw notFound("Channel not found");
      if (row.liveBroadcastId && ("title" in set || "categoryId" in set || "mature" in set))
        await tx
          .update(schema.broadcasts)
          .set({ title: row.title, categoryId: row.categoryId, mature: row.mature })
          .where(eq(schema.broadcasts.id, row.liveBroadcastId));
      if (announced) {
        const [cat] = row.categoryId
          ? await tx.select({ name: categories.name }).from(categories).where(eq(categories.id, row.categoryId))
          : [];
        await emit(tx, "channel.update", row.id, {
          ...broadcasterFields(row),
          title: row.title,
          language: row.language,
          category_id: row.categoryId,
          category_name: cat?.name ?? null,
          tags: row.tags,
          mature: row.mature,
        });
      }
      return row;
    });
    return toChannelDto(deps, updated);
  }),

  setPanels: os.channels.setPanels.handler(async ({ context, input }) => {
    const { deps } = context;
    const c = requireChannel(context);
    const panels: (typeof channelPanels.$inferInsert)[] = [];
    for (const [i, p] of input.panels.entries())
      panels.push({
        channelId: c.id,
        position: i,
        title: await scrubKeys(deps, p.title, "panel"),
        body: await scrubKeys(deps, p.body, "panel"),
        imageKey: p.imageKey,
        linkUrl: p.linkUrl,
      });
    for (const p of panels)
      if (p.imageKey && !p.imageKey.startsWith(`channels/${c.id}/`))
        throw badRequest("Panel images must be your uploads");
    for (const p of panels)
      if (p.linkUrl && !/^https?:\/\//i.test(p.linkUrl)) throw badRequest("Links must be http(s)");
    const rows = await deps.db.transaction(async (tx) => {
      await tx.delete(channelPanels).where(eq(channelPanels.channelId, c.id));
      return panels.length ? tx.insert(channelPanels).values(panels).returning() : [];
    });
    return rows.sort((a, b) => a.position - b.position).map(toPanelDto(deps));
  }),

  uploadUrl: os.channels.uploadUrl.handler(async ({ context, input }) => {
    const { deps } = context;
    const c = requireChannel(context);
    if (!UPLOAD_TYPES[input.purpose]?.includes(input.contentType))
      throw badRequest(`${input.contentType} is not allowed for ${input.purpose}`);
    const key = `channels/${c.id}/${input.purpose}/${uuidv7()}.${EXT[input.contentType] ?? "bin"}`;
    const uploadUrl = await deps.storage.presignPut(deps.env.S3_BUCKET_MEDIA, key, {
      expiresSeconds: UPLOAD_TTL_SECONDS,
      contentType: input.contentType,
      contentLength: input.sizeBytes,
    });
    return {
      key,
      uploadUrl,
      headers: { "content-type": input.contentType, "content-length": String(input.sizeBytes) },
      expiresAt: iso(new Date(deps.now().getTime() + UPLOAD_TTL_SECONDS * 1000)),
    };
  }),

  follow: os.channels.follow.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const c = await channelBySlug(deps, input.channel);
    if (!c) throw notFound("Channel not found");
    if (c.ownerId === caller.user.id) throw badRequest("You cannot follow your own channel");
    const result = await deps.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(follows)
        .values({ followerId: caller.user.id, channelId: c.id, notify: input.notify })
        .onConflictDoNothing()
        .returning();
      if (!inserted) {
        await tx
          .update(follows)
          .set({ notify: input.notify })
          .where(and(eq(follows.followerId, caller.user.id), eq(follows.channelId, c.id)));
        const [row] = await tx.select({ n: channels.followerCount }).from(channels).where(eq(channels.id, c.id));
        return { following: true as const, followerCount: row?.n ?? c.followerCount };
      }
      const [row] = await tx
        .update(channels)
        .set({ followerCount: sql`${channels.followerCount} + 1` })
        .where(eq(channels.id, c.id))
        .returning({ n: channels.followerCount });
      const [u] = await tx
        .select({ id: users.id, username: users.username, name: users.name })
        .from(users)
        .where(eq(users.id, caller.user.id));
      if (u)
        await emit(tx, "channel.follow", c.id, {
          ...broadcasterFields(c),
          ...userFields(u),
          followed_at: iso(inserted.createdAt),
        });
      return { following: true as const, followerCount: row?.n ?? c.followerCount + 1 };
    });
    // Followers-only chat depends on follow state.
    await publishControl(deps, c.id, { op: "invalidate", scope: "user", userId: caller.user.id });
    return result;
  }),

  unfollow: os.channels.unfollow.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const c = await channelBySlug(deps, input.channel);
    if (!c) throw notFound("Channel not found");
    const result = await deps.db.transaction(async (tx) => {
      const [deleted] = await tx
        .delete(follows)
        .where(and(eq(follows.followerId, caller.user.id), eq(follows.channelId, c.id)))
        .returning();
      // Excluded follows were never counted, so removing one changes nothing.
      if (deleted && deleted.excludedAt === null) {
        const [row] = await tx
          .update(channels)
          .set({ followerCount: sql`greatest(${channels.followerCount} - 1, 0)` })
          .where(eq(channels.id, c.id))
          .returning({ n: channels.followerCount });
        return { following: false as const, followerCount: row?.n ?? 0 };
      }
      const [row] = await tx.select({ n: channels.followerCount }).from(channels).where(eq(channels.id, c.id));
      return { following: false as const, followerCount: row?.n ?? 0 };
    });
    await publishControl(deps, c.id, { op: "invalidate", scope: "user", userId: caller.user.id });
    return result;
  }),

  followers: os.channels.followers.handler(async ({ context, input }) => {
    const { deps } = context;
    const c = requireChannel(context);
    const cur = decodeCursor(input.cursor, isKeyCursor);
    const rows = await deps.db
      .select()
      .from(follows)
      .where(
        and(
          eq(follows.channelId, c.id),
          cur
            ? or(
                lt(follows.createdAt, new Date(cur.t)),
                and(eq(follows.createdAt, new Date(cur.t)), lt(follows.followerId, cur.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(follows.createdAt), desc(follows.followerId))
      .limit(input.limit + 1);
    const people = await loadUsersPublic(
      deps,
      rows.map((r) => r.followerId),
    );
    const page = pageOf(
      rows,
      input.limit,
      (r) => ({ r, user: people.get(r.followerId) }),
      (last) => encodeCursor({ t: iso(last.createdAt), id: last.followerId }),
    );
    return {
      items: page.items.flatMap(({ r, user }) =>
        user ? [{ user, followedAt: iso(r.createdAt), excluded: r.excludedAt !== null }] : [],
      ),
      nextCursor: page.nextCursor,
    };
  }),

  roles: {
    list: os.channels.roles.list.handler(async ({ context }) => {
      const { deps } = context;
      const c = requireChannel(context);
      const rows = await deps.db.select().from(channelRoles).where(eq(channelRoles.channelId, c.id));
      const people = await loadUsersPublic(
        deps,
        rows.map((r) => r.userId),
      );
      return rows.flatMap((r) => {
        const user = people.get(r.userId);
        return user ? [{ user, role: r.role, grantedAt: iso(r.createdAt) }] : [];
      });
    }),

    grant: os.channels.roles.grant.handler(async ({ context, input }) => {
      await changeRole(context, input, "add");
      return { ok: true as const };
    }),

    revoke: os.channels.roles.revoke.handler(async ({ context, input }) => {
      await changeRole(context, input, "remove");
      return { ok: true as const };
    }),
  },
};

async function changeRole(
  context: Ctx,
  input: { username: string; role: "moderator" | "vip" | "editor" },
  op: "add" | "remove",
) {
  const { deps } = context;
  const caller = requireCaller(context);
  const c = requireChannel(context);
  // Editors manage the channel but only the owner decides who else holds authority over it.
  if (c.ownerId !== caller.user.id) throw forbidden("Only the channel owner can change roles");
  const target = await userByUsername(deps, input.username);
  if (!target) throw notFound("User not found");
  if (target.id === c.ownerId) throw badRequest("The owner already has every role");
  const changed = await deps.db.transaction(async (tx) => {
    const rows =
      op === "add"
        ? await tx
            .insert(channelRoles)
            .values({ channelId: c.id, userId: target.id, role: input.role, grantedBy: caller.user.id })
            .onConflictDoNothing()
            .returning()
        : await tx
            .delete(channelRoles)
            .where(
              and(
                eq(channelRoles.channelId, c.id),
                eq(channelRoles.userId, target.id),
                eq(channelRoles.role, input.role),
              ),
            )
            .returning();
    if (rows.length === 0) return false;
    const action = ROLE_ACTIONS[input.role][op];
    if (action)
      await tx.insert(modActions).values({
        scope: "channel",
        channelId: c.id,
        moderatorId: caller.user.id,
        targetUserId: target.id,
        action,
      });
    await audit(tx, {
      actorType: "user",
      actorId: caller.user.id,
      action: `channel.role.${op}`,
      subjectType: "user",
      subjectId: target.id,
      channelId: c.id,
      details: { role: input.role },
    });
    if (input.role === "moderator")
      await emit(tx, op === "add" ? "channel.moderator.add" : "channel.moderator.remove", c.id, {
        ...broadcasterFields(c),
        ...userFields(target),
      });
    return true;
  });
  if (changed) await publishControl(deps, c.id, { op: "invalidate", scope: "user", userId: target.id });
}
