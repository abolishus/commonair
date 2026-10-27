// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Chat drivers against local fakes: the chat client and SDK bot against a fake chat service
 * speaking the contract protocol, and unmodified tmi.js against a fake Twitch-dialect IRC-over-
 * WebSocket server (exactly what the IRC gateway must look like to tmi.js).
 */
import { ChannelChatSettings, ClientFrame, type ServerFrame } from "@commonair/contracts";
import type { ServerWebSocket } from "bun";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { formatUptime, replyTo } from "../src/bots/commands.ts";
import { type BotChatConnection, type BotSdk, SdkBot } from "../src/bots/sdk-bot.ts";
import { EVENT_LOG_LIMIT, TmiBot, TmiEventLog, tmiConnection, twitchTagProblems } from "../src/bots/tmi-bot.ts";
import { ChatClient, ChatProtocolError } from "../src/chat-client.ts";
import { waitFor } from "../src/wait.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

describe("bot commands", () => {
  test("!ping and !uptime", () => {
    expect(replyTo("!ping", { now: 0, liveSince: null })).toBe("pong");
    expect(replyTo("  !PING extra", { now: 0, liveSince: null })).toBe("pong");
    expect(replyTo("!uptime", { now: 3_723_000, liveSince: 0 })).toBe("live for 1h 2m 3s");
    expect(replyTo("!uptime", { now: 5, liveSince: null })).toBe("offline");
    expect(replyTo("hello", { now: 0, liveSince: null })).toBeNull();
    expect(replyTo("!unknown", { now: 0, liveSince: null })).toBeNull();
    expect(formatUptime(65_000)).toBe("1m 5s");
    expect(formatUptime(-5)).toBe("0s");
  });

  test("tmi.js connection settings from a URL", () => {
    expect(tmiConnection("ws://localhost:6680")).toEqual({ server: "localhost", port: 6680, secure: false });
    expect(tmiConnection("wss://irc.example.test")).toEqual({ server: "irc.example.test", port: 443, secure: true });
    expect(() => tmiConnection("http://x")).toThrow(/ws:\/\//);
  });
});

const CHANNEL_ID = "0193a1b2-0000-7000-8000-000000000001";
const VIEWER = { id: "0193a1b2-0000-7000-8000-0000000000aa", username: "viewer_one" };

/** Fake chat service: validates every client frame against the contract. */
function startFakeChat(opts: { requireBearer?: string } = {}) {
  const received: ClientFrame[] = [];
  const sockets = new Set<ServerWebSocket<{ auth: string | null }>>();
  const send = (ws: ServerWebSocket<{ auth: string | null }>, f: ServerFrame) => ws.send(JSON.stringify(f));
  const message = (body: string, user = VIEWER): ServerFrame => ({
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
  const server = Bun.serve<{ auth: string | null }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization") ?? (url.searchParams.get("token") ? "token" : null);
      if (opts.requireBearer && auth !== `Bearer ${opts.requireBearer}`)
        return new Response("unauthorized", { status: 401 });
      return srv.upgrade(req, { data: { auth } }) ? undefined : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        send(ws, { op: "welcome", sessionId: "s1", user: null, heartbeatMs: 4_000 });
      },
      close(ws) {
        sockets.delete(ws);
      },
      message(ws, raw) {
        const frame = ClientFrame.parse(JSON.parse(String(raw)));
        received.push(frame);
        switch (frame.op) {
          case "join":
            send(ws, {
              op: "joined",
              channel: frame.channel,
              channelId: CHANNEL_ID,
              settings: ChannelChatSettings.parse({}),
              me: { badges: [], canModerate: false, canChat: true },
            });
            break;
          case "send":
            send(ws, {
              op: "ack",
              nonce: frame.nonce,
              id: frame.body === "rejected" ? null : crypto.randomUUID(),
              held: false,
            });
            if (frame.body === "rejected")
              send(ws, { op: "notice", channel: frame.channel, code: "msg_duplicate", text: "dup" });
            break;
          case "command":
            send(ws, { op: "notice", channel: frame.channel, code: "cmd_success", text: "ok" });
            break;
          case "ping":
            send(ws, { op: "pong", nonce: frame.nonce });
            break;
          case "part":
            send(ws, { op: "parted", channel: frame.channel });
            break;
        }
      },
    },
  });
  stops.push(() => server.stop(true));
  return {
    url: `ws://127.0.0.1:${server.port}/ws`,
    received,
    broadcast(f: ServerFrame) {
      for (const ws of sockets) send(ws, f);
    },
    message,
    raw(text: string) {
      for (const ws of sockets) ws.send(text);
    },
  };
}

