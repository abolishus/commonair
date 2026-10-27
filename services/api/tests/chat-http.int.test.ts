// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Chat over REST against a real chat service started in-process on the same test database: send
 * (accepted, banned, slow mode, held), the held queue (list, allow, deny, double resolve, foreign
 * channel) and REST delete/clear, which must leave the same rows and frames as the socket commands.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { ServerFrame } from "@commonair/contracts/chat";
import { BUS } from "@commonair/contracts/events";
import { schema } from "@commonair/db";
import { createLogger } from "@commonair/observability";
// The chat service itself, so the relay talks to the real rules (services/chat is read-only here).
import { startChatService, type ChatService } from "../../chat/src/server.ts";
import { client, signUpAndSignIn, startApi, subscriber, VALKEY_URL, waitFor, type TestApi } from "./harness.ts";

type Person = Awaited<ReturnType<typeof signUpAndSignIn>>;

let api: TestApi;
let chat: ChatService;
let streamer: Person;
let mod: Person;
let viewer: Person;
let troll: Person;
let channelId: string;
const sockets: Observer[] = [];

/** A chat socket that records frames (the person's own chat token, as the web app connects). */
class Observer {
  readonly frames: ServerFrame[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (ev) => this.frames.push(JSON.parse(String(ev.data)) as ServerFrame));
  }

  static async join(p: Person, slug: string): Promise<Observer> {
    const { body } = await p.client.call<{ token: string }>("POST", "/api/chat/token");
    const url = new URL(chat.wsUrl);
    url.searchParams.set("token", body.token);
    const o = new Observer(new WebSocket(url));
    sockets.push(o);
    await new Promise<void>((resolve, reject) => {
      o.ws.addEventListener("open", () => resolve(), { once: true });
      o.ws.addEventListener("error", () => reject(new Error("socket failed")), { once: true });
    });
    o.ws.send(JSON.stringify({ op: "join", channel: slug }));
    await o.wait((f) => f.op === "joined");
    return o;
  }

  wait(pred: (f: ServerFrame) => boolean, timeoutMs = 5_000): Promise<ServerFrame> {
    return waitFor(async () => this.frames.find(pred), timeoutMs, 20);
  }

  has(pred: (f: ServerFrame) => boolean): boolean {
    return this.frames.some(pred);
  }
}

const settle = (ms = 400) => Bun.sleep(ms);
const db = () => api.db.db;
const path = (slug: string, rest: string) => `/api/channels/${slug}${rest}`;
const send = (p: Person, body: string, slug = streamer.username) =>
  p.client.call<{ id: string; held: boolean; dropReason: string | null; code?: string; message?: string }>(
    "POST",
    path(slug, "/chat/messages"),
    { body },
  );
const resolve = (p: Person, id: string, allow: boolean, slug = streamer.username) =>
  p.client.call<{ code?: string }>("POST", path(slug, `/chat/held/${id}`), { allow });

async function heldRow(id: string) {
  return waitFor(async () => {
    const [row] = await db().select().from(schema.chatMessages).where(eq(schema.chatMessages.id, id));
    return row;
  });
}

/** Messages published on a bus channel while `fn` runs (and shortly after). */
async function published(channels: string[], fn: () => Promise<void>, until: (seen: string[]) => boolean) {
  const sub = subscriber();
  const seen: string[] = [];
  sub.on("message", (_ch: string, raw: string) => seen.push(raw));
  await sub.subscribe(...channels);
  try {
    await fn();
    await waitFor(async () => until(seen) || null, 5_000, 20).catch(() => null);
    return seen.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  } finally {
    await sub.quit();
  }
}

