// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `message_set` reports (W1 contract step §3.3, Calm Chat's "Report wave"): every body is kept as
 * evidence, the messages must all exist in one channel, `messageIds` belongs to `message_set` only,
 * and resolving with `remove_content` deletes every message and tells live chat. A wave has
 * several senders, so it is never a suspension or channel-ban target.
 */
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BUS } from "@commonair/contracts/events";
import { schema, uuidv7 } from "@commonair/db";
import { signUpAndSignIn, startApi, subscriber, waitFor, type TestApi } from "./harness.ts";

type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface ReportDto {
  id: string;
  status: string;
}

let api: TestApi;
let alice: User;
let bob: User;
let carol: User;
let staff: User;
let aliceChannel: string;
let bobChannel: string;
const db = () => api.db.db;

beforeAll(async () => {
  api = await startApi();
  [alice, bob, carol, staff] = await Promise.all([
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
  ]);
  await db().update(schema.users).set({ role: "moderator" }).where(eq(schema.users.id, staff.userId));
  const channelOf = async (ownerId: string) => {
    const [c] = await db().select().from(schema.channels).where(eq(schema.channels.ownerId, ownerId));
    return c!.id;
  };
  [aliceChannel, bobChannel] = await Promise.all([channelOf(alice.userId), channelOf(bob.userId)]);
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

/** Messages in a channel, from alternating senders. */
async function messages(channelId: string, senders: User[], n: number): Promise<string[]> {
  const rows = Array.from({ length: n }, (_, i) => ({
    id: uuidv7(),
    channelId,
    userId: senders[i % senders.length]!.userId,
    body: `wave line ${i} ${crypto.randomUUID().slice(0, 8)}`,
  }));
  await db().insert(schema.chatMessages).values(rows);
  return rows.map((r) => r.id);
}

const report = (who: User, body: Record<string, unknown>) =>
  who.client.call<{ id: string }>("POST", "/api/reports", { reason: "harassment", details: "", ...body });
const wave = (ids: string[]) => ({ subjectType: "message_set", subjectId: ids[0], messageIds: ids });
const resolve = (id: string, action: string) =>
  staff.client.call<ReportDto>("POST", `/api/admin/reports/${id}`, {
    status: "actioned",
    resolution: "wave removed",
    action,
  });

describe("message_set reports", () => {
  test("a wave report stores every body and the sender count, on the channel", async () => {
    const ids = await messages(aliceChannel, [bob, carol], 3);
    const r = await report(alice, wave(ids));
    expect(r.status).toBe(200);
    const [row] = await db().select().from(schema.reports).where(eq(schema.reports.id, r.body.id));
    expect(row).toMatchObject({ subjectType: "message_set", subjectId: ids[0], channelId: aliceChannel });
    const msgs = await db().select().from(schema.chatMessages).where(inArray(schema.chatMessages.id, ids));
    const evidence = row?.evidence as { messages: { id: string; userId: string; body: string }[]; senders: number };
    expect(evidence.senders).toBe(2);
    expect(evidence.messages.map((m) => m.id).toSorted()).toEqual([...ids].sort());
    for (const m of msgs) expect(evidence.messages).toContainEqual({ id: m.id, userId: m.userId, body: m.body });
    // One open report per reporter and wave (keyed on the representative message).
    expect((await report(alice, wave(ids))).status).toBe(409);
  });

  test("messages from two channels, or one that does not exist, are NOT_FOUND", async () => {
    const [a] = await messages(aliceChannel, [bob], 1);
    const [b] = await messages(bobChannel, [carol], 1);
    expect((await report(alice, wave([a!, b!]))).status).toBe(404);
    expect((await report(alice, wave([a!, uuidv7()]))).status).toBe(404);
  });

  test("messageIds without message_set, or message_set without messageIds, is BAD_REQUEST", async () => {
    const ids = await messages(aliceChannel, [bob], 2);
    expect((await report(alice, { subjectType: "chat_message", subjectId: ids[0], messageIds: ids })).status).toBe(400);
    expect((await report(alice, { subjectType: "message_set", subjectId: ids[0] })).status).toBe(400);
    // subjectId must be one of the wave's messages.
    expect((await report(alice, { subjectType: "message_set", subjectId: uuidv7(), messageIds: ids })).status).toBe(
      400,
    );
  });

  test("resolving with remove_content deletes every message and publishes one delete frame each", async () => {
    const ids = await messages(aliceChannel, [bob, carol], 4);
    // One already deleted by a channel moderator: it is left as it was.
    const before = new Date("2026-10-01T00:00:00Z");
    await db()
      .update(schema.chatMessages)
      .set({ deletedAt: before, deletedBy: alice.userId })
      .where(eq(schema.chatMessages.id, ids[3]!));
    const r = await report(alice, wave(ids));
    expect(r.status).toBe(200);

    const sub = subscriber();
    const frames: { op: string; messageId?: string }[] = [];
    await sub.subscribe(BUS.chatControl(aliceChannel));
    sub.on("message", (_ch, msg) => frames.push(JSON.parse(msg) as { op: string; messageId?: string }));
    try {
      const res = await resolve(r.body.id, "remove_content");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("actioned");
      const rows = await db().select().from(schema.chatMessages).where(inArray(schema.chatMessages.id, ids));
      for (const m of rows) expect(m.deletedAt).not.toBeNull();
      const kept = rows.find((m) => m.id === ids[3]);
      expect(kept?.deletedAt?.toISOString()).toBe(before.toISOString());
      expect(
        rows
          .filter((m) => m.deletedBy === staff.userId)
          .map((m) => m.id)
          .toSorted(),
      ).toEqual(ids.slice(0, 3).toSorted());
      const deletes = await waitFor(async () => {
        const d = frames.filter((f) => f.op === "delete");
        return d.length >= 3 ? d : null;
      });
      expect(deletes.map((f) => f.messageId ?? "").toSorted((a, b) => a.localeCompare(b))).toEqual(
        ids.slice(0, 3).toSorted((a, b) => a.localeCompare(b)),
      );
    } finally {
      sub.disconnect();
    }
  });

  test("a wave is never a suspension or channel-ban target", async () => {
    const ids = await messages(aliceChannel, [bob, carol], 2);
    const r = await report(alice, wave(ids));
    expect((await resolve(r.body.id, "suspend_user")).status).toBe(400);
    expect((await resolve(r.body.id, "ban_from_channel")).status).toBe(400);
    const [row] = await db().select().from(schema.reports).where(eq(schema.reports.id, r.body.id));
    expect(row?.status).toBe("open");
  });
});
