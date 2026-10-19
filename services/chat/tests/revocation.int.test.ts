// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Revocation on an open socket. An OAuth token (or session) revoked after the upgrade must stop
 * the socket from sending: at once when the API announces it on BUS.userControl, and within the
 * re-validation window when no announcement arrives.
 */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { BUS, type UserControlMessage } from "@commonair/contracts";
import { schema } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createValkey } from "@commonair/service";
import { sha256Hex } from "@commonair/tokens";
import type { ChatService } from "../src/server.ts";
import {
  chatToken,
  Client,
  createChannel,
  createOauthToken,
  createUser,
  eventually,
  isolation,
  startInstance,
  VALKEY_URL,
} from "./helpers.ts";

const BOT_SCOPES = ["chat:read", "chat:edit"];
const REVALIDATE_MS = 300;

let t: TestDatabase;
/** Two instances on one bus, with the default 30 s validity cache. */
let a: ChatService;
let b: ChatService;
/** A separate bus, with a short validity cache, for revocations nobody announces. */
let short: ChatService;
const iso = isolation();
const clients: Client[] = [];
const connect = async (svc: ChatService, auth: { token?: string; bearer?: string }) => {
  const c = await Client.connect(svc, auth);
  clients.push(c);
  return c;
};
const publish = async (msg: UserControlMessage) => {
  const pub = createValkey(VALKEY_URL);
  try {
    await pub.publish(iso.busPrefix + BUS.userControl, JSON.stringify(msg));
  } finally {
    await pub.quit();
  }
};
const revoke = async (token: string) => {
  const hash = await sha256Hex(token);
  await t.db
    .update(schema.oauthTokens)
    .set({ revokedAt: new Date() })
    .where(eq(schema.oauthTokens.accessTokenHash, hash));
  return hash;
};
/** A bot account with an OAuth token, and a channel to talk in. */
const setup = async () => {
  const owner = await createUser(t.db);
  const ch = await createChannel(t.db, owner);
  const bot = await createUser(t.db, { accountType: "bot", emailVerified: false, botOwnerId: owner.id });
  return { owner, ch, bot };
};

beforeAll(async () => {
  t = await createTestDatabase();
  a = await startInstance(t.db, iso);
  b = await startInstance(t.db, iso);
  short = await startInstance(t.db, isolation(), { oauthRevalidateMs: REVALIDATE_MS });
});
afterAll(async () => {
  for (const c of clients) c.close();
  await Promise.allSettled([a?.stop(), b?.stop(), short?.stop()]);
  await t?.drop();
});