beforeAll(async () => {
  api = await startApi();
  chat = await startChatService({
    port: 0,
    hostname: "127.0.0.1",
    db: api.db.app.db,
    valkeyUrl: VALKEY_URL,
    internalSecret: api.internalSecret,
    keyPrefix: api.keyPrefix,
    // The API publishes on the unprefixed BUS names, as in production.
    busPrefix: "",
    filterWorkers: 0,
    logger: createLogger({ service: "chat-int", level: "fatal" }),
  });
  // The chat port is only known now; the relay reads the URL per call.
  api.deps.env.CHAT_INTERNAL_URL = chat.wsUrl;
  [streamer, mod, viewer, troll] = await Promise.all([
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
  ]);
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, streamer.username));
  if (!c) throw new Error("no channel");
  channelId = c.id;
  await db().insert(schema.channelRoles).values({ channelId, userId: mod.userId, role: "moderator" });
}, 180_000);

afterAll(async () => {
  for (const s of sockets) s.ws.close();
  await chat?.stop();
  await api?.stop();
});

describe("chat.send over REST", () => {
  test("an accepted message is acked with its id and reaches the room", async () => {
    const room = await Observer.join(viewer, streamer.username);
    const r = await send(troll, `hello from rest ${crypto.randomUUID()}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ held: false, dropReason: null });
    await room.wait((f) => f.op === "message" && f.message.id === r.body.id);
    await chat.flush();
    const row = await heldRow(r.body.id);
    expect(row.heldAt).toBeNull();
    expect(row.userId).toBe(troll.userId);
  });

  test("commands, unknown channels and signed-out callers are refused before chat", async () => {
    expect((await send(troll, "/clear")).status).toBe(400);
    expect((await send(troll, "hi", "nosuchchannel")).status).toBe(404);
    const anon = await client(api).call("POST", path(streamer.username, "/chat/messages"), { body: "hi" });
    expect(anon.status).toBe(401);
  });

  test("a banned sender gets 403 with the notice code", async () => {
    const ban = await streamer.client.call("POST", path(streamer.username, "/bans"), { username: troll.username });
    expect(ban.status).toBe(200);
    try {
      const r = await send(troll, "let me in");
      expect(r.status).toBe(403);
      expect(r.body.message).toContain("msg_banned");
    } finally {
      expect((await streamer.client.call("DELETE", path(streamer.username, `/bans/${troll.username}`))).status).toBe(
        200,
      );
    }
  });

  test("slow mode answers 429", async () => {
    const on = await streamer.client.call("PATCH", path(streamer.username, "/chat/settings"), { slowModeSeconds: 30 });
    expect(on.status).toBe(200);
    try {
      expect((await send(viewer, `first ${crypto.randomUUID()}`)).status).toBe(200);
      const second = await send(viewer, `second ${crypto.randomUUID()}`);
      expect(second.status).toBe(429);
      expect(second.body.message).toContain("msg_slowmode");
    } finally {
      await streamer.client.call("PATCH", path(streamer.username, "/chat/settings"), { slowModeSeconds: 0 });
    }
  });
});

describe("held messages", () => {
  let filterId: string;
  let modRoom: Observer;
  let viewerRoom: Observer;

  beforeAll(async () => {
    const f = await streamer.client.call<{ id: string }>("POST", path(streamer.username, "/word-filters"), {
      pattern: "heldword",
      isRegex: false,
      action: "hold",
      replacement: null,
    });
    if (f.status !== 200) throw new Error(`filter create failed: ${f.status}`);
    filterId = f.body.id;
    modRoom = await Observer.join(mod, streamer.username);
    viewerRoom = await Observer.join(viewer, streamer.username);
  });

  afterAll(async () => {
    await streamer.client.call("DELETE", path(streamer.username, `/word-filters/${filterId}`));
  });

  /** Send a held message and wait until chat's batching writer has stored it. */
  async function held(text: string): Promise<string> {
    const r = await send(troll, `${text} heldword ${crypto.randomUUID()}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ held: true, dropReason: null });
    await chat.flush();
    const row = await heldRow(r.body.id);
    expect(row.heldAt).not.toBeNull();
    return r.body.id;
  }

  test("a hold filter: held: true, a held row, moderators see it and viewers do not", async () => {
    const id = await held("first");
    await modRoom.wait((f) => f.op === "message" && f.message.id === id && f.held === true);
    await settle();
    expect(viewerRoom.has((f) => f.op === "message" && f.message.id === id)).toBe(false);
  });

  test("held.list for moderators (oldest first, chat.history shape); forbidden for viewers", async () => {
    const a = await held("older");
    const b = await held("newer");
    const list = await waitFor(async () => {
      const r = await mod.client.call<{ id: string; user: { username: string; badges: unknown[] }; body: string }[]>(
        "GET",
        path(streamer.username, "/chat/held"),
      );
      return r.status === 200 && r.body.some((m) => m.id === b) ? r.body : null;
    });
    const ids = list.map((m) => m.id);
    expect(ids.indexOf(a)).toBeLessThan(ids.indexOf(b));
    expect(list.find((m) => m.id === a)).toMatchObject({ user: { username: troll.username, badges: [] } });
    expect((await viewer.client.call("GET", path(streamer.username, "/chat/held"))).status).toBe(403);
    expect((await resolve(viewer, a, true)).status).toBe(403);
  });

  test("allow: row released, fan-out to all on BUS.chat, channel.chat.message on BUS.events", async () => {
    const id = await held("allow me");
    const seen = await published(
      [BUS.chat(channelId), BUS.events],
      async () => {
        expect((await resolve(mod, id, true)).status).toBe(200);
      },
      (s) => s.filter((x) => x.includes(id)).length >= 2,
    );
    const row = await heldRow(id);
    expect(row.heldAt).toBeNull();
    expect(row.deletedAt).toBeNull();
    const fanout = seen.find((e) => e.v === 1 && (e.frame as { message?: { id: string } }).message?.id === id);
    expect(fanout).toMatchObject({ audience: "all", frame: { op: "message", channel: streamer.username } });
    expect(fanout && "held" in (fanout.frame as object)).toBe(false);
    const event = seen.find((e) => e.type === "channel.chat.message");
    expect(event).toMatchObject({
      channelId,
      payload: { message_id: id, chatter_user_id: troll.userId, broadcaster_user_login: streamer.username },
    });
    await viewerRoom.wait((f) => f.op === "message" && f.message.id === id && !f.held);
    const history = await viewer.client.call<{ id: string }[]>("GET", path(streamer.username, "/chat/messages"));
    expect(history.body.some((m) => m.id === id)).toBe(true);
    const [audit] = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, id), eq(schema.auditLog.action, "chat.held.allow")));
    expect(audit).toMatchObject({ actorId: mod.userId, subjectType: "chat_message", channelId });
    expect(JSON.stringify(audit?.details)).not.toContain("heldword");
  });

  test("deny: row deleted, a delete frame to moderators only, mod_actions + audit", async () => {
    const id = await held("deny me");
    expect((await resolve(streamer, id, false)).status).toBe(200);
    const row = await heldRow(id);
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedBy).toBe(streamer.userId);
    await modRoom.wait((f) => f.op === "delete" && f.messageId === id);
    await settle();
    expect(
      viewerRoom.has((f) => (f.op === "delete" && f.messageId === id) || (f.op === "message" && f.message.id === id)),
    ).toBe(false);
    const [action] = await db()
      .select()
      .from(schema.modActions)
      .where(and(eq(schema.modActions.subjectId, id), eq(schema.modActions.action, "delete_message")));
    expect(action).toMatchObject({
      moderatorId: streamer.userId,
      targetUserId: troll.userId,
      subjectType: "chat_message",
    });
    const audits = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, id), eq(schema.auditLog.action, "chat.held.deny")));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.details).toEqual({ modActionId: action?.id, authorId: troll.userId });
    const list = await mod.client.call<{ id: string }[]>("GET", path(streamer.username, "/chat/held"));
    expect(list.body.some((m) => m.id === id)).toBe(false);
  });

  test("allowing a banned or timed-out author's message is 403 and leaves it held", async () => {
    const id = await held("banned author");
    // Straight into the table: chat never hears of it, so only the API's check is exercised.
    const [ban] = await db()
      .insert(schema.chatBans)
      .values({ channelId, userId: troll.userId, expiresAt: new Date(Date.now() + 600_000) })
      .returning();
    try {
      expect((await resolve(mod, id, true)).status).toBe(403);
      expect((await heldRow(id)).heldAt).not.toBeNull();
      // Denying still works.
      expect((await resolve(mod, id, false)).status).toBe(200);
    } finally {
      if (ban) await db().update(schema.chatBans).set({ liftedAt: new Date() }).where(eq(schema.chatBans.id, ban.id));
    }
  });

  test("resolving twice is 409; another channel's or an unknown id is 404", async () => {
    const id = await held("twice");
    expect((await resolve(mod, id, true)).status).toBe(200);
    expect((await resolve(mod, id, true)).status).toBe(409);
    expect((await resolve(mod, id, false)).status).toBe(409);
    const other = await held("foreign");
    // The viewer owns a channel too; the id belongs to the streamer's.
    expect((await resolve(viewer, other, true, viewer.username)).status).toBe(404);
    expect((await resolve(mod, crypto.randomUUID(), true)).status).toBe(404);
    // The denied path also refuses a released message.
    expect((await resolve(mod, other, false)).status).toBe(200);
  });
});

