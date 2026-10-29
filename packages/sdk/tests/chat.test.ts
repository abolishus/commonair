// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: Apache-2.0

import { ClientFrame, type ServerFrame } from "@commonair/contracts/chat";
import { ChannelChatSettings } from "@commonair/contracts/shapes";
import type { ServerWebSocket } from "bun";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { ChatError, connectChat, type ChatMessageEvent, type CommonAirClient } from "../src/index.ts";

const CHANNEL_ID = "0193a1b2-0000-7000-8000-000000000001";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A fake chat server replaying the protocol's frame sequence: welcome, joined, ack, notices, errors. */
function fakeChat(opts: { requireBearer?: string; heartbeatMs?: number; welcome?: boolean } = {}) {
  const received: ClientFrame[] = [];
  const sockets = new Set<ServerWebSocket<{ query: string | null }>>();
  const send = (ws: ServerWebSocket<unknown>, f: ServerFrame) => ws.send(JSON.stringify(f));
  const server = Bun.serve<{ query: string | null }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      const query = url.searchParams.get("token");
      if (opts.requireBearer && req.headers.get("authorization") !== `Bearer ${opts.requireBearer}`)
        return new Response("unauthorized", { status: 401 });
      return srv.upgrade(req, { data: { query } }) ? undefined : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        if (opts.welcome !== false)
          send(ws, {
            op: "welcome",
            sessionId: "s1",
            user: { id: "0193a1b2-0000-7000-8000-0000000000bb", username: "the_bot", displayName: "The Bot" },
            heartbeatMs: opts.heartbeatMs ?? 30_000,
          });
      },
      close(ws) {
        sockets.delete(ws);
      },
      message(ws, raw) {
        const frame = ClientFrame.parse(JSON.parse(String(raw)));
        received.push(frame);
        if (frame.op === "join") {
          // An error for some other request in this channel, before the join's own reply.
          if (frame.channel === "noisy")
            send(ws, { op: "error", code: "rate_limited", message: "slow down", channel: "noisy", nonce: "s-other" });
          if (frame.channel === "banned")
            send(ws, {
              op: "error",
              code: "banned",
              message: "you are banned",
              channel: frame.channel,
              nonce: frame.nonce,
            });
          else
            send(ws, {
              op: "joined",
              channel: frame.channel,
              channelId: CHANNEL_ID,
              settings: ChannelChatSettings.parse({}),
              me: { badges: [], canModerate: false, canChat: true },
            });
        } else if (frame.op === "part") send(ws, { op: "parted", channel: frame.channel });
        else if (frame.op === "send") {
          if (frame.body === "close") ws.close(4000, "bye");
          else if (frame.body === "error")
            send(ws, { op: "error", code: "rate_limited", message: "slow down", nonce: frame.nonce });
          else
            send(ws, {
              op: "ack",
              nonce: frame.nonce,
              id: frame.body === "rejected" ? null : crypto.randomUUID(),
              held: frame.body === "held",
            });
        } else if (frame.op === "ping") send(ws, { op: "pong", nonce: frame.nonce });
      },
    },
  });
  cleanups.push(() => server.stop(true));
  return {
    url: `ws://127.0.0.1:${server.port}/ws`,
    received,
    sockets,
    broadcast(f: ServerFrame | string) {
      for (const ws of sockets) ws.send(typeof f === "string" ? f : JSON.stringify(f));
    },
  };
}

const message = (
  body: string,
  user = { id: "0193a1b2-0000-7000-8000-0000000000cc", username: "viewer" },
): ServerFrame => ({
  op: "message",
  channel: "chan",
  message: {
    id: crypto.randomUUID(),
    channelId: CHANNEL_ID,
    user: { ...user, displayName: user.username, color: null, badges: [], accountType: "human" },
    body,
    emotes: [],
    isAction: false,
    replyTo: null,
    createdAt: new Date().toISOString(),
  },
});