describe("chat client", () => {
  test("welcome, join, send with ack, command notice, messages, invalid frames", async () => {
    const fake = startFakeChat();
    const chat = await ChatClient.connect({ url: `${fake.url}?token=t` });
    stops.push(() => chat.close());
    expect(chat.welcome?.heartbeatMs).toBe(4_000);
    const joined = await chat.join("chan");
    expect(joined.channelId).toBe(CHANNEL_ID);
    const ack = await chat.send("chan", "hello world");
    expect(ack.id).not.toBeNull();
    const rejected = await chat.send("chan", "rejected");
    expect(rejected.id).toBeNull();
    expect((await chat.waitFor("notice", (n) => n.code === "msg_duplicate")).text).toBe("dup");
    expect((await chat.command("chan", "slow", ["30"])).code).toBe("cmd_success");
    const incoming = chat.next("message");
    fake.broadcast(fake.message("hi there"));
    expect((await incoming).message.body).toBe("hi there");
    expect(chat.messages("chan")).toHaveLength(1);
    fake.raw('{"op":"mystery"}');
    await waitFor("invalid frame recorded", () => chat.invalidFrames.length === 1, {
      timeoutMs: 2_000,
      intervalMs: 20,
    });
    expect(fake.received.filter((f) => f.op === "send").every((f) => f.op === "send" && f.nonce)).toBe(true);
    await chat.part("chan");
  }, 30_000);

  test("server error frames reject waiters", async () => {
    const fake = startFakeChat();
    const chat = await ChatClient.connect({ url: fake.url });
    stops.push(() => chat.close());
    const waiting = chat.next("joined");
    fake.broadcast({ op: "error", code: "bad_token", message: "token expired" });
    await expect(waiting).rejects.toThrow(ChatProtocolError);
  });

  test("bearer auth for bots", async () => {
    const fake = startFakeChat({ requireBearer: "bot-token" });
    await expect(ChatClient.connect({ url: fake.url, connectTimeoutMs: 1_000 })).rejects.toThrow(/chat/);
    const chat = await ChatClient.connect({ url: fake.url, bearer: "bot-token" });
    stops.push(() => chat.close());
    expect(chat.isOpen).toBe(true);
    chat.close();
    expect(chat.isOpen).toBe(false);
    expect(() => chat.raw({ op: "ping" })).toThrow(/closed/);
  });
});

