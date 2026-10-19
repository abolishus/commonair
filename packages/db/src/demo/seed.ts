// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Demo seed: inserts the accounts and activity in data.ts straight into Postgres, in one
 * transaction. Rows look like what the API writes (better-auth credential accounts, hashed
 * stream keys, mod_actions plus audit rows for moderation) so the web app and the API treat them
 * like any other data. It creates no money, co-op, ledger, governance or relay rows, and no
 * `events` outbox rows: demo data must not fan out to webhooks or EventSub subscribers.
 */
import { createHash, randomBytes } from "node:crypto";
import { count, eq, inArray } from "drizzle-orm";
import type { Database, Executor } from "../client.ts";
import { uuidv7 } from "../ids.ts";
import { accounts, users } from "../schema/auth.ts";
import { categories, channelRoles, channels, follows, streamKeys } from "../schema/channels.ts";
import { chatBans, chatMessages } from "../schema/chat.ts";
import { broadcasts } from "../schema/media.ts";
import { auditLog, modActions } from "../schema/safety.ts";
import { anchoredUser, demoIdentity } from "./anchors.ts";
import { clearDemoRows, type ClearReport } from "./clear.ts";
import {
  DEMO_BOT,
  DEMO_CATEGORIES,
  DEMO_CHAT,
  DEMO_FOLLOWS,
  DEMO_MODERATION,
  DEMO_MODERATORS,
  DEMO_STREAMERS,
  DEMO_VIEWERS,
} from "./data.ts";
import { hashPassword, passwordProblem } from "./password.ts";

export interface SeededAccount {
  id: string;
  username: string;
  email: string;
  displayName: string;
  role: "streamer" | "viewer" | "bot";
}

export interface SeedSummary {
  accounts: SeededAccount[];
  channels: number;
  follows: number;
  chatMessages: number;
  broadcasts: number;
  bans: number;
  streamKeys: number;
}

export type SeedResult =
  | { status: "seeded"; summary: SeedSummary; cleared: ClearReport | null }
  | { status: "exists"; existing: number };

/** Number of users that already carry both demo anchors. */
export async function countAnchoredUsers(db: Executor): Promise<number> {
  const [row] = await db.select({ n: count() }).from(users).where(anchoredUser());
  return row?.n ?? 0;
}

/**
 * Seed demo data in one transaction. With existing demo users it does nothing (status `exists`)
 * unless `reset`, which clears them first in the same transaction.
 */
export async function seedDemo(
  db: Database,
  opts: { password: string; reset?: boolean; now?: Date },
): Promise<SeedResult> {
  const problem = passwordProblem(opts.password);
  if (problem) throw new Error(`demo password ${problem}`);
  return db.transaction(async (tx) => {
    const existing = await countAnchoredUsers(tx);
    if (existing > 0 && !opts.reset) return { status: "exists", existing } as const;
    const cleared = existing > 0 ? await clearDemoRows(tx) : null;
    const summary = await seedDemoRows(tx, { password: opts.password, now: opts.now ?? new Date() });
    return { status: "seeded", summary, cleared } as const;
  });
}

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const minutes = (n: number) => n * 60_000;
const hours = (n: number) => n * 3_600_000;