describe("OAuth token revoked while the socket is open", () => {
  test("a userControl disconnect for the token closes its sockets on every instance, and only those", async () => {
    const { ch, bot } = await setup();
    const token = await createOauthToken(t.db, bot.id, BOT_SCOPES);
    const otherToken = await createOauthToken(t.db, bot.id, BOT_SCOPES);
    const onA = await connect(a, { bearer: token });
    const onB = await connect(b, { bearer: token });
    const sameUserOtherToken = await connect(b, { bearer: otherToken });
    const sameUserChatToken = await connect(a, { token: await chatToken(bot.id) });
    // Both sockets were able to send (and cached the token as valid) before the revocation.
    expect((await onA.say(ch.slug, "before A")).ack.id).not.toBeNull();
    expect((await onB.say(ch.slug, "before B")).ack.id).not.toBeNull();

    const tokenHash = await revoke(token);
    await publish({ op: "disconnect", userId: bot.id, tokenHash, reason: "token_revoked" });
    await eventually(() => onA.closed && onB.closed);
    expect(onA.closed?.code).toBe(4001);
    expect(onB.closed?.code).toBe(4001);

    // The user's other credentials are untouched.
    expect(sameUserOtherToken.closed).toBeNull();
    expect(sameUserChatToken.closed).toBeNull();
    expect((await sameUserOtherToken.say(ch.slug, "still here")).ack.id).not.toBeNull();
    expect((await sameUserChatToken.say(ch.slug, "me too")).ack.id).not.toBeNull();

    // And the revoked token cannot come back.
    await expect(connect(a, { bearer: token })).rejects.toThrow("websocket connection failed");
  });

  test("a userControl invalidate drops the cached validity: the next send is refused and the socket closes", async () => {
    const { ch, bot } = await setup();
    const token = await createOauthToken(t.db, bot.id, BOT_SCOPES);
    const c = await connect(a, { bearer: token });
    const { owner: sentinelUser } = await setup();
    const sentinel = await connect(a, { token: await chatToken(sentinelUser.id) });
    expect((await c.say(ch.slug, "cached as valid")).ack.id).not.toBeNull();
    // A command re-validates the same way a send does.
    expect((await c.command(ch.slug, "clear")).code).toBe("no_permission");

    const tokenHash = await revoke(token);
    // Still within the 30 s cache, so the socket would keep sending without the announcement.
    expect((await c.say(ch.slug, "cache still says valid")).ack.id).not.toBeNull();
    await publish({ op: "invalidate", userId: bot.id, tokenHash, reason: "token_revoked" });
    // Pub/sub keeps order on one channel: once the sentinel's disconnect landed, so did the invalidate.
    await publish({ op: "disconnect", userId: sentinelUser.id, reason: "suspended" });
    await eventually(() => sentinel.closed);

    const { ack, notice } = await c.say(ch.slug, "after revocation");
    expect(ack.id).toBeNull();
    expect(notice?.code).toBe("msg_requires_login");
    await eventually(() => c.closed);
    expect(c.closed?.code).toBe(4001);

    // Nothing from after the revocation was stored.
    await a.flush();
    const bodies = (await t.db.select().from(schema.chatMessages).where(eq(schema.chatMessages.userId, bot.id))).map(
      (m) => m.body,
    );
    expect(bodies.sort()).toEqual(["cache still says valid", "cached as valid"]);
  });

  test("a disconnect for another token of the same user leaves this socket open", async () => {
    const { ch, bot } = await setup();
    const kept = await createOauthToken(t.db, bot.id, BOT_SCOPES);
    const c = await connect(a, { bearer: kept });
    await publish({ op: "disconnect", userId: bot.id, tokenHash: "0".repeat(64), reason: "token_revoked" });
    const { owner: sentinelUser } = await setup();
    const sentinel = await connect(a, { token: await chatToken(sentinelUser.id) });
    await publish({ op: "disconnect", userId: sentinelUser.id, reason: "suspended" });
    await eventually(() => sentinel.closed);
    expect(c.closed).toBeNull();
    expect((await c.say(ch.slug, "unaffected")).ack.id).not.toBeNull();
  });

  test("without any announcement, a revoked token stops sending once the validity cache lapses", async () => {
    const { ch, bot } = await setup();
    const token = await createOauthToken(t.db, bot.id, BOT_SCOPES);
    const c = await connect(short, { bearer: token });
    expect((await c.say(ch.slug, "valid")).ack.id).not.toBeNull();
    await revoke(token);
    await Bun.sleep(REVALIDATE_MS + 100);
    const { ack, notice } = await c.say(ch.slug, "revoked, unannounced");
    expect(ack.id).toBeNull();
    expect(notice?.code).toBe("msg_requires_login");
    await eventually(() => c.closed);
    expect(c.closed?.code).toBe(4001);
  });

  test("a token deleted outright (not just revoked) is refused the same way", async () => {
    const { ch, bot } = await setup();
    const token = await createOauthToken(t.db, bot.id, BOT_SCOPES);
    const c = await connect(short, { bearer: token });
    expect((await c.say(ch.slug, "valid")).ack.id).not.toBeNull();
    await t.db.delete(schema.oauthTokens).where(eq(schema.oauthTokens.accessTokenHash, await sha256Hex(token)));
    await Bun.sleep(REVALIDATE_MS + 100);
    expect((await c.command(ch.slug, "clear")).code).toBe("msg_requires_login");
    await eventually(() => c.closed);
    expect(c.closed?.code).toBe(4001);
  });
});

describe("session revoked while the socket is open", () => {
  test("a userControl disconnect without a token hash closes every socket of the user, chat-token or OAuth", async () => {
    const { ch, bot: user } = await setup();
    const viaChatToken = await connect(a, { token: await chatToken(user.id) });
    const viaOauth = await connect(b, { bearer: await createOauthToken(t.db, user.id, BOT_SCOPES) });
    const { owner: bystanderUser } = await setup();
    const bystander = await connect(a, { token: await chatToken(bystanderUser.id) });
    await viaChatToken.join(ch.slug);
    await publish({ op: "disconnect", userId: user.id, reason: "deleted" });
    await eventually(() => viaChatToken.closed && viaOauth.closed);
    expect(viaChatToken.closed?.code).toBe(4001);
    expect(viaOauth.closed?.code).toBe(4001);
    expect(bystander.closed).toBeNull();
  });
});
