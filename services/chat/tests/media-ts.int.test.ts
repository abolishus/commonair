// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Media time on chat (ADR 0012 amendment 1 decisions 1, 2 and 4): stored and fanned out clamped. */
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { KEYS } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createValkey, type ValkeyClient } from "@commonair/service";
import type { ChatService } from "../src/server.ts";
import {
  chatToken,
  Client,
  createChannel,
  createUser,
  eventually,
  isolation,
  startInstance,
  VALKEY_URL,
} from "./helpers.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let svc: ChatService;
let valkey: ValkeyClient;
const iso = isolation();
const clients: Client[] = [];

beforeAll(async () => {
  t = await createTestDatabase();
  svc = await startInstance(t.db, iso);
  valkey = createValkey(VALKEY_URL);
});

afterAll(async () => {
  for (const c of clients) c.close();
  await svc?.stop();
  valkey?.disconnect();
  await t?.drop();
});

const connect = async (uid: string) => {
  const c = await Client.connect(svc, { token: await chatToken(uid) });
  clients.push(c);
  return c;
};

/** A channel, live since `startedAgoMs` unless null; a sender and a watcher joined to it. */
async function room(startedAgoMs: number | null) {
  const owner = await createUser(t.db);
  const viewer = await createUser(t.db);
  const ch = await createChannel(t.db, owner);
  let startedAt: Date | null = null;
  if (startedAgoMs !== null) {
    startedAt = new Date(Date.now() - startedAgoMs);
    const broadcastId = uuidv7();
    await t.db.insert(schema.broadcasts).values({
      id: broadcastId,
      channelId: ch.id,
      ingestProtocol: "rtmp",
      path: `live/${ch.slug}`,
      startedAt,
    });
    await t.db.update(schema.channels).set({ liveBroadcastId: broadcastId }).where(eq(schema.channels.id, ch.id));
  }
  const sender = await connect(viewer.id);
  const watcher = await connect(owner.id);
  await sender.join(ch.slug);
  await watcher.join(ch.slug);
  return { ch, sender, watcher, startedAt };
}

async function sendAndRead(r: Awaited<ReturnType<typeof room>>, body: string, extra: Record<string, unknown>) {
  const { ack, notice } = await r.sender.say(r.ch.slug, body, extra);
  expect(notice).toBeNull();
  expect(ack.id).toBeTruthy();
  const id = ack.id as string;
  const live = await r.watcher.waitFor<"message">((f) => f.op === "message" && f.message.id === id);
  const row = await eventually(async () => {
    const [found] = await t.db
      .select({ mediaTs: schema.chatMessages.mediaTs, createdAt: schema.chatMessages.createdAt })
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.id, id));
    return found;
  });
  return { live: live.message, row };
}

describe("media time on live chat", () => {
  test("a hint inside the window is stored and fanned out as sent", async () => {
    const r = await room(10 * 60_000);
    const hint = new Date(Date.now() - 5_000);
    const { live, row } = await sendAndRead(r, "hint inside", { mediaTs: hint.toISOString(), playbackMode: "live" });
    expect(live.mediaTs).toBe(hint.toISOString());
    expect(row.mediaTs?.toISOString()).toBe(hint.toISOString());
    // Receive time stays authoritative.
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(hint.getTime());
  });

  test("a hint too far back is raised to receive − 60 s; a future one lowered to receive", async () => {
    const r = await room(10 * 60_000);
    const old = await sendAndRead(r, "too old", { mediaTs: new Date(Date.now() - 120_000).toISOString() });
    expect(old.row.mediaTs?.getTime()).toBe(old.row.createdAt.getTime() - 60_000);
    expect(old.live.mediaTs).toBe(old.row.mediaTs?.toISOString());

    const future = await sendAndRead(r, "from the future", { mediaTs: new Date(Date.now() + 10_000).toISOString() });
    expect(future.row.mediaTs?.getTime()).toBe(future.row.createdAt.getTime());
  });

  test("a hint before the broadcast started becomes started_at", async () => {
    const r = await room(20_000);
    const { row } = await sendAndRead(r, "before start", { mediaTs: new Date(Date.now() - 45_000).toISOString() });
    expect(row.mediaTs?.toISOString()).toBe(r.startedAt?.toISOString());
  });

  test("DVR mode stores null", async () => {
    const r = await room(10 * 60_000);
    const { live, row } = await sendAndRead(r, "catching up", {
      mediaTs: new Date(Date.now() - 5_000).toISOString(),
      playbackMode: "dvr",
    });
    expect(live.mediaTs).toBeNull();
    expect(row.mediaTs).toBeNull();
  });

  test("no hint: receive − the channel median, or receive time without one", async () => {
    const withMedian = await room(10 * 60_000);
    await valkey.set(iso.keyPrefix + KEYS.chatLatency(withMedian.ch.id), "4", "EX", 60);
    const a = await sendAndRead(withMedian, "no hint, median", {});
    expect(a.row.mediaTs?.getTime()).toBe(a.row.createdAt.getTime() - 4_000);

    const without = await room(10 * 60_000);
    const b = await sendAndRead(without, "no hint, no median", {});
    expect(b.row.mediaTs?.getTime()).toBe(b.row.createdAt.getTime());
  });

  test("an offline channel accepts the message with a null media time", async () => {
    const r = await room(null);
    const { live, row } = await sendAndRead(r, "offline", { mediaTs: new Date(Date.now() - 5_000).toISOString() });
    expect(live.mediaTs).toBeNull();
    expect(row.mediaTs).toBeNull();
  });
});
