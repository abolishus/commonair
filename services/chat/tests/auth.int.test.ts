// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Connection authentication: chat tokens, OAuth bearer tokens, anonymous read-only. */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { schema } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { sha256Hex, signChatToken } from "@commonair/tokens";
import type { ChatService } from "../src/server.ts";
import { chatToken, Client, createChannel, createOauthToken, createUser, isolation, startInstance } from "./helpers.ts";

let t: TestDatabase;
let svc: ChatService;
const clients: Client[] = [];
const track = (c: Client) => {
  clients.push(c);
  return c;
};

beforeAll(async () => {
  t = await createTestDatabase();
  svc = await startInstance(t.db, isolation());
});

afterAll(async () => {
  for (const c of clients) c.close();
  await svc?.stop();
  await t?.drop();
});

/** Status code of a rejected upgrade (Bun's client hides it, so use plain HTTP). */
async function upgradeStatus(query = "", headers: Record<string, string> = {}): Promise<number> {
  const url = new URL(svc.wsUrl);
  url.protocol = "http:";
  url.search = query;
  const res = await fetch(url, {
    headers: {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": btoa("0123456789abcdef"),
      ...headers,
    },
  });
  await res.body?.cancel();
  return res.status;
}

describe("chat tokens", () => {
  test("welcome carries the user and heartbeat", async () => {
    const u = await createUser(t.db);
    const c = track(await Client.connect(svc, { token: await chatToken(u.id) }));
    const welcome = c.frames.find((f) => f.op === "welcome");
    expect(welcome).toMatchObject({ op: "welcome", user: { id: u.id, username: u.username }, heartbeatMs: 30_000 });
  });

  test("invalid, expired and unknown-user tokens are refused", async () => {
    expect(await upgradeStatus("?token=garbage")).toBe(401);
    const expired = await signChatToken("x".repeat(40), { v: 1, uid: null, app: null, scopes: [], exp: 1 });
    expect(await upgradeStatus(`?token=${expired}`)).toBe(401);
    const ghost = await chatToken(crypto.randomUUID());
    expect(await upgradeStatus(`?token=${ghost}`)).toBe(401);
  });

  test("non-websocket and wrong-path requests", async () => {
    const url = new URL(svc.wsUrl);
    url.protocol = "http:";
    expect((await fetch(url)).status).toBe(426);
    url.pathname = "/nope";
    expect((await fetch(url)).status).toBe(404);
    url.pathname = "/healthz";
    expect((await fetch(url)).status).toBe(200);
  });
});

describe("anonymous connections", () => {
  test("can join and read but not send", async () => {
    const owner = await createUser(t.db);
    const ch = await createChannel(t.db, owner);
    const anon = track(await Client.connect(svc));
    expect(anon.frames[0]).toMatchObject({ op: "welcome", user: null });
    const joined = await anon.join(ch.slug);
    expect(joined.me).toEqual({ badges: [], canModerate: false, canChat: false });
    const { ack, notice } = await anon.say(ch.slug, "hello?");
    expect(ack.id).toBeNull();
    expect(notice?.code).toBe("msg_requires_login");

    const speaker = track(await Client.connect(svc, { token: await chatToken(owner.id) }));
    const { ack: sent } = await speaker.say(ch.slug, "welcome, lurkers");
    await anon.waitFor((f) => f.op === "message" && f.message.id === sent.id);

    // An anonymous chat token behaves the same.
    const anonToken = track(await Client.connect(svc, { token: await chatToken(null) }));
    expect((await anonToken.say(ch.slug, "x")).notice?.code).toBe("msg_requires_login");
  });

  test("join of an unknown channel is an error frame", async () => {
    const anon = track(await Client.connect(svc));
    anon.send({ op: "join", channel: "no_such_channel" });
    const err = await anon.waitFor<"error">((f) => f.op === "error");
    expect(err.code).toBe("channel_not_found");
  });

  test("malformed frames get an error, pings a pong", async () => {
    const anon = track(await Client.connect(svc));
    anon.ws.send("{not json");
    expect((await anon.waitFor<"error">((f) => f.op === "error")).code).toBe("bad_request");
    anon.send({ op: "ping", nonce: "n1" });
    expect(await anon.waitFor((f) => f.op === "pong")).toEqual({ op: "pong", nonce: "n1" });
  });
});

