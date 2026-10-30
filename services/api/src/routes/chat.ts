// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Chat REST: history, modes, bans, word filters, emotes, connection tokens, the held queue.
 * Live messaging and in-chat moderation commands are the chat service's: REST send, delete and
 * clear are relayed to it as the caller (`chat/relay.ts`) so its rules and side effects apply
 * unchanged. The other endpoints write the same tables and broadcast on BUS.chatControl.
 */
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { CHAT_TOKEN_TTL_SECONDS } from "@commonair/contracts/internal";
import { ChannelChatSettings } from "@commonair/contracts/shapes";
import { schema, type Executor } from "@commonair/db";
import { listHeld, resolveHeld } from "../chat/held.ts";
import { messageDtos } from "../chat/messages.ts";
import { outcomeError, relayToChat, unavailable, type RelayRequest } from "../chat/relay.ts";
import { chatSurge } from "../chat/surge.ts";
import { chatTokenFor } from "../chat/token.ts";
import type { Deps } from "../deps.ts";
import type { Caller } from "../lib/access.ts";
import { audit } from "../events/audit.ts";
import { broadcasterFields, emit, moderatorFields, userFields } from "../events/outbox.ts";
import { channelBySlug, iso, isoOrNull, mediaUrl, userByUsername } from "../lib/dto.ts";
import { publishControl } from "../lib/control.ts";
import { decodeCursor, encodeCursor, isKeyCursor, pageOf } from "../lib/cursor.ts";
import { badRequest, conflict, forbidden, isUniqueViolation, notFound, precondition } from "../lib/errors.ts";
import { liftChatBanInTx } from "../moderation/chat-bans.ts";
import { os, requireCaller, requireChannel, type Ctx } from "../lib/orpc.ts";
import { unsafeFilterRegexReason } from "@commonair/safe-regex";

const { chatMessages, chatBans, channelRoles, users, wordFilters, emotes, modActions, channels } = schema;
type ChannelRow = typeof channels.$inferSelect;
/** The relay's chat token only has to outlive one call. */
const RELAY_TOKEN_TTL_SECONDS = 60;
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
    return messageDtos(deps, c, rows.reverse());
  }),

  send: os.chat.send.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    // Chat runs "/…" text as a command; REST moderation has its own endpoints ("//" is literal text).
    if (input.body.startsWith("/") && !input.body.startsWith("//"))
      throw badRequest("Chat commands are not accepted here; use the moderation endpoints");
    const c = await channelBySlug(context.deps, input.channel);
    if (!c) throw notFound("Channel not found");
    const o = await relay(context.deps, caller, {
      op: "send",
      channel: c.slug,
      body: input.body,
      replyToId: input.replyToId,
    });
    if (o.type !== "ack") throw outcomeError(o);
    // Chat has no accept-then-drop path today: a message is acked (maybe held) or refused.
    return { id: o.id, held: o.held, dropReason: null };
  }),

  deleteMessage: os.chat.deleteMessage.handler(async ({ context, input }) => {
    const c = requireChannel(context);
    const o = await relay(context.deps, requireCaller(context), {
      op: "command",
      channel: c.slug,
      command: "delete",
      args: [input.id],
    });
    if (o.type === "notice" && o.code === "cmd_success") return { ok: true as const };
    // Chat answers an unknown, foreign-channel or already deleted id with msg_rejected, but also a
    // command that threw. A live row means the latter: retryable, not gone.
    if (o.type === "notice" && o.code === "msg_rejected") {
      if (await liveMessageExists(context.deps, c.id, input.id)) throw unavailable();
      throw notFound("Message not found");
    }
    throw o.type === "ack" ? new Error("chat acked a command") : outcomeError(o);
  }),

  clear: os.chat.clear.handler(async ({ context }) => {
    const c = requireChannel(context);
    const o = await relay(context.deps, requireCaller(context), {
      op: "command",
      channel: c.slug,
      command: "clear",
      args: [],
    });
    if (o.type === "notice" && o.code === "cmd_success") return { ok: true as const };
    throw o.type === "ack" ? new Error("chat acked a command") : outcomeError(o);
  }),

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
    // W1: the instance flags decide whether the gate and the guard can be switched on at all.
    if (deps.env.CHAT_WATCH_GATE !== "on" && (patch.minVerifiedWatchSeconds ?? 0) > 0)
      throw precondition("watch_gate_off", "The verified-watch gate is not enabled on this instance");
    if (deps.env.CHAT_SURGE_GUARD !== "on" && patch.surgeGuard?.enabled === true)
      throw precondition("surge_guard_off", "The surge guard is not enabled on this instance");
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
        const active = await liftChatBanInTx(tx, {
          channel: c,
          target,
          actor: { id: caller.user.id, actorType: "moderator" },
          now,
        });
        if (!active) throw notFound("This user is not banned or timed out");
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
    list: os.chat.held.list.handler(async ({ context }) => listHeld(context.deps, requireChannel(context))),

    resolve: os.chat.held.resolve.handler(async ({ context, input }) => {
      const caller = requireCaller(context);
      await resolveHeld(context.deps, {
        channel: requireChannel(context),
        messageId: input.id,
        allow: input.allow,
        moderatorId: caller.user.id,
      });
      return { ok: true as const };
    }),
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
      try {
        const row = await deps.db.transaction(async (tx) => {
          // Match NCII removal's lock so an upload cannot be reattached after its tombstone.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.imageKey}, 0))`);
          const [revoked] = await tx
            .select({ id: schema.nciiRequestItems.id })
            .from(schema.nciiRequestItems)
            .where(
              sql`${schema.nciiRequestItems.uploadKey} = ${input.imageKey} and ${schema.nciiRequestItems.removedAt} is not null`,
            )
            .limit(1);
          if (revoked) throw badRequest("Upload the emote image first (purpose: emote)");
          const [{ n } = { n: 0 }] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(emotes)
            .where(eq(emotes.channelId, c.id));
          if (Number(n) >= MAX_EMOTES) throw badRequest(`At most ${MAX_EMOTES} emotes per channel`);
          const [created] = await tx
            .insert(emotes)
            .values({
              channelId: c.id,
              code: input.code,
              imageKey: input.imageKey,
              tier: input.tier,
              animated: input.imageKey.endsWith(".gif"),
            })
            .returning();
          return created;
        });
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
    const { token, exp } = await chatTokenFor(deps, caller, CHAT_TOKEN_TTL_SECONDS);
    return { token, url: deps.env.CHAT_PUBLIC_URL, expiresAt: iso(new Date(exp * 1000)) };
  }),

  surge: chatSurge,
};

/** Whether `id` is a stored, undeleted message of `channelId` (one primary-key lookup). */
async function liveMessageExists(deps: Pick<Deps, "db">, channelId: string, id: string): Promise<boolean> {
  const [row] = await deps.db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(and(eq(chatMessages.id, id), eq(chatMessages.channelId, channelId), isNull(chatMessages.deletedAt)))
    .limit(1);
  return row !== undefined;
}

/** Relay one request to the chat service as `caller`. */
async function relay(deps: Deps, caller: Caller, request: RelayRequest) {
  const { token } = await chatTokenFor(deps, caller, RELAY_TOKEN_TTL_SECONDS);
  return relayToChat({ url: deps.env.CHAT_INTERNAL_URL, token, request });
}
