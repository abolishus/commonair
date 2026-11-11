// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `chat.bans.bulk` (overhaul wave 4, J5-d): a moderator times out every sender of a message wave.
 * The owner, staff and the channel's moderators and editors are skipped, so are senders already
 * banned or timed out for longer, and senders seen only in another channel; unknown ids are
 * ignored. One audit row and one outbox row per target, never a permanent ban, and "Delete all"
 * writes the chat service's delete rows for each message.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BUS } from "@commonair/contracts/events";
import { schema, uuidv7 } from "@commonair/db";
import { client, signUpAndSignIn, startApi, subscriber, waitFor, type TestApi } from "./harness.ts";

type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface BulkResult {
  timedOut: { userId: string; username: string; expiresAt: string }[];
  skipped: { userId: string; reason: string }[];
  deletedMessages: number;
}

let api: TestApi;
const db = () => api.db.db;
const people = async (n: number): Promise<User[]> => Promise.all(Array.from({ length: n }, () => signUpAndSignIn(api)));

beforeAll(async () => {
  api = await startApi();
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

async function channelOf(owner: User) {
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.ownerId, owner.userId));
  if (!c) throw new Error("no channel");
  return c;
}

async function grant(owner: User, to: User, role: "moderator" | "editor") {
  const res = await owner.client.call("PUT", `/api/channels/${owner.username}/roles/${to.username}`, { role });
  expect(res.status).toBe(200);
}

/** One message per sender, in order, with the same body (a wave). */
async function wave(channelId: string, senders: User[]): Promise<string[]> {
  const body = `wave ${crypto.randomUUID().slice(0, 8)}`;
  const rows = senders.map((s) => ({ id: uuidv7(), channelId, userId: s.userId, body }));
  await db().insert(schema.chatMessages).values(rows);
  return rows.map((r) => r.id);
}

const bulk = (who: User, owner: User, body: Record<string, unknown>) =>
  who.client.call<BulkResult>("POST", `/api/channels/${owner.username}/bans/bulk`, {
    durationSeconds: 600,
    ...body,
  });

async function actionRows(channelId: string, action: string) {
  return db()
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.channelId, channelId), eq(schema.auditLog.action, action)));
}

async function eventRows(channelId: string, type: string) {
  return db()
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.channelId, channelId), eq(schema.events.type, type)));
}

