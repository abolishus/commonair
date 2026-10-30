// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, count, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Scope } from "@commonair/contracts/scopes";
import { schema, type Executor } from "@commonair/db";
import { randomTokenSecret, sha256Hex } from "@commonair/tokens";
import { isAdult, usernameProblem } from "../auth/identity.ts";
import { insertBotAccount } from "../auth/bot-account.ts";
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
import { badRequest, conflict, forbidden, isUniqueViolation, notFound, precondition } from "../lib/errors.ts";
import { pendingDocuments, recordAcceptances } from "../lib/legal.ts";
import { os, requireCaller } from "../lib/orpc.ts";
import { audit } from "../events/audit.ts";
import {
  currentDeletion,
  DELETION_GRACE_DAYS,
  lockUser,
  scheduledDeletion,
  toDeletion,
} from "../moderation/deletion.ts";
import { restrictedIds, withRestriction } from "../moderation/restriction.ts";
import { appUrl, sendNotice } from "../mail.ts";
import { createExport, listExports } from "../privacy/exports.ts";
import { meBlocks } from "./me-blocks.ts";
import { meEnforcement } from "./me-enforcement.ts";

const { users, channels, follows, memberships, notifications, oauthTokens, botConfigs } = schema;

const MAX_BOTS_PER_OWNER = 10;
export { BOT_EMAIL_DOMAIN } from "../auth/bot-account.ts";

export async function matureConfirmed(db: Executor, userId: string): Promise<boolean> {
  const [row] = await db.select({ at: users.matureConfirmedAt }).from(users).where(eq(users.id, userId)).limit(1);
  return row !== undefined && row.at !== null;
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
    locale: u.locale,
    memberships: member.map((m) => ({ class: m.class, since: iso(m.since) })),
    pendingLegal: pending.map((p) => ({ kind: p.kind, version: p.version })),
    channelSlug: channel[0]?.slug ?? null,
  };
}

/** After commit: tell the account's address when it will be deleted and how to cancel. */
async function sendDeletionScheduled(deps: Deps, userId: string, deleteAt: Date): Promise<void> {
  const [u] = await deps.db
    .select({ email: users.email, locale: users.locale, accountType: users.accountType })
    .from(users)
    .where(eq(users.id, userId));
  if (!u || u.accountType !== "human") return;
  await sendNotice(deps.logger, "accountDeletionScheduled", () =>
    deps.mailer.send(
      "accountDeletionScheduled",
      { deleteAt, cancelUrl: appUrl(deps.site, "/settings/privacy"), locale: u.locale },
      u.email,
    ),
  );
}

