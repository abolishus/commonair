// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, count, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Scope } from "@commonair/contracts/scopes";
import { schema, uuidv7, type Executor } from "@commonair/db";
import { randomSecret, sha256Hex } from "@commonair/tokens";
import { isAdult, usernameProblem } from "../auth/identity.ts";
import type { Deps } from "../deps.ts";
import {
  channelAvatar,
  channelTheme,
  iso,
  isoOrNull,
  liveSummaries,
  loadUsersPublic,
  toUserPublic,
} from "../lib/dto.ts";
import { encodeCursor, decodeCursor, isKeyCursor, pageOf } from "../lib/cursor.ts";
import { badRequest, conflict, forbidden, isUniqueViolation, notFound, notImplemented, precondition } from "../lib/errors.ts";
import { pendingDocuments, recordAcceptances } from "../lib/legal.ts";
import { os, requireCaller } from "../lib/orpc.ts";

const { users, channels, follows, memberships, notifications, consentRecords, oauthTokens } = schema;

/**
 * CONTRACT-REQUEST: users needs a `matureConfirmedAt timestamptz` column. Until then the
 * confirmation is a durable consent record with this policy version.
 */
export const MATURE_POLICY = "mature-confirmation-v1";
const MAX_BOTS_PER_OWNER = 10;
export const BOT_EMAIL_DOMAIN = "bots.invalid";