const until = async (what: string, cond: () => boolean, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

describe("connectChat", () => {
  test("bearer on the upgrade, welcome, join, say with ack, messages", async () => {
    const fake = fakeChat({ requireBearer: "bot-token" });
    const chat = await connectChat({ url: fake.url, token: "bot-token" });
    cleanups.push(() => chat.close());
    expect(chat.welcome.user?.username).toBe("the_bot");
    expect(chat.isOpen).toBe(true);
    expect((await chat.join("chan")).channelId).toBe(CHANNEL_ID);
    const ack = await chat.say("chan", "hello", { isAction: true });
    expect(ack.id).not.toBeNull();
    expect(ack.held).toBe(false);
    expect(await chat.say("chan", "held")).toMatchObject({ held: true });
    const got: ChatMessageEvent[] = [];
    const off = chat.onMessage((m) => got.push(m));
    fake.broadcast(message("hi there"));
    await until("message", () => got.length === 1);
    expect(got[0]).toMatchObject({
      channel: "chan",
      username: "viewer",
      text: "hi there",
      isAction: false,
      held: false,
    });
    off();
    fake.broadcast(message("ignored"));
    await Bun.sleep(50);
    expect(got).toHaveLength(1);
    const sends = fake.received.filter((f) => f.op === "send");
    expect(sends[0]).toMatchObject({ channel: "chan", body: "hello", isAction: true });
    expect(new Set(sends.map((f) => f.op === "send" && f.nonce)).size).toBe(sends.length);
    await chat.part("chan");
  });

  test("a refused bearer fails to connect", async () => {
    const fake = fakeChat({ requireBearer: "bot-token" });
    await expect(connectChat({ url: fake.url, token: "wrong", connectTimeoutMs: 1_000 })).rejects.toThrow(ChatError);
  });

  test("rejected messages and error frames throw ChatError with the server's code", async () => {
    const fake = fakeChat();
    const chat = await connectChat({ url: fake.url, token: "t" });
    cleanups.push(() => chat.close());
    await chat.join("chan");
    const rejected = await chat.say("chan", "rejected").catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(ChatError);
    expect((rejected as ChatError).code).toBe("rejected");
    expect(((await chat.say("chan", "error").catch((e: unknown) => e)) as ChatError).code).toBe("rate_limited");
    expect(((await chat.join("banned").catch((e: unknown) => e)) as ChatError).code).toBe("banned");
  });

  test("invalid frames are reported and skipped", async () => {
    const fake = fakeChat();
    const errors: Error[] = [];
    const chat = await connectChat({ url: fake.url, token: "t", onError: (e) => errors.push(e) });
    cleanups.push(() => chat.close());
    const got: ChatMessageEvent[] = [];
    chat.onMessage((m) => got.push(m));
    fake.broadcast("{not json");
    fake.broadcast('{"op":"mystery"}');
    fake.broadcast(message("ok"));
    await until("ok", () => got.length === 1);
    expect(errors).toHaveLength(2);
  });

  test("pings at half the heartbeat (at least 1 s)", async () => {
    const fake = fakeChat({ heartbeatMs: 2_000 });
    const chat = await connectChat({ url: fake.url, token: "t" });
    cleanups.push(() => chat.close());
    await until("a ping", () => fake.received.some((f) => f.op === "ping"), 2_500);
    expect(chat.isOpen).toBe(true);
  });

  test("the URL (and, for browsers, a chat token) from client.chat.connectToken()", async () => {
    const fake = fakeChat();
    const client = {
      chat: { connectToken: async () => ({ token: "chat-tok", url: fake.url, expiresAt: new Date().toISOString() }) },
    } as unknown as CommonAirClient;
    const viaClient = await connectChat({ client, token: "t" });
    cleanups.push(() => viaClient.close());
    const browser = await connectChat({ client, useChatToken: true });
    cleanups.push(() => browser.close());
    const queries = [...fake.sockets].map((s) => s.data.query);
    expect(queries).toHaveLength(2);
    expect(queries).toContain(null);
    expect(queries).toContain("chat-tok");
    await expect(connectChat({})).rejects.toThrow(/url/);
  });

  test("close() and a server close both end the connection", async () => {
    const fake = fakeChat();
    const chat = await connectChat({ url: fake.url, token: "t" });
    chat.close();
    expect(chat.isOpen).toBe(false);
    await expect(chat.say("chan", "x")).rejects.toThrow(/closed/);
    const other = await connectChat({ url: fake.url, token: "t" });
    for (const s of fake.sockets) s.close(4000, "bye");
    expect((await other.closed).code).toBe(4000);
    expect(other.isOpen).toBe(false);
  });

  test("a join fails only on an error for its own nonce", async () => {
    const fake = fakeChat();
    const chat = await connectChat({ url: fake.url, token: "t" });
    cleanups.push(() => chat.close());
    expect((await chat.join("noisy")).channel).toBe("noisy");
  });

  test("a close fails pending requests at once, not after the reply timeout", async () => {
    const fake = fakeChat();
    const chat = await connectChat({ url: fake.url, token: "t", replyTimeoutMs: 5_000 });
    const t0 = Date.now();
    const err = (await chat.say("chan", "close").catch((e: unknown) => e)) as ChatError;
    expect(err).toBeInstanceOf(ChatError);
    expect(err.code).toBe("closed");
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  test("no welcome in time rejects", async () => {
    const fake = fakeChat({ welcome: false });
    await expect(connectChat({ url: fake.url, token: "t", connectTimeoutMs: 150 })).rejects.toThrow(/welcome/);
  });
});