const toAccessToken = (t: typeof oauthTokens.$inferSelect, appName: string | null) => ({
  id: t.id,
  appId: t.appId,
  appName,
  kind: t.kind,
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
    // The contract validates the tag; null clears the choice (ADR 0029).
    if (input.locale !== undefined) set.locale = input.locale;
    if (set.name === "") throw badRequest("Display name cannot be blank");
    if (Object.keys(set).length > 0) await context.deps.db.update(users).set(set).where(eq(users.id, caller.user.id));
    return loadMe(context.deps, caller.user.id);
  }),

  confirmMature: os.me.confirmMature.handler(async ({ context }) => {
    const caller = requireCaller(context);
    const { deps } = context;
    const [u] = await deps.db.select({ birthDate: users.birthDate }).from(users).where(eq(users.id, caller.user.id));
    if (!u || !isAdult(u.birthDate, deps.now())) throw precondition("adult", "Only adults can view mature streams");
    await deps.db
      .update(users)
      .set({ matureConfirmedAt: deps.now() })
      .where(and(eq(users.id, caller.user.id), isNull(users.matureConfirmedAt)));
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
    const restricted = await restrictedIds(
      deps.db,
      [...live.values()].map((l) => l.id),
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
        live: ((l) => (l ? withRestriction(l, restricted.has(l.id)) : null))(live.get(r.c.id)),
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

  labels: os.me.labels.handler(async ({ context }) => {
    const caller = requireCaller(context);
    const rows = await context.deps.db
      .select({ l: schema.contentLabels })
      .from(schema.contentLabels)
      .innerJoin(channels, eq(channels.id, schema.contentLabels.channelId))
      .where(and(eq(channels.ownerId, caller.user.id), isNull(schema.contentLabels.removedAt)))
      .orderBy(desc(schema.contentLabels.appliedAt));
    return rows.map(({ l }) => ({
      id: l.id,
      channelId: l.channelId,
      label: l.label,
      caseId: l.caseId,
      appliedAt: iso(l.appliedAt),
      removedAt: isoOrNull(l.removedAt),
    }));
  }),
  enforcement: meEnforcement,
  exports: {
    create: os.me.exports.create.handler(async ({ context, input }) => {
      const caller = requireCaller(context);
      return createExport(context.deps, caller.user.id, input.kind);
    }),
    list: os.me.exports.list.handler(async ({ context }) => {
      const caller = requireCaller(context);
      return listExports(context.deps, caller.user.id);
    }),
  },
  deletion: {
    request: os.me.deletion.request.handler(async ({ context, input }) => {
      const caller = requireCaller(context);
      const { deps } = context;
      if (input.confirmUsername.toLowerCase() !== caller.user.username.toLowerCase())
        throw badRequest("Type your username to confirm");
      const now = deps.now();
      let created = false;
      const row = await deps.db.transaction(async (tx) => {
        await lockUser(tx, caller.user.id);
        const existing = await scheduledDeletion(tx, caller.user.id);
        if (existing) return existing;
        created = true;
        const [d] = await tx
          .insert(schema.accountDeletions)
          .values({
            userId: caller.user.id,
            requestedAt: now,
            scheduledFor: new Date(now.getTime() + DELETION_GRACE_DAYS * 86_400_000),
          })
          .returning();
        if (!d) throw new Error("deletion insert returned no row");
        await audit(tx, {
          actorType: "user",
          actorId: caller.user.id,
          action: "account.deletion.request",
          subjectType: "user",
          subjectId: caller.user.id,
          details: { deletionId: d.id },
        });
        return d;
      });
      if (created) await sendDeletionScheduled(deps, caller.user.id, row.scheduledFor);
      return toDeletion(row);
    }),
    cancel: os.me.deletion.cancel.handler(async ({ context }) => {
      const caller = requireCaller(context);
      const { deps } = context;
      const now = deps.now();
      await deps.db.transaction(async (tx) => {
        await lockUser(tx, caller.user.id);
        const d = await scheduledDeletion(tx, caller.user.id);
        if (!d) throw notFound("No deletion is scheduled");
        // Once due, the worker may already be deleting: too late to cancel.
        if (d.scheduledFor.getTime() <= now.getTime()) throw conflict("This deletion is already under way");
        await tx
          .update(schema.accountDeletions)
          .set({ status: "canceled" })
          .where(and(eq(schema.accountDeletions.id, d.id), eq(schema.accountDeletions.status, "scheduled")));
        await audit(tx, {
          actorType: "user",
          actorId: caller.user.id,
          action: "account.deletion.cancel",
          subjectType: "user",
          subjectId: caller.user.id,
          details: { deletionId: d.id },
        });
      });
      return { ok: true as const };
    }),
    get: os.me.deletion.get.handler(async ({ context }) => {
      const caller = requireCaller(context);
      const d = await currentDeletion(context.deps.db, caller.user.id);
      return d ? toDeletion(d) : null;
    }),
  },

  bots: {
    create: os.me.bots.create.handler(async ({ context, input }) => {
      const caller = requireCaller(context);
      const { deps } = context;
      if (caller.user.accountType !== "human") throw forbidden("Only members can own bots");
      const problem = usernameProblem(input.username);
      if (problem) throw badRequest(problem === "reserved" ? "This username is reserved" : "Invalid username");
      // A channel's built-in bot (E8) never takes one of the owner's slots.
      const [{ n } = { n: 0 }] = await deps.db
        .select({ n: count() })
        .from(users)
        .where(
          and(
            eq(users.botOwnerId, caller.user.id),
            isNull(users.deletedAt),
            sql`not exists (select 1 from ${botConfigs} where ${botConfigs.botUserId} = ${users.id})`,
          ),
        );
      if (n >= MAX_BOTS_PER_OWNER) throw precondition("bot_limit", `You can own at most ${MAX_BOTS_PER_OWNER} bots`);
      try {
        const bot = await insertBotAccount(deps.db, {
          ownerId: caller.user.id,
          username: input.username,
          displayName: input.displayName,
        });
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
        .where(
          and(
            eq(users.botOwnerId, caller.user.id),
            isNull(users.deletedAt),
            // The channel bot (E8) is managed from the channel's bot settings, not as a developer bot.
            sql`not exists (select 1 from ${botConfigs} where ${botConfigs.botUserId} = ${users.id})`,
          ),
        )
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
      // The channel bot speaks only through the bot engine: a token would let whoever holds it
      // speak and moderate as the channel's moderator bot.
      const [channelBot] = await deps.db
        .select({ channelId: botConfigs.channelId })
        .from(botConfigs)
        .where(eq(botConfigs.botUserId, bot.id))
        .limit(1);
      if (channelBot) throw precondition("channel_bot", "The channel bot cannot have tokens");
      // Lowercase: tmi.js and other Twitch-style IRC clients lowercase the token they send.
      const accessToken = randomTokenSecret("ca_");
      const [token] = await deps.db
        .insert(oauthTokens)
        .values({
          appId: null,
          userId: bot.id,
          kind: "personal",
          scopes: [...new Set(input.scopes)],
          accessTokenHash: await sha256Hex(accessToken),
          expiresAt: new Date(deps.now().getTime() + input.expiresInDays * 86_400_000),
        })
        .returning();
      if (!token) throw new Error("token insert returned no row");
      return { token: toAccessToken(token, null), accessToken };
    }),
  },
  blocks: meBlocks,
};
