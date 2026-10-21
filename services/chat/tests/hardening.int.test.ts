// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Review hardening: join-before-send, credential lifetime, banned moderators, user control. */
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { and, eq } from "drizzle-orm";
import { BUS, type ServerFrame } from "@commonair/contracts";
import { schema } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createValkey } from "@commonair/service";
import { signChatToken } from "@commonair/tokens";
import type { ChatService } from "../src/server.ts";
import {
  chatToken,
  Client,
  createChannel,
  createUser,
  eventually,
  FULL_SCOPES,
  isolation,
  SECRET,
  startInstance,
  VALKEY_URL,
} from "./helpers.ts";

// Suites run in parallel with every other workspace: generous deadlines for tests, and for teardown,
// since Postgres runs DROP DATABASE one at a time.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let a: ChatService;
let b: ChatService;
const iso = isolation();
const clients: Client[] = [];
const connect = async (svc: ChatService, token: string) => {
  const c = await Client.connect(svc, { token });
  clients.push(c);
  return c;
};

beforeAll(async () => {
  t = await createTestDatabase();
  a = await startInstance(t.db, iso);
  b = await startInstance(t.db, iso);
});
afterAll(async () => {
  for (const c of clients) c.close();
  await Promise.allSettled([a?.stop(), b?.stop()]);
  await t?.drop();
});

const raw = (c: Client, frame: Record<string, unknown>, nonce: string) => {
  c.send({ ...frame, nonce });
  return c.waitFor((f) => f.op === "notice" && (f as ServerFrame & { nonce?: string }).nonce === nonce);
};

describe("send and command require a joined room", () => {
  test("send and command without joining are rejected; anonymous is rejected before any lookup", async () => {
    const owner = await createUser(t.db);
    const ch = await createChannel(t.db, owner);
    const c = await connect(a, await chatToken(owner.id));
    expect(await raw(c, { op: "send", channel: ch.slug, body: "hi" }, "s1")).toMatchObject({ code: "msg_rejected" });
    expect(await raw(c, { op: "command", channel: ch.slug, command: "clear", args: [] }, "c1")).toMatchObject({
      code: "msg_rejected",
    });
    const anon = await connect(a, await chatToken(null));
    // An unknown channel still reports the login problem: no channel lookup happened.
    expect(await raw(anon, { op: "send", channel: "no_such_chan", body: "hi" }, "s2")).toMatchObject({
      code: "msg_requires_login",
    });
  });

  test("a channel created after a failed join becomes joinable once the short miss cache lapses", async () => {
    const owner = await createUser(t.db);
    const c = await connect(a, await chatToken(owner.id));
    c.send({ op: "join", channel: owner.username, nonce: "j1" });
    expect(await c.waitFor((f) => f.op === "error" && f.nonce === "j1")).toMatchObject({ code: "channel_not_found" });
    await createChannel(t.db, owner);
    await eventually(async () => {
      c.send({ op: "join", channel: owner.username });
      await Bun.sleep(200);
      return c.frames.some((f) => f.op === "joined" && f.channel === owner.username);
    }, 8000);
  }, 10_000);
});

describe("credential lifetime", () => {
  test("a socket is closed when its chat token expires", async () => {
    const u = await createUser(t.db);
    const token = await signChatToken(SECRET, {
      v: 1,
      uid: u.id,
      app: null,
      scopes: FULL_SCOPES,
      exp: Math.floor(Date.now() / 1000) + 2,
    });
    const c = await connect(a, token);
    await eventually(() => c.closed, 5000);
    expect(c.closed?.code).toBe(4001);
  });

  test("BUS.userControl disconnect closes the user's sockets on every instance", async () => {
    const u = await createUser(t.db);
    const other = await createUser(t.db);
    const c1 = await connect(a, await chatToken(u.id));
    const c2 = await connect(b, await chatToken(u.id));
    const bystander = await connect(b, await chatToken(other.id));
    const pub = createValkey(VALKEY_URL);
    await pub.publish(
      iso.busPrefix + BUS.userControl,
      JSON.stringify({ op: "disconnect", userId: u.id, reason: "suspended" }),
    );
    await pub.quit();
    await eventually(() => c1.closed && c2.closed);
    expect(c1.closed?.code).toBe(4001);
    expect(bystander.closed).toBeNull();
  });
});

describe("moderator demotion", () => {
  test("a timed-out moderator cannot moderate, and a ban strips roles across instances", async () => {
    const owner = await createUser(t.db);
    const mod = await createUser(t.db);
    const viewer = await createUser(t.db);
    const ch = await createChannel(t.db, owner);
    await t.db.insert(schema.channelRoles).values({ channelId: ch.id, userId: mod.id, role: "moderator" });
    const ownerClient = await connect(a, await chatToken(owner.id));
    const modClient = await connect(b, await chatToken(mod.id));
    await modClient.join(ch.slug);
    expect((await ownerClient.command(ch.slug, "timeout", [mod.username, "60"])).code).toBe("cmd_success");
    await modClient.waitFor((f) => f.op === "ban" && f.userId === mod.id);
    expect((await modClient.command(ch.slug, "timeout", [viewer.username])).code).toBe("no_permission");

    expect((await ownerClient.command(ch.slug, "ban", [mod.username])).code).toBe("cmd_success");
    const roles = await t.db
      .select()
      .from(schema.channelRoles)
      .where(and(eq(schema.channelRoles.channelId, ch.id), eq(schema.channelRoles.userId, mod.id)));
    expect(roles).toHaveLength(0);
    const removed = await t.db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.channelId, ch.id), eq(schema.events.type, "channel.moderator.remove")));
    expect(removed).toHaveLength(1);
    // Even after the ban is lifted, the former moderator on instance B has no moderation rights.
    expect((await ownerClient.command(ch.slug, "unban", [mod.username])).code).toBe("cmd_success");
    await eventually(async () => (await modClient.command(ch.slug, "clear")).code === "no_permission");
  });
});

describe("replies", () => {
  test("a deleted message can no longer be quoted", async () => {
    const owner = await createUser(t.db);
    const viewer = await createUser(t.db);
    const ch = await createChannel(t.db, owner);
    const v = await connect(a, await chatToken(viewer.id));
    const o = await connect(a, await chatToken(owner.id));
    const { ack } = await v.say(ch.slug, "regrettable");
    await o.join(ch.slug);
    expect((await o.command(ch.slug, "delete", [ack.id ?? ""])).code).toBe("cmd_success");
    await o.waitFor((f) => f.op === "delete" && f.messageId === ack.id);
    const reply = await o.say(ch.slug, "replying", { replyToId: ack.id });
    const msg = await o.waitFor<"message">((f) => f.op === "message" && f.message.id === reply.ack.id);
    expect(msg.message.replyTo).toBeNull();
  });
});