describe("OAuth bearer connections (server-to-server)", () => {
  test("chat:read + chat:edit can send; the app id is recorded", async () => {
    const owner = await createUser(t.db);
    const ch = await createChannel(t.db, owner);
    const bot = await createUser(t.db, { accountType: "bot", emailVerified: false, botOwnerId: owner.id });
    const app = await t.db
      .insert(schema.oauthApps)
      .values({
        ownerId: owner.id,
        name: "bot app",
        clientId: crypto.randomUUID(),
        clientSecretHash: "x",
        redirectUris: [],
      })
      .returning({ id: schema.oauthApps.id });
    const token = await createOauthToken(t.db, bot.id, ["chat:read", "chat:edit"]);
    await t.db.update(schema.oauthTokens).set({ appId: app[0]?.id }).where(eq(schema.oauthTokens.userId, bot.id));
    const c = track(await Client.connect(svc, { bearer: token }));
    expect(c.frames[0]).toMatchObject({ op: "welcome", user: { id: bot.id } });
    await c.join(ch.slug);
    const { ack, notice } = await c.say(ch.slug, "beep boop");
    expect(notice).toBeNull();
    const msg = await c.waitFor<"message">((f) => f.op === "message" && f.message.id === ack.id);
    expect(msg.message.user.badges).toEqual([{ type: "bot" }]);
    expect(msg.message.user.accountType).toBe("bot");
    await svc.flush();
    const [row] = await t.db
      .select()
      .from(schema.chatMessages)
      .where(eq(schema.chatMessages.id, ack.id ?? ""));
    expect(row?.viaAppId).toBe(app[0]?.id);
    // Bot tokens without the moderation scope cannot moderate.
    expect((await c.command(ch.slug, "clear")).code).toBe("no_permission");
  });

  test("chat:read alone is read-only", async () => {
    const owner = await createUser(t.db);
    const ch = await createChannel(t.db, owner);
    const reader = await createUser(t.db);
    const c = track(await Client.connect(svc, { bearer: await createOauthToken(t.db, reader.id, ["chat:read"]) }));
    const joined = await c.join(ch.slug);
    expect(joined.me.canChat).toBe(false);
    expect((await c.say(ch.slug, "hi")).notice?.code).toBe("msg_requires_login");
  });

  test("missing chat:read, revoked, expired and unknown tokens are refused", async () => {
    const u = await createUser(t.db);
    const noRead = await createOauthToken(t.db, u.id, ["chat:edit"]);
    expect(await upgradeStatus("", { authorization: `Bearer ${noRead}` })).toBe(403);
    const revoked = await createOauthToken(t.db, u.id, ["chat:read"]);
    await t.db
      .update(schema.oauthTokens)
      .set({ revokedAt: new Date() })
      .where(eq(schema.oauthTokens.accessTokenHash, await sha256Hex(revoked)));
    expect(await upgradeStatus("", { authorization: `Bearer ${revoked}` })).toBe(401);
    const expired = await createOauthToken(t.db, u.id, ["chat:read", "chat:edit"]);
    await t.db
      .update(schema.oauthTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.oauthTokens.accessTokenHash, await sha256Hex(expired)));
    expect(await upgradeStatus("", { authorization: `Bearer ${expired}` })).toBe(401);
    expect(await upgradeStatus("", { authorization: "Bearer nope" })).toBe(401);
    expect(await upgradeStatus("", { authorization: "Basic abc" })).toBe(401);
  });
});
