// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Chat REST: history, modes, bans, word filters, emotes, connection tokens.
 * Live messaging and in-chat moderation commands are the chat service's; these
 * endpoints write the same tables and broadcast on BUS.chatControl.
 */
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { CHAT_TOKEN_TTL_SECONDS } from "@commonair/contracts/internal";
import { ChannelChatSettings } from "@commonair/contracts/shapes";
import type { Scope } from "@commonair/contracts/scopes";
import { schema, type Executor } from "@commonair/db";
import { signChatToken } from "@commonair/tokens";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { broadcasterFields, emit, moderatorFields, userFields } from "../events/outbox.ts";
import { channelBySlug, iso, isoOrNull, mediaUrl, userByUsername } from "../lib/dto.ts";
import { publishControl } from "../lib/control.ts";
import { decodeCursor, encodeCursor, isKeyCursor, pageOf } from "../lib/cursor.ts";
import { badRequest, conflict, forbidden, isUniqueViolation, notFound, notImplemented } from "../lib/errors.ts";
import { os, requireCaller, requireChannel, type Ctx } from "../lib/orpc.ts";
import { unsafeFilterRegexReason } from "@commonair/safe-regex";

const { chatMessages, chatBans, channelRoles, users, wordFilters, emotes, modActions, channels, subscriptions } =
  schema;
type ChannelRow = typeof channels.$inferSelect;
const CHAT_SCOPES: Scope[] = ["chat:read", "chat:edit", "moderator:manage:chat"];
const MAX_FILTERS = 200;
const MAX_EMOTES = 100;

export const chatSettingsOf = (c: ChannelRow) => {
  const parsed = ChannelChatSettings.safeParse(c.chatSettings);
  return parsed.success ? parsed.data : ChannelChatSettings.parse({});
};

async function actorRow(db: Executor, id: string) {
  const [u] = await db
    .select({ id: users.id, username: users.username, name: users.name })
    .from(users)
    .where(eq(users.id, id));
  if (!u) throw notFound("User not found");
  return u;
}

/** Moderators may not act on the broadcaster, editors or other moderators; only the owner may. */
async function assertCanModerate(ctx: Ctx, c: ChannelRow, targetId: string) {
  const caller = requireCaller(ctx);
  if (targetId === c.ownerId) throw forbidden("The broadcaster cannot be moderated");
  if (targetId === caller.user.id) throw badRequest("You cannot do this to yourself");
  if (caller.user.id === c.ownerId) return;
  const roles = await ctx.deps.db
    .select({ role: channelRoles.role })
    .from(channelRoles)
    .where(and(eq(channelRoles.channelId, c.id), eq(channelRoles.userId, targetId)));
  if (roles.some((r) => r.role === "moderator" || r.role === "editor"))
    throw forbidden("Only the broadcaster can act on moderators");
}

/** A pattern chat compiles in its hot path: must fit the linear-time-safe subset (no ReDoS). */
export function checkFilterPattern(pattern: string, isRegex: boolean) {
  if (!isRegex) return;
  const reason = unsafeFilterRegexReason(pattern);
  if (reason) throw badRequest(`Filter pattern refused: ${reason}`);
}

/**
 * Chat re-validates stored filters on load and skips the ones the current validator refuses, so
 * the owner sees the same verdict here (filters stored before a stricter rule landed).
 */
function filterDto(f: typeof wordFilters.$inferSelect) {
  const invalidReason = f.isRegex ? unsafeFilterRegexReason(f.pattern) : null;
  return {
    id: f.id,
    pattern: f.pattern,
    isRegex: f.isRegex,
    action: f.action,
    replacement: f.replacement,
    invalid: invalidReason !== null,
    invalidReason,
  };
}