describe("chat.bans.bulk", () => {
  test("signed out is refused; a viewer without a channel role is refused", async () => {
    const [owner, viewer, spammer] = await people(3);
    if (!owner || !viewer || !spammer) throw new Error("signup");
    const ids = await wave((await channelOf(owner)).id, [spammer, spammer]);
    const anon = await client(api).call("POST", `/api/channels/${owner.username}/bans/bulk`, {
      messageIds: ids,
      durationSeconds: 600,
    });
    expect(anon.status).toBe(401);
    expect((await bulk(viewer, owner, { messageIds: ids })).status).toBe(403);
    expect(await db().select().from(schema.chatBans).where(eq(schema.chatBans.userId, spammer.userId))).toEqual([]);
  });

  test("a mixed wave: targets timed out once each, every skip named, one audit and outbox row per target", async () => {
    const [owner, mod, editor, admin, s1, s2, banned, longer, shorter, elsewhere] = await people(10);
    if (!owner || !mod || !editor || !admin || !s1 || !s2 || !banned || !longer || !shorter || !elsewhere)
      throw new Error("signup");
    const c = await channelOf(owner);
    const other = await channelOf(elsewhere);
    await grant(owner, mod, "moderator");
    await grant(owner, editor, "editor");
    await db().update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, admin.userId));
    const now = Date.now();
    await db()
      .insert(schema.chatBans)
      .values([
        { channelId: c.id, userId: banned.userId, moderatorId: owner.userId, expiresAt: null },
        { channelId: c.id, userId: longer.userId, moderatorId: owner.userId, expiresAt: new Date(now + 86_400_000) },
        { channelId: c.id, userId: shorter.userId, moderatorId: owner.userId, expiresAt: new Date(now + 60_000) },
      ]);
    const ids = [
      ...(await wave(c.id, [s1, s2, s1, owner, mod, editor, admin, banned, longer, shorter])),
      // A message from another channel, and an id nobody wrote.
      ...(await wave(other.id, [elsewhere])),
      uuidv7(),
    ];

    const res = await bulk(mod, owner, { messageIds: ids, reason: "raid" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const targets = [s1, s2, shorter].map((u) => u.userId);
    expect(res.body.timedOut.map((t) => t.userId)).toEqual(targets);
    expect(res.body.timedOut[0]).toMatchObject({ username: s1.username });
    expect(res.body.skipped).toEqual([
      { userId: owner.userId, reason: "owner" },
      { userId: mod.userId, reason: "moderator" },
      { userId: editor.userId, reason: "moderator" },
      { userId: admin.userId, reason: "staff" },
      { userId: banned.userId, reason: "already_banned" },
      { userId: longer.userId, reason: "already_banned" },
      { userId: elsewhere.userId, reason: "not_in_channel" },
    ]);
    expect(res.body.deletedMessages).toBe(0);

    const active = await db()
      .select()
      .from(schema.chatBans)
      .where(and(eq(schema.chatBans.channelId, c.id), isNull(schema.chatBans.liftedAt)));
    const byUser = new Map(active.map((b) => [b.userId, b]));
    for (const id of targets) {
      const b = byUser.get(id);
      // Never a ban: every new row is a 10 minute timeout by the moderator.
      expect(b?.expiresAt).not.toBeNull();
      expect(b?.moderatorId).toBe(mod.userId);
      expect(b?.reason).toBe("raid");
      expect(Math.abs((b?.expiresAt?.getTime() ?? 0) - (now + 600_000))).toBeLessThan(30_000);
    }
    // The ban and the longer timeout are untouched; the shorter timeout was replaced.
    expect(byUser.get(banned.userId)?.expiresAt).toBeNull();
    expect(byUser.get(longer.userId)?.moderatorId).toBe(owner.userId);
    const shorterRows = await db().select().from(schema.chatBans).where(eq(schema.chatBans.userId, shorter.userId));
    expect(shorterRows).toHaveLength(2);
    expect(shorterRows.filter((r) => r.liftedAt !== null)).toHaveLength(1);
    expect(await db().select().from(schema.chatBans).where(eq(schema.chatBans.userId, elsewhere.userId))).toEqual([]);

    const audits = await actionRows(c.id, "chat.timeout");
    expect(audits.map((a) => a.subjectId).toSorted()).toEqual(targets.toSorted());
    for (const a of audits) {
      expect(a).toMatchObject({ actorType: "moderator", actorId: mod.userId, subjectType: "user", reason: "raid" });
      expect(a.details).toMatchObject({ durationSeconds: 600, bulk: true });
    }
    const outbox = await eventRows(c.id, "channel.ban");
    expect(outbox.map((e) => (e.payload as { user_id: string }).user_id).toSorted()).toEqual(targets.toSorted());
    for (const e of outbox) expect(e.payload).toMatchObject({ is_permanent: false, moderator_user_id: mod.userId });
    const actions = await db()
      .select()
      .from(schema.modActions)
      .where(and(eq(schema.modActions.channelId, c.id), eq(schema.modActions.action, "timeout")));
    expect(actions.map((a) => a.targetUserId ?? "").toSorted()).toEqual(targets.toSorted());
    // Nothing was deleted without deleteMessages.
    const live = await db().select().from(schema.chatMessages).where(inArray(schema.chatMessages.id, ids));
    expect(live.every((m) => m.deletedAt === null)).toBe(true);
  });

  test("Delete all removes the targets' messages, keeps protected ones, and tells chat", async () => {
    const [owner, mod, s1, s2] = await people(4);
    if (!owner || !mod || !s1 || !s2) throw new Error("signup");
    const c = await channelOf(owner);
    await grant(owner, mod, "moderator");
    const ids = await wave(c.id, [s1, s2, s1, owner]);
    const sub = subscriber();
    const frames: { op: string; userId?: string; messageId?: string; expiresAt?: string | null }[] = [];
    await sub.subscribe(BUS.chatControl(c.id));
    sub.on("message", (_ch, raw) => frames.push(JSON.parse(raw) as (typeof frames)[number]));
    try {
      const res = await bulk(mod, owner, { messageIds: ids, durationSeconds: 3600, deleteMessages: true });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.deletedMessages).toBe(3);
      const rows = await db().select().from(schema.chatMessages).where(inArray(schema.chatMessages.id, ids));
      const deleted = rows.filter((m) => m.deletedAt !== null);
      expect(deleted.map((m) => m.id).toSorted()).toEqual(ids.slice(0, 3).toSorted());
      expect(deleted.every((m) => m.deletedBy === mod.userId)).toBe(true);
      expect(rows.find((m) => m.id === ids[3])?.deletedAt).toBeNull();

      const audits = await actionRows(c.id, "chat.delete_message");
      expect(audits.map((a) => a.subjectId).toSorted()).toEqual(ids.slice(0, 3).toSorted());
      expect((await eventRows(c.id, "channel.chat.message_delete")).length).toBe(3);
      expect((await actionRows(c.id, "chat.timeout")).length).toBe(2);
      expect((await eventRows(c.id, "channel.ban")).length).toBe(2);

      const seen = await waitFor(async () => {
        const bans = frames.filter((f) => f.op === "ban");
        const dels = frames.filter((f) => f.op === "delete");
        return bans.length >= 2 && dels.length >= 3 ? { bans, dels } : null;
      });
      expect(seen.bans.map((f) => f.userId ?? "").toSorted()).toEqual([s1.userId, s2.userId].toSorted());
      expect(seen.bans.every((f) => typeof f.expiresAt === "string")).toBe(true);
      expect(seen.dels.map((f) => f.messageId ?? "").toSorted()).toEqual(ids.slice(0, 3).toSorted());

      // Again, shorter: the senders are already timed out for longer, so nothing is written twice.
      const again = await bulk(mod, owner, { messageIds: ids, durationSeconds: 60, deleteMessages: true });
      expect(again.status).toBe(200);
      expect(again.body.timedOut).toEqual([]);
      expect(again.body.deletedMessages).toBe(0);
      expect(again.body.skipped.filter((s) => s.reason === "already_banned").map((s) => s.userId)).toEqual([
        s1.userId,
        s2.userId,
      ]);
      expect((await actionRows(c.id, "chat.timeout")).length).toBe(2);
    } finally {
      await sub.quit();
    }
  });

  test("the owner may run it too", async () => {
    const [owner, s1] = await people(2);
    if (!owner || !s1) throw new Error("signup");
    const ids = await wave((await channelOf(owner)).id, [s1, s1]);
    const res = await bulk(owner, owner, { messageIds: ids, durationSeconds: 3600 });
    expect(res.status).toBe(200);
    expect(res.body.timedOut.map((t) => t.userId)).toEqual([s1.userId]);
  });

  test("a wave with no message in this channel is BAD_REQUEST; nothing is written", async () => {
    const [owner, mod, other, s1] = await people(4);
    if (!owner || !mod || !other || !s1) throw new Error("signup");
    await grant(owner, mod, "moderator");
    const foreign = await wave((await channelOf(other)).id, [s1, s1]);
    expect((await bulk(mod, owner, { messageIds: foreign })).status).toBe(400);
    expect((await bulk(mod, owner, { messageIds: [uuidv7()] })).status).toBe(400);
    expect(await db().select().from(schema.chatBans).where(eq(schema.chatBans.userId, s1.userId))).toEqual([]);
  });

  test("capped at the wave size, and only the contract's timeout lengths", async () => {
    const [owner, mod, s1] = await people(3);
    if (!owner || !mod || !s1) throw new Error("signup");
    await grant(owner, mod, "moderator");
    const c = await channelOf(owner);
    const fifty = await wave(
      c.id,
      Array.from({ length: 50 }, () => s1),
    );
    expect((await bulk(mod, owner, { messageIds: [...fifty, uuidv7()] })).status).toBe(400);
    expect((await bulk(mod, owner, { messageIds: [] })).status).toBe(400);
    expect((await bulk(mod, owner, { messageIds: fifty, durationSeconds: 120 })).status).toBe(400);
    const ok = await bulk(mod, owner, { messageIds: fifty, durationSeconds: 86_400 });
    expect(ok.status).toBe(200);
    expect(ok.body.timedOut).toHaveLength(1);
  });
});