describe("SDK bot", () => {
  test("answers !ping through any BotSdk implementation and ignores itself", async () => {
    const fake = startFakeChat({ requireBearer: "bot-token" });
    const sdk: BotSdk = {
      api: {
        channels: { get: async () => ({ live: { startedAt: new Date(Date.now() - 65_500).toISOString() } }) },
      } as never,
      async connectChat(): Promise<BotChatConnection> {
        const chat = await ChatClient.connect({ url: fake.url, bearer: "bot-token" });
        return {
          join: async (c) => void (await chat.join(c)),
          say: async (c, t) => void (await chat.send(c, t)),
          onMessage: (h) =>
            chat.onFrame((f) => {
              if (f.op === "message")
                h({
                  channel: f.channel,
                  id: f.message.id,
                  userId: f.message.user.id,
                  username: f.message.user.username,
                  text: f.message.body,
                });
            }),
          close: () => chat.close(),
        };
      },
    };
    const botId = "0193a1b2-0000-7000-8000-0000000000bb";
    const bot = new SdkBot({ sdk, botUserId: botId, channels: ["chan"] });
    await bot.start();
    stops.push(() => bot.stop());
    fake.broadcast(fake.message("!ping"));
    fake.broadcast(fake.message("!uptime"));
    fake.broadcast(fake.message("!ping", { id: botId, username: "the_bot" }));
    await waitFor("two replies", () => bot.replies.length >= 2, { timeoutMs: 5_000, intervalMs: 20 });
    await Bun.sleep(100);
    expect(bot.replies.map((r) => r.reply).sort()).toEqual(["live for 1m 5s", "pong"]);
    const sent = fake.received.flatMap((f) => (f.op === "send" ? [f.body] : []));
    expect(sent.sort()).toEqual(["live for 1m 5s", "pong"]);
  });
});

/** Fake Twitch-dialect IRC over WebSocket, the shape the IRC gateway must present to tmi.js. */
function startFakeIrc(expectedToken: string) {
  const fromBot: string[] = [];
  let socket: ServerWebSocket<unknown> | null = null;
  let nick = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(ws) {
        socket = ws;
      },
      message(ws, raw) {
        for (const line of String(raw).split("\r\n").filter(Boolean)) {
          fromBot.push(line);
          const [cmd, ...rest] = line.split(" ");
          if (cmd === "CAP") ws.send(`:tmi.twitch.tv CAP * ACK :${rest.slice(1).join(" ").replace(/^:/, "")}`);
          else if (cmd === "PASS" && rest[0] !== `oauth:${expectedToken}`) {
            ws.send(":tmi.twitch.tv NOTICE * :Login authentication failed");
            ws.close();
          } else if (cmd === "NICK") {
            nick = rest[0] ?? "";
            for (const n of ["001", "002", "003", "004"]) ws.send(`:tmi.twitch.tv ${n} ${nick} :Welcome, GLHF!`);
            ws.send(`:tmi.twitch.tv 375 ${nick} :-`);
            ws.send(`:tmi.twitch.tv 372 ${nick} :You are in a maze of twisty passages.`);
            ws.send(`:tmi.twitch.tv 376 ${nick} :>`);
          } else if (cmd === "JOIN") {
            const channel = rest[0] ?? "";
            ws.send(`:${nick}!${nick}@${nick}.tmi.twitch.tv JOIN ${channel}`);
            ws.send(
              `@badge-info=;badges=;color=;display-name=${nick};emote-sets=0;mod=0;subscriber=0;user-type= :tmi.twitch.tv USERSTATE ${channel}`,
            );
            ws.send(
              `@emote-only=0;followers-only=-1;r9k=0;room-id=1;slow=0;subs-only=0 :tmi.twitch.tv ROOMSTATE ${channel}`,
            );
          } else if (cmd === "PRIVMSG") {
            ws.send(
              `@badge-info=;badges=;color=;display-name=${nick};mod=0;subscriber=0;user-type= :tmi.twitch.tv USERSTATE ${rest[0]}`,
            );
          } else if (cmd === "PING") {
            ws.send(":tmi.twitch.tv PONG tmi.twitch.tv :tmi.twitch.tv");
          }
        }
      },
    },
  });
  stops.push(() => server.stop(true));
  return {
    url: `ws://127.0.0.1:${server.port}`,
    fromBot,
    say(channel: string, user: string, text: string) {
      socket?.send(
        `@badge-info=;badges=;color=#1E90FF;display-name=${user};emotes=;id=${crypto.randomUUID()};mod=0;room-id=12345;subscriber=0;tmi-sent-ts=${Date.now()};turbo=0;user-id=2;user-type= :${user}!${user}@${user}.tmi.twitch.tv PRIVMSG #${channel} :${text}`,
      );
    },
    raw(line: string) {
      socket?.send(line);
    },
  };
}