async function badgesFor(deps: Deps, c: ChannelRow, userIds: string[]) {
  const ids = [...new Set(userIds)];
  const out = new Map<
    string,
    { type: "broadcaster" | "moderator" | "vip" | "subscriber" | "bot" | "staff"; tier?: number }[]
  >();
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

function isActiveBan(b: typeof chatBans.$inferSelect, now: Date) {
  return b.liftedAt === null && (b.expiresAt === null || b.expiresAt > now);
}

async function toBanDtos(deps: Deps, rows: (typeof chatBans.$inferSelect)[]) {
  const ids = [...new Set(rows.flatMap((r) => [r.userId, ...(r.moderatorId ? [r.moderatorId] : [])]))];
  const people = ids.length
    ? await deps.db
        .select({ id: users.id, username: users.username, name: users.name })
        .from(users)
        .where(inArray(users.id, ids))
    : [];
  const by = new Map(people.map((p) => [p.id, p]));
  return rows.flatMap((r) => {
    const u = by.get(r.userId);
    if (!u) return [];
    const m = r.moderatorId ? by.get(r.moderatorId) : undefined;
    return [
      {
        id: r.id,
        user: { id: u.id, username: u.username, displayName: u.name },
        moderator: m ? { id: m.id, username: m.username } : null,
        reason: r.reason,
        expiresAt: isoOrNull(r.expiresAt),
        createdAt: iso(r.createdAt),
      },
    ];
  });
}

const toEmote = (deps: Deps, slugById: Map<string, string>) => (e: typeof emotes.$inferSelect) => ({
  id: e.id,
  code: e.code,
  url: mediaUrl(deps, e.imageKey) ?? "",
  tier: e.tier,
  animated: e.animated,
  channelSlug: e.channelId ? (slugById.get(e.channelId) ?? null) : null,
});

export const chat = {
  history: os.chat.history.handler(async ({ context: { deps }, input }) => {
    const c = await channelBySlug(deps, input.channel);
    if (!c) throw notFound("Channel not found");
    const rows = await deps.db
      .select({ m: chatMessages, u: users })
      .from(chatMessages)
      .innerJoin(users, eq(users.id, chatMessages.userId))
      .where(
        and(
          eq(chatMessages.channelId, c.id),
          isNull(chatMessages.deletedAt),
          isNull(chatMessages.heldAt),
          input.before ? lt(chatMessages.createdAt, new Date(input.before)) : undefined,
        ),
      )
      .orderBy(desc(chatMessages.createdAt))
      .limit(input.limit);
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
          .where(inArray(chatMessages.id, replyIds))
      : [];
    const replyBy = new Map(replies.map((r) => [r.id, r]));
    const badges = await badgesFor(
      deps,
      c,
      rows.map((r) => r.u.id),
    );
    return rows.reverse().map(({ m, u }) => {
      const reply = m.replyToId ? replyBy.get(m.replyToId) : undefined;
      return {
        id: m.id,
        channelId: m.channelId,
        user: {
          id: u.id,
          username: u.username,
          displayName: u.name,
          color: null,
          badges: badges.get(u.id) ?? [],
          accountType: u.accountType,
        },
        body: m.body,
        emotes: m.emotes,
        isAction: m.isAction,
        replyTo: reply ? { id: reply.id, username: reply.username, body: reply.deletedAt ? "" : reply.body } : null,
        createdAt: iso(m.createdAt),
      };
    });
  }),

  send: os.chat.send.handler(notImplemented),
  deleteMessage: os.chat.deleteMessage.handler(notImplemented),
  clear: os.chat.clear.handler(notImplemented),

  settings: os.chat.settings.handler(async ({ context: { deps }, input }) => {
    const c = await channelBySlug(deps, input.channel);
    if (!c) throw notFound("Channel not found");
    return chatSettingsOf(c);
  }),

  updateSettings: os.chat.updateSettings.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const c = requireChannel(context);
    const { channel: _slug, ...patch } = input;
    const before = chatSettingsOf(c);
    const settings = ChannelChatSettings.parse({
      ...before,
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    });
    const modes: {
      action: "slow_mode" | "followers_only" | "subscribers_only" | "emote_only";
      changed: boolean;
      duration: number | null;
    }[] = [
      {
        action: "slow_mode",
        changed: before.slowModeSeconds !== settings.slowModeSeconds,
        duration: settings.slowModeSeconds || null,
      },
      {
        action: "followers_only",
        changed: before.followersOnlyMinutes !== settings.followersOnlyMinutes,
        duration: settings.followersOnlyMinutes === null ? null : settings.followersOnlyMinutes * 60,
      },
      { action: "subscribers_only", changed: before.subscribersOnly !== settings.subscribersOnly, duration: null },
      { action: "emote_only", changed: before.emoteOnly !== settings.emoteOnly, duration: null },
    ];
    await deps.db.transaction(async (tx) => {
      await tx.update(channels).set({ chatSettings: settings }).where(eq(channels.id, c.id));
      for (const m of modes.filter((x) => x.changed))
        await tx.insert(modActions).values({
          scope: "channel",
          channelId: c.id,
          moderatorId: caller.user.id,
          action: m.action,
          durationSeconds: m.duration,
        });
      await audit(tx, {
        actorType: "moderator",
        actorId: caller.user.id,
        action: "chat.settings.update",
        subjectType: "channel",
        subjectId: c.id,
        channelId: c.id,
        details: { changed: Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined) },
      });
      await emit(tx, "channel.chat_settings.update", c.id, {
        ...broadcasterFields(c),
        emote_mode: settings.emoteOnly,
        follower_mode: settings.followersOnlyMinutes !== null,
        follower_mode_duration_minutes: settings.followersOnlyMinutes,
        slow_mode: settings.slowModeSeconds > 0,
        slow_mode_wait_time_seconds: settings.slowModeSeconds > 0 ? settings.slowModeSeconds : null,
        subscriber_mode: settings.subscribersOnly,
      });
    });
    await publishControl(deps, c.id, { op: "settings", channel: c.slug, settings });
    return settings;
  }),

  bans: {
    list: os.chat.bans.list.handler(async ({ context, input }) => {
      const { deps } = context;
      const c = requireChannel(context);
      const now = deps.now();
      const cur = decodeCursor(input.cursor, isKeyCursor);
      const rows = await deps.db
        .select()
        .from(chatBans)
        .where(
          and(
            eq(chatBans.channelId, c.id),
            isNull(chatBans.liftedAt),
            or(isNull(chatBans.expiresAt), gt(chatBans.expiresAt, now)),
            cur
              ? or(
                  lt(chatBans.createdAt, new Date(cur.t)),
                  and(eq(chatBans.createdAt, new Date(cur.t)), lt(chatBans.id, cur.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(chatBans.createdAt), desc(chatBans.id))
        .limit(input.limit + 1);
      const page = pageOf(
        rows,
        input.limit,
        (r) => r,
        (last) => encodeCursor({ t: iso(last.createdAt), id: last.id }),
      );
      return { items: await toBanDtos(deps, page.items), nextCursor: page.nextCursor };
    }),

    ban: os.chat.bans.ban.handler(async ({ context, input }) => {
      const { deps } = context;
      const caller = requireCaller(context);
      const c = requireChannel(context);
      const target = await userByUsername(deps, input.username);
      if (!target) throw notFound("User not found");
      await assertCanModerate(context, c, target.id);
      const now = deps.now();
      const expiresAt = input.durationSeconds ? new Date(now.getTime() + input.durationSeconds * 1000) : null;
      const ban = await deps.db.transaction(async (tx) => {
        // A new ban or timeout replaces any previous one (including expired, unlifted timeouts).
        await tx
          .update(chatBans)
          .set({ liftedAt: now, liftedBy: caller.user.id })
          .where(and(eq(chatBans.channelId, c.id), eq(chatBans.userId, target.id), isNull(chatBans.liftedAt)));
        const [row] = await tx
          .insert(chatBans)
          .values({
            channelId: c.id,
            userId: target.id,
            moderatorId: caller.user.id,
            reason: input.reason,
            expiresAt,
            createdAt: now,
          })
          .returning();
        if (!row) throw new Error("ban insert returned no row");
        await tx.insert(modActions).values({
          scope: "channel",
          channelId: c.id,
          moderatorId: caller.user.id,
          targetUserId: target.id,
          action: expiresAt ? "timeout" : "ban",
          reason: input.reason,
          durationSeconds: input.durationSeconds ?? null,
        });
        await audit(tx, {
          actorType: "moderator",
          actorId: caller.user.id,
          action: expiresAt ? "chat.timeout" : "chat.ban",
          subjectType: "user",
          subjectId: target.id,
          channelId: c.id,
          reason: input.reason,
          details: { banId: row.id, durationSeconds: input.durationSeconds ?? null },
        });
        await emit(tx, "channel.ban", c.id, {
          ...broadcasterFields(c),
          ...userFields(target),
          ...moderatorFields(await actorRow(tx, caller.user.id)),
          reason: input.reason,
          banned_at: iso(now),
          ends_at: isoOrNull(expiresAt),
          is_permanent: expiresAt === null,
        });
        return row;
      });
      await publishControl(deps, c.id, {
        op: "ban",
        channel: c.slug,
        userId: target.id,
        username: target.username,
        expiresAt: isoOrNull(expiresAt),
        reason: input.reason,
      });
      const [dtoRow] = await toBanDtos(deps, [ban]);
      if (!dtoRow) throw notFound("User not found");
      return dtoRow;
    }),

    unban: os.chat.bans.unban.handler(async ({ context, input }) => {
      const { deps } = context;
      const caller = requireCaller(context);
      const c = requireChannel(context);
      const target = await userByUsername(deps, input.username);
      if (!target) throw notFound("User not found");
      const now = deps.now();
      await deps.db.transaction(async (tx) => {
        const lifted = await tx
          .update(chatBans)
          .set({ liftedAt: now, liftedBy: caller.user.id })
          .where(and(eq(chatBans.channelId, c.id), eq(chatBans.userId, target.id), isNull(chatBans.liftedAt)))
          .returning();
        const active = lifted.find((b) => isActiveBan({ ...b, liftedAt: null }, now));
        if (!active) throw notFound("This user is not banned or timed out");
        await tx.insert(modActions).values({
          scope: "channel",
          channelId: c.id,
          moderatorId: caller.user.id,
          targetUserId: target.id,
          action: active.expiresAt ? "untimeout" : "unban",
        });
        await audit(tx, {
          actorType: "moderator",
          actorId: caller.user.id,
          action: active.expiresAt ? "chat.untimeout" : "chat.unban",
          subjectType: "user",
          subjectId: target.id,
          channelId: c.id,
          details: { banId: active.id },
        });
        await emit(tx, "channel.unban", c.id, {
          ...broadcasterFields(c),
          ...userFields(target),
          ...moderatorFields(await actorRow(tx, caller.user.id)),
        });
      });
      await publishControl(deps, c.id, { op: "invalidate", scope: "user", userId: target.id });
      return { ok: true as const };
    }),
  },

  filters: {
    list: os.chat.filters.list.handler(async ({ context }) => {
      const c = requireChannel(context);
      const rows = await context.deps.db
        .select()
        .from(wordFilters)
        .where(eq(wordFilters.channelId, c.id))
        .orderBy(wordFilters.createdAt);
      return rows.map(filterDto);
    }),

    create: os.chat.filters.create.handler(async ({ context, input }) => {
      const { deps } = context;
      const caller = requireCaller(context);
      const c = requireChannel(context);
      checkFilterPattern(input.pattern, input.isRegex);
      if (input.action === "replace" && input.replacement === null)
        throw badRequest("A replace filter needs a replacement");
      const row = await deps.db.transaction(async (tx) => {
        const [{ n } = { n: 0 }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(wordFilters)
          .where(eq(wordFilters.channelId, c.id));
        if (Number(n) >= MAX_FILTERS) throw badRequest(`At most ${MAX_FILTERS} filters per channel`);
        const [f] = await tx
          .insert(wordFilters)
          .values({
            channelId: c.id,
            pattern: input.pattern,
            isRegex: input.isRegex,
            action: input.action,
            replacement: input.replacement,
          })
          .returning();
        if (!f) throw new Error("filter insert returned no row");
        await audit(tx, {
          actorType: "moderator",
          actorId: caller.user.id,
          action: "chat.filter.create",
          subjectType: "word_filter",
          subjectId: f.id,
          channelId: c.id,
          details: { action: f.action, isRegex: f.isRegex },
        });
        return f;
      });
      await publishControl(deps, c.id, { op: "invalidate", scope: "channel" });
      return filterDto(row);
    }),

    remove: os.chat.filters.remove.handler(async ({ context, input }) => {
      const { deps } = context;
      const caller = requireCaller(context);
      const c = requireChannel(context);
      await deps.db.transaction(async (tx) => {
        const deleted = await tx
          .delete(wordFilters)
          .where(and(eq(wordFilters.id, input.id), eq(wordFilters.channelId, c.id)))
          .returning({ id: wordFilters.id });
        if (deleted.length === 0) throw notFound("Filter not found");
        await audit(tx, {
          actorType: "moderator",
          actorId: caller.user.id,
          action: "chat.filter.remove",
          subjectType: "word_filter",
          subjectId: input.id,
          channelId: c.id,
        });
      });
      await publishControl(deps, c.id, { op: "invalidate", scope: "channel" });
      return { ok: true as const };
    }),
  },

  held: {
    list: os.chat.held.list.handler(notImplemented),
    resolve: os.chat.held.resolve.handler(notImplemented),
  },

  emotes: {
    list: os.chat.emotes.list.handler(async ({ context: { deps }, input }) => {
      const c = await channelBySlug(deps, input.channel);
      if (!c) throw notFound("Channel not found");
      const rows = await deps.db
        .select()
        .from(emotes)
        .where(or(isNull(emotes.channelId), eq(emotes.channelId, c.id)))
        .orderBy(emotes.code);
      return rows.map(toEmote(deps, new Map([[c.id, c.slug]])));
    }),

    create: os.chat.emotes.create.handler(async ({ context, input }) => {
      const { deps } = context;
      const c = requireChannel(context);
      if (!input.imageKey.startsWith(`channels/${c.id}/emote/`))
        throw badRequest("Upload the emote image first (purpose: emote)");
      const [{ n } = { n: 0 }] = await deps.db
        .select({ n: sql<number>`count(*)::int` })
        .from(emotes)
        .where(eq(emotes.channelId, c.id));
      if (Number(n) >= MAX_EMOTES) throw badRequest(`At most ${MAX_EMOTES} emotes per channel`);
      try {
        const [row] = await deps.db
          .insert(emotes)
          .values({
            channelId: c.id,
            code: input.code,
            imageKey: input.imageKey,
            tier: input.tier,
            animated: input.imageKey.endsWith(".gif"),
          })
          .returning();
        if (!row) throw new Error("emote insert returned no row");
        await publishControl(deps, c.id, { op: "invalidate", scope: "channel" });
        return toEmote(deps, new Map([[c.id, c.slug]]))(row);
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict("An emote with this code already exists");
        throw err;
      }
    }),

    remove: os.chat.emotes.remove.handler(async ({ context, input }) => {
      const { deps } = context;
      const c = requireChannel(context);
      const deleted = await deps.db
        .delete(emotes)
        .where(and(eq(emotes.id, input.id), eq(emotes.channelId, c.id)))
        .returning({ id: emotes.id });
      if (deleted.length === 0) throw notFound("Emote not found");
      await publishControl(deps, c.id, { op: "invalidate", scope: "channel" });
      return { ok: true as const };
    }),
  },

  connectToken: os.chat.connectToken.handler(async ({ context }) => {
    const { deps, caller } = context;
    const exp = Math.floor(deps.now().getTime() / 1000) + CHAT_TOKEN_TTL_SECONDS;
    let scopes: Scope[] = ["chat:read"];
    if (caller && !caller.user.suspended)
      scopes =
        caller.kind === "session"
          ? CHAT_SCOPES
          : CHAT_SCOPES.filter((s) => s === "chat:read" || caller.scopes.includes(s));
    const token = await signChatToken(deps.env.INTERNAL_API_SECRET, {
      v: 1,
      uid: caller?.user.id ?? null,
      app: caller?.kind === "token" ? caller.appId : null,
      scopes,
      exp,
    });
    return { token, url: deps.env.CHAT_PUBLIC_URL, expiresAt: iso(new Date(exp * 1000)) };
  }),
};