describe("delete and clear over REST", () => {
  test("delete leaves the same rows and frame as /delete; unknown ids are 404", async () => {
    const room = await Observer.join(viewer, streamer.username);
    const sent = await send(troll, `delete me ${crypto.randomUUID()}`);
    expect(sent.status).toBe(200);
    const id = sent.body.id;
    const r = await mod.client.call("DELETE", path(streamer.username, `/chat/messages/${id}`));
    expect(r.status).toBe(200);
    await room.wait((f) => f.op === "delete" && f.messageId === id);
    const row = await heldRow(id);
    expect(row.deletedBy).toBe(mod.userId);
    const [action] = await db()
      .select()
      .from(schema.modActions)
      .where(and(eq(schema.modActions.subjectId, id), eq(schema.modActions.action, "delete_message")));
    expect(action).toMatchObject({ moderatorId: mod.userId, targetUserId: troll.userId });
    const audits = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, id), eq(schema.auditLog.action, "chat.delete_message")));
    expect(audits).toHaveLength(1);
    const events = await db()
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.channelId, channelId), eq(schema.events.type, "channel.chat.message_delete")));
    expect(events.some((e) => (e.payload as { message_id?: string }).message_id === id)).toBe(true);
    expect((await mod.client.call("DELETE", path(streamer.username, `/chat/messages/${id}`))).status).toBe(404);
    expect(
      (await mod.client.call("DELETE", path(streamer.username, `/chat/messages/${crypto.randomUUID()}`))).status,
    ).toBe(404);
    expect((await viewer.client.call("DELETE", path(streamer.username, `/chat/messages/${id}`))).status).toBe(403);
  });

  test("clear writes chat.clear and broadcasts a clear frame", async () => {
    const room = await Observer.join(viewer, streamer.username);
    const r = await mod.client.call("POST", path(streamer.username, "/chat/clear"));
    expect(r.status).toBe(200);
    await room.wait((f) => f.op === "clear");
    const audits = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.channelId, channelId), eq(schema.auditLog.action, "chat.clear")));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const [action] = await db()
      .select()
      .from(schema.modActions)
      .where(and(eq(schema.modActions.channelId, channelId), eq(schema.modActions.action, "clear_chat")));
    expect(action).toMatchObject({ moderatorId: mod.userId });
    expect((await viewer.client.call("POST", path(streamer.username, "/chat/clear"))).status).toBe(403);
  });
});