export async function matureConfirmed(db: Executor, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: consentRecords.id })
    .from(consentRecords)
    .where(
      and(
        eq(consentRecords.userId, userId),
        eq(consentRecords.policyVersion, MATURE_POLICY),
        sql`(${consentRecords.choices} ->> 'matureContent') = 'true'`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Signed-in adult who confirmed 18+: the gate for mature streams. */
export async function confirmedAdult(deps: Deps, userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  const [u] = await deps.db.select({ birthDate: users.birthDate }).from(users).where(eq(users.id, userId));
  if (!u || !isAdult(u.birthDate, deps.now())) return false;
  return matureConfirmed(deps.db, userId);
}

async function loadMe(deps: Deps, userId: string) {
  const [u] = await deps.db.select().from(users).where(eq(users.id, userId));
  if (!u) throw notFound("User not found");
  const now = deps.now();
  const [pub, member, pending, channel, mature] = await Promise.all([
    loadUsersPublic(deps, [u.id]),
    deps.db
      .select({ class: memberships.class, since: memberships.joinedAt })
      .from(memberships)
      .where(and(eq(memberships.userId, u.id), eq(memberships.status, "active"))),
    pendingDocuments(deps.db, u.id, now),
    deps.db.select({ slug: channels.slug }).from(channels).where(eq(channels.ownerId, u.id)),
    matureConfirmed(deps.db, u.id),
  ]);
  const adult = isAdult(u.birthDate, now);
  return {
    ...(pub.get(u.id) ?? toUserPublic(deps, u, null)),
    email: u.email,
    emailVerified: u.emailVerified,
    twoFactorEnabled: u.twoFactorEnabled,
    role: u.role,
    isAdult: adult,
    matureConfirmed: adult && mature,
    shareEmailWithFollowedChannels: u.shareEmailWithFollowedChannels,
    memberships: member.map((m) => ({ class: m.class, since: iso(m.since) })),
    pendingLegal: pending.map((p) => ({ kind: p.kind, version: p.version })),
    channelSlug: channel[0]?.slug ?? null,
  };
}

const toAccessToken = (t: typeof oauthTokens.$inferSelect, appName: string | null) => ({
  id: t.id,
  appName,
  scopes: t.scopes as Scope[],
  createdAt: iso(t.createdAt),
  expiresAt: iso(t.expiresAt),
  lastUsedAt: isoOrNull(t.lastUsedAt),
});

export const me = {
  get: os.me.get.handler(async ({ context }) => {
    const caller = requireCaller(context);
    // The email is personal data: tokens need the explicit scope for it.
    if (caller.kind === "token" && !caller.scopes.includes("user:read:email"))
      throw forbidden("Token is missing scopes: user:read:email");
    return loadMe(context.deps, caller.user.id);
  }),

  update: os.me.update.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const set: Partial<typeof users.$inferInsert> = {};
    if (input.displayName !== undefined) set.name = input.displayName.trim();
    if (input.shareEmailWithFollowedChannels !== undefined)
      set.shareEmailWithFollowedChannels = input.shareEmailWithFollowedChannels;
    if (input.locale !== undefined) {
      if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$/.test(input.locale)) throw badRequest("Invalid locale");
      set.locale = input.locale;
    }
    if (set.name === "") throw badRequest("Display name cannot be blank");
    if (Object.keys(set).length > 0) await context.deps.db.update(users).set(set).where(eq(users.id, caller.user.id));
    return loadMe(context.deps, caller.user.id);
  }),

  confirmMature: os.me.confirmMature.handler(async ({ context }) => {
    const caller = requireCaller(context);
    const { deps } = context;
    const [u] = await deps.db.select({ birthDate: users.birthDate }).from(users).where(eq(users.id, caller.user.id));
    if (!u || !isAdult(u.birthDate, deps.now())) throw precondition("adult", "Only adults can view mature streams");
    if (!(await matureConfirmed(deps.db, caller.user.id)))
      await deps.db
        .insert(consentRecords)
        .values({ userId: caller.user.id, choices: { matureContent: true }, policyVersion: MATURE_POLICY });
    return { ok: true as const };
  }),

  acceptLegal: os.me.acceptLegal.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const r = await recordAcceptances(context.deps.db, caller.user.id, input.documentIds, context.deps.now());
    if (r.accepted.length === 0) throw notFound("None of these documents is a current version");
    return { ok: true as const };
  }),

  follows: os.me.follows.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const { deps } = context;
    const cur = decodeCursor(input.cursor, isKeyCursor);
    const rows = await deps.db
      .select({ f: follows, c: channels, ownerImage: users.image })
      .from(follows)
      .innerJoin(channels, eq(channels.id, follows.channelId))
      .innerJoin(users, eq(users.id, channels.ownerId))
      .where(
        and(
          eq(follows.followerId, caller.user.id),
          cur
            ? or(
                lt(follows.createdAt, new Date(cur.t)),
                and(eq(follows.createdAt, new Date(cur.t)), lt(follows.channelId, cur.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(follows.createdAt), desc(follows.channelId))
      .limit(input.limit + 1);
    const live = await liveSummaries(
      deps,
      rows.map((r) => r.c),
    );
    return pageOf(
      rows,
      input.limit,
      (r) => ({
        channel: {
          id: r.c.id,
          slug: r.c.slug,
          displayName: r.c.displayName,
          avatarUrl: channelAvatar(deps, r.c, r.ownerImage),
          accent: channelTheme(r.c).accent,
        },
        live: live.get(r.c.id) ?? null,
        followedAt: iso(r.f.createdAt),
        notify: r.f.notify,
      }),
      (last) => encodeCursor({ t: iso(last.f.createdAt), id: last.c.id }),
    );
  }),

  notifications: os.me.notifications.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const cur = decodeCursor(input.cursor, isKeyCursor);
    const rows = await context.deps.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, caller.user.id),
          input.unreadOnly ? isNull(notifications.readAt) : undefined,
          cur
            ? or(
                lt(notifications.createdAt, new Date(cur.t)),
                and(eq(notifications.createdAt, new Date(cur.t)), lt(notifications.id, cur.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(input.limit + 1);
    return pageOf(
      rows,
      input.limit,
      (n) => ({ id: n.id, type: n.type, payload: n.payload, readAt: isoOrNull(n.readAt), createdAt: iso(n.createdAt) }),
      (last) => encodeCursor({ t: iso(last.createdAt), id: last.id }),
    );
  }),

  markNotificationsRead: os.me.markNotificationsRead.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    if (input.ids?.length === 0) return { ok: true as const };
    await context.deps.db
      .update(notifications)
      .set({ readAt: context.deps.now() })
      .where(
        and(
          eq(notifications.userId, caller.user.id),
          isNull(notifications.readAt),
          input.ids ? inArray(notifications.id, input.ids) : undefined,
        ),
      );
    return { ok: true as const };
  }),

  exports: {
    create: os.me.exports.create.handler(notImplemented),
    list: os.me.exports.list.handler(notImplemented),
  },
  deletion: {
    request: os.me.deletion.request.handler(notImplemented),
    cancel: os.me.deletion.cancel.handler(notImplemented),
    get: os.me.deletion.get.handler(notImplemented),
  },

  bots: {
    create: os.me.bots.create.handler(async ({ context, input }) => {
      const caller = requireCaller(context);
      const { deps } = context;
      if (caller.user.accountType !== "human") throw forbidden("Only members can own bots");
      const problem = usernameProblem(input.username);
      if (problem) throw badRequest(problem === "reserved" ? "This username is reserved" : "Invalid username");
      const [{ n } = { n: 0 }] = await deps.db
        .select({ n: count() })
        .from(users)
        .where(and(eq(users.botOwnerId, caller.user.id), isNull(users.deletedAt)));
      if (n >= MAX_BOTS_PER_OWNER) throw precondition("bot_limit", `You can own at most ${MAX_BOTS_PER_OWNER} bots`);
      const id = uuidv7();
      try {
        const [bot] = await deps.db
          .insert(users)
          .values({
            id,
            name: input.displayName.trim() || input.username,
            username: input.username,
            displayUsername: input.username,
            // Bots never sign in with email; a reserved, undeliverable address keeps the column unique.
            email: `bot+${id}@${BOT_EMAIL_DOMAIN}`,
            emailVerified: false,
            accountType: "bot",
            botOwnerId: caller.user.id,
          })
          .returning();
        if (!bot) throw new Error("bot insert returned no row");
        return toUserPublic(deps, bot, { id: caller.user.id, username: caller.user.username });
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict("That username is taken");
        throw err;
      }
    }),

    list: os.me.bots.list.handler(async ({ context }) => {
      const caller = requireCaller(context);
      const rows = await context.deps.db
        .select()
        .from(users)
        .where(and(eq(users.botOwnerId, caller.user.id), isNull(users.deletedAt)))
        .orderBy(users.createdAt);
      return rows.map((b) => toUserPublic(context.deps, b, { id: caller.user.id, username: caller.user.username }));
    }),

    createToken: os.me.bots.createToken.handler(async ({ context, input }) => {
      const caller = requireCaller(context);
      const { deps } = context;
      const [bot] = await deps.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, input.botId), eq(users.botOwnerId, caller.user.id), isNull(users.deletedAt)));
      if (!bot) throw notFound("Bot not found");
      const accessToken = randomSecret("ca_");
      const [token] = await deps.db
        .insert(oauthTokens)
        .values({
          appId: null,
          userId: bot.id,
          scopes: [...new Set(input.scopes)],
          accessTokenHash: await sha256Hex(accessToken),
          expiresAt: new Date(deps.now().getTime() + input.expiresInDays * 86_400_000),
        })
        .returning();
      if (!token) throw new Error("token insert returned no row");
      return { token: toAccessToken(token, null), accessToken };
    }),
  },
};