/** Insert every demo row with `tx`. Callers own the transaction and the "already seeded" check. */
export async function seedDemoRows(tx: Executor, opts: { password: string; now: Date }): Promise<SeedSummary> {
  const now = opts.now.getTime();
  const at = (ms: number) => new Date(ms);
  const seeded: SeededAccount[] = [];
  const ids = new Map<string, string>();
  const idOf = (handle: string) => {
    const id = ids.get(handle);
    if (!id) throw new Error(`demo data references unknown handle ${handle}`);
    return id;
  };

  // Accounts were "created" a few weeks ago so the profiles do not look brand new.
  const people = [
    ...DEMO_STREAMERS.map((s) => ({ ...s, role: "streamer" as const })),
    ...DEMO_VIEWERS.map((v) => ({ ...v, role: "viewer" as const })),
  ];
  for (const [i, p] of people.entries()) {
    const { username, email } = demoIdentity(p.handle);
    const createdAt = at(now - hours(24 * 30) + hours(i));
    const id = uuidv7(createdAt.getTime());
    ids.set(p.handle, id);
    await tx.insert(users).values({
      id,
      name: p.displayName,
      email,
      emailVerified: true,
      username,
      displayUsername: username,
      birthDate: p.birthDate,
      accountType: "human",
      role: "user",
      createdAt,
      updatedAt: createdAt,
    });
    // better-auth's email/password account: providerId "credential", accountId = user id.
    await tx.insert(accounts).values({
      userId: id,
      accountId: id,
      providerId: "credential",
      password: await hashPassword(opts.password),
      createdAt,
      updatedAt: createdAt,
    });
    seeded.push({ id, username, email, displayName: p.displayName, role: p.role });
  }

  // The bot, as `me.bots.create` makes it (no credential account: bots use tokens), but with both
  // demo anchors so `demo:clear` matches it directly as well as through its owner.
  {
    const { username, email } = demoIdentity(DEMO_BOT.handle);
    const id = uuidv7(now - hours(24 * 20));
    ids.set(DEMO_BOT.handle, id);
    await tx.insert(users).values({
      id,
      name: DEMO_BOT.displayName,
      email,
      emailVerified: false,
      username,
      displayUsername: username,
      accountType: "bot",
      botOwnerId: idOf(DEMO_BOT.owner),
      role: "user",
    });
    seeded.push({ id, username, email, displayName: DEMO_BOT.displayName, role: "bot" });
  }

  // Shared categories: reuse existing ones by slug.
  await tx
    .insert(categories)
    .values(DEMO_CATEGORIES.map((c) => ({ slug: c.slug, name: c.name })))
    .onConflictDoNothing({ target: categories.slug });
  const categoryRows = await tx
    .select({ id: categories.id, slug: categories.slug })
    .from(categories)
    .where(
      inArray(
        categories.slug,
        DEMO_CATEGORIES.map((c) => c.slug),
      ),
    );
  const categoryId = new Map(categoryRows.map((c) => [c.slug, c.id]));

  // Channels (slug = username), each with past broadcasts and one active stream key.
  const channelId = new Map<string, string>();
  const latestBroadcast = new Map<string, { id: string; startedAt: number; endedAt: number }>();
  let broadcastCount = 0;
  for (const s of DEMO_STREAMERS) {
    const ownerId = idOf(s.handle);
    const { username } = demoIdentity(s.handle);
    const cid = uuidv7();
    channelId.set(s.handle, cid);
    const catId = categoryId.get(s.channel.category) ?? null;
    await tx.insert(channels).values({
      id: cid,
      ownerId,
      slug: username,
      displayName: s.displayName,
      title: s.channel.title,
      description: s.channel.description,
      categoryId: catId,
      tags: s.channel.tags,
      language: s.channel.language,
    });
    for (const h of s.history) {
      const startedAt = now - hours(h.startedHoursAgo);
      const endedAt = startedAt + minutes(h.durationMinutes);
      const bid = uuidv7(startedAt);
      await tx.insert(broadcasts).values({
        id: bid,
        channelId: cid,
        ingestProtocol: "rtmp",
        path: `live/${username}`,
        title: h.title,
        categoryId: catId,
        startedAt: at(startedAt),
        endedAt: at(endedAt),
        peakVerifiedViewers: h.peakViewers,
        verifiedViewerSeconds: Math.round(h.peakViewers * 0.6 * h.durationMinutes * 60),
        createdAt: at(startedAt),
      });
      broadcastCount++;
      const latest = latestBroadcast.get(s.handle);
      if (!latest || latest.startedAt < startedAt) latestBroadcast.set(s.handle, { id: bid, startedAt, endedAt });
    }
    // Hashed like `stream.rotateKey`; the secret is discarded (rotate it in the dashboard to stream).
    const secret = `live_${randomBytes(32).toString("base64url")}`;
    const keyId = uuidv7();
    await tx
      .insert(streamKeys)
      .values({ id: keyId, channelId: cid, keyHash: sha256Hex(secret), prefix: secret.slice(0, 12) });
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: ownerId,
      action: "stream_key.rotate",
      subjectType: "stream_key",
      subjectId: keyId,
      channelId: cid,
      details: { revoked: [] },
    });
  }
  const channelOf = (handle: string) => {
    const id = channelId.get(handle);
    if (!id) throw new Error(`demo data references unknown channel ${handle}`);
    return id;
  };

  // Follows, and the follower counts the API maintains alongside them.
  const followRows = Object.entries(DEMO_FOLLOWS).flatMap(([follower, targets]) =>
    targets.map((t, i) => ({
      followerId: idOf(follower),
      channelId: channelOf(t),
      createdAt: at(now - hours(24 * 14) + hours(i * 5)),
    })),
  );
  await tx.insert(follows).values(followRows);
  for (const cid of channelId.values()) {
    const n = followRows.filter((f) => f.channelId === cid).length;
    await tx.update(channels).set({ followerCount: n }).where(eq(channels.id, cid));
  }

  // Moderators, as `channels.roles.add` records them.
  for (const m of DEMO_MODERATORS) {
    const cid = channelOf(m.channel);
    const owner = idOf(m.channel);
    const target = idOf(m.user);
    await tx.insert(channelRoles).values({ channelId: cid, userId: target, role: "moderator", grantedBy: owner });
    await tx.insert(modActions).values({
      scope: "channel",
      channelId: cid,
      moderatorId: owner,
      targetUserId: target,
      action: "add_moderator",
    });
    await tx.insert(auditLog).values({
      actorType: "user",
      actorId: owner,
      action: "channel.role.add",
      subjectType: "user",
      subjectId: target,
      channelId: cid,
      details: { role: "moderator" },
    });
  }

  // Chat, spread through each channel's latest broadcast.
  const byChannel = new Map<string, typeof DEMO_CHAT>();
  for (const line of DEMO_CHAT) byChannel.set(line.channel, [...(byChannel.get(line.channel) ?? []), line]);
  const messageRows: (typeof chatMessages.$inferInsert)[] = [];
  for (const [channel, lines] of byChannel) {
    const b = latestBroadcast.get(channel);
    if (!b) throw new Error(`demo channel ${channel} has no broadcast for its chat`);
    const step = (b.endedAt - b.startedAt - minutes(4)) / Math.max(1, lines.length);
    lines.forEach((line, i) => {
      const createdAt = b.startedAt + minutes(2) + Math.round(step * i);
      messageRows.push({
        id: uuidv7(createdAt),
        channelId: channelOf(channel),
        broadcastId: b.id,
        userId: idOf(line.author),
        body: line.body,
        isAction: line.isAction ?? false,
        createdAt: at(createdAt),
      });
    });
  }
  await tx.insert(chatMessages).values(messageRows);

  // Moderation example: rows as `chat.bans.ban` writes them (ban, mod_action, audit with ids only).
  const moderation = [
    { ...DEMO_MODERATION.timeout, expiresAt: at(now + DEMO_MODERATION.timeout.durationSeconds * 1000) },
    { ...DEMO_MODERATION.ban, durationSeconds: null, expiresAt: null },
  ];
  for (const m of moderation) {
    const cid = channelOf(m.channel);
    const moderatorId = idOf(m.moderator);
    const target = idOf(m.target);
    const banId = uuidv7();
    await tx.insert(chatBans).values({
      id: banId,
      channelId: cid,
      userId: target,
      moderatorId,
      reason: "",
      expiresAt: m.expiresAt,
      createdAt: at(now),
    });
    await tx.insert(modActions).values({
      scope: "channel",
      channelId: cid,
      moderatorId,
      targetUserId: target,
      action: m.expiresAt ? "timeout" : "ban",
      durationSeconds: m.durationSeconds,
    });
    await tx.insert(auditLog).values({
      actorType: "moderator",
      actorId: moderatorId,
      action: m.expiresAt ? "chat.timeout" : "chat.ban",
      subjectType: "user",
      subjectId: target,
      channelId: cid,
      details: { banId, durationSeconds: m.durationSeconds },
    });
  }

  return {
    accounts: seeded,
    channels: channelId.size,
    follows: followRows.length,
    chatMessages: messageRows.length,
    broadcasts: broadcastCount,
    bans: moderation.length,
    streamKeys: channelId.size,
  };
}