describe("tmi.js bot", () => {
  test("unmodified tmi.js logs in with oauth:, joins and answers !ping / !uptime", async () => {
    const irc = startFakeIrc("bot-token");
    const started = Date.now() - 125_000;
    const bot = new TmiBot({
      url: irc.url,
      username: "harness_bot",
      token: "bot-token",
      channels: ["chan"],
      liveSince: () => started,
    });
    await bot.connect();
    stops.push(() => bot.disconnect());
    expect(irc.fromBot).toContain("PASS oauth:bot-token");
    expect(irc.fromBot).toContain("NICK harness_bot");
    await waitFor("JOIN sent", () => irc.fromBot.some((l) => l.startsWith("JOIN #chan")), {
      timeoutMs: 5_000,
      intervalMs: 20,
    });
    await Bun.sleep(200);
    irc.say("chan", "viewer", "!ping");
    irc.say("chan", "viewer", "!uptime");
    irc.say("chan", "viewer", "just chatting");
    await waitFor("two replies", () => bot.replies.length >= 2, { timeoutMs: 8_000, intervalMs: 50 });
    const privmsgs = irc.fromBot.filter((l) => l.startsWith("PRIVMSG"));
    expect(privmsgs).toContain("PRIVMSG #chan :pong");
    expect(privmsgs.some((l) => /^PRIVMSG #chan :live for 2m \ds$/.test(l))).toBe(true);
    expect(privmsgs).toHaveLength(2);
  }, 20_000);
});

describe("tmi.js bot event recording", () => {
  test("records chat with tags, CLEARCHAT timeout/ban/clear, CLEARMSG and NOTICE from real tmi.js", async () => {
    const irc = startFakeIrc("bot-token");
    const bot = new TmiBot({ url: irc.url, username: "Harness_Bot", token: "bot-token", channels: ["chan"] });
    await bot.connect();
    stops.push(() => bot.disconnect());
    expect(bot.username).toBe("harness_bot");
    await bot.events.waitForJoin("#chan", { timeoutMs: 5_000 });

    irc.say("chan", "viewer", "hello there");
    const seen = await bot.events.waitForMessage((m) => m.username === "viewer", "viewer line", { timeoutMs: 5_000 });
    expect(seen).toMatchObject({ channel: "chan", text: "hello there", self: false });
    // (tmi.js turns a tag value of "1" into `true`, so the fake uses a multi-digit room id.)
    expect(twitchTagProblems(seen, "viewer")).toEqual([]);

    const ts = Date.now();
    irc.raw(`@ban-duration=600;room-id=1;target-user-id=3;tmi-sent-ts=${ts} :tmi.twitch.tv CLEARCHAT #chan :troll`);
    irc.raw(`@room-id=1;target-user-id=4;tmi-sent-ts=${ts} :tmi.twitch.tv CLEARCHAT #chan :worse`);
    irc.raw(`@room-id=1;tmi-sent-ts=${ts} :tmi.twitch.tv CLEARCHAT #chan`);
    irc.raw(`@login=troll;room-id=1;target-msg-id=abc-123;tmi-sent-ts=${ts} :tmi.twitch.tv CLEARMSG #chan :bad words`);
    irc.raw("@msg-id=msg_timedout :tmi.twitch.tv NOTICE #chan :You are timed out for 600 more seconds.");

    const timeout = await bot.events.waitForModeration((e) => e.kind === "timeout", "timeout", { timeoutMs: 5_000 });
    expect(timeout).toMatchObject({ channel: "chan", username: "troll", durationSeconds: 600 });
    expect(timeout.tags["target-user-id"]).toBe("3");
    const ban = await bot.events.waitForModeration((e) => e.kind === "ban", "ban", { timeoutMs: 5_000 });
    expect(ban).toMatchObject({ username: "worse", durationSeconds: null });
    const clear = await bot.events.waitForModeration((e) => e.kind === "clearchat", "clear", { timeoutMs: 5_000 });
    expect(clear.username).toBeNull();
    const deleted = await bot.events.waitForModeration((e) => e.kind === "messagedeleted", "delete", {
      timeoutMs: 5_000,
    });
    expect(deleted).toMatchObject({ username: "troll", messageId: "abc-123" });
    await waitFor("notice", () => bot.events.notices.length > 0, { timeoutMs: 5_000, intervalMs: 20 });
    expect(bot.events.notices[0]).toMatchObject({ channel: "chan", msgId: "msg_timedout" });

    irc.say("chan", "viewer", "!ping");
    await waitFor("reply", () => bot.replies.length > 0, { timeoutMs: 5_000, intervalMs: 20 });
    const reply = bot.replies[0];
    expect(reply?.receivedAt).toBeTypeOf("number");
    expect((reply?.at ?? 0) >= (reply?.receivedAt ?? Infinity)).toBe(true);
  }, 20_000);

  test("event log handlers and waiters without a client", async () => {
    let now = 1_000;
    const log = new TmiEventLog(() => now);
    log.onMessage("#Chan", { username: "Alice", id: "1" }, "hi", false);
    now = 2_000;
    log.onTimeout("#chan", "Troll", 599, { "ban-duration": "599" });
    log.onMessageDeleted("#chan", "troll", { "target-msg-id": 7 });
    expect(log.messages[0]).toMatchObject({ channel: "chan", username: "alice", at: 1_000 });
    expect(log.moderation[0]).toMatchObject({ kind: "timeout", username: "troll", durationSeconds: 599, at: 2_000 });
    // A non-string target-msg-id is not trusted as an id.
    expect(log.moderation[1]?.messageId).toBeNull();
    expect((await log.waitForMessage((m) => m.text === "hi")).username).toBe("alice");
    const later = log.waitForModeration((e) => e.kind === "ban", "ban of x", { timeoutMs: 2_000 });
    log.onBan("#chan", "x");
    expect((await later).username).toBe("x");
    await expect(log.waitForJoin("chan", { timeoutMs: 50 })).rejects.toThrow(/join #chan/);
    await expect(log.waitForModeration(() => false, "nothing", { timeoutMs: 50 })).rejects.toThrow(/nothing/);
  });

  test("event log lists are capped, keeping the newest", () => {
    expect(EVENT_LOG_LIMIT).toBe(500);
    const log = new TmiEventLog(Date.now, 3);
    for (let i = 0; i < 5; i++) {
      log.onMessage("#c", { username: "u" }, `m${i}`, false);
      log.onTimeout("#c", `t${i}`, 600);
      log.onNotice("#c", "msg_timedout", `n${i}`);
    }
    expect(log.messages.map((m) => m.text)).toEqual(["m2", "m3", "m4"]);
    expect(log.moderation.map((e) => e.username)).toEqual(["t2", "t3", "t4"]);
    expect(log.notices.map((n) => n.text)).toEqual(["n2", "n3", "n4"]);
  });

  test("twitchTagProblems names what a Twitch bot would miss", () => {
    const good = {
      username: "fan",
      tags: {
        id: "m1",
        "user-id": "u1",
        "room-id": "r1",
        "display-name": "Fan",
        "tmi-sent-ts": "1700000000000",
        "message-type": "chat",
        badges: null,
        emotes: null,
        mod: false,
        subscriber: false,
        turbo: false,
        color: null,
        "user-type": null,
      },
    };
    expect(twitchTagProblems(good, "FAN")).toEqual([]);
    expect(twitchTagProblems(good, "other")).toEqual(["username is fan, expected other"]);
    const { id: _id, emotes: _e, ...rest } = good.tags;
    expect(
      twitchTagProblems({ username: "fan", tags: { ...rest, "tmi-sent-ts": "soon", "message-type": "action" } }),
    ).toEqual([
      "id missing",
      "tmi-sent-ts missing or not numeric",
      "message-type is action, expected chat",
      "emotes missing",
    ]);
  });
});
