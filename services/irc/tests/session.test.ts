// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { ChannelChatSettings, type ClientFrame, type ServerFrame } from "@commonair/contracts";
import type { ChatMessage } from "@commonair/contracts/dto";
import { createLogger } from "@commonair/observability";
import { parseMessage } from "../src/irc/message.ts";
import { IrcSession, type SessionLimits, type Transport } from "../src/session.ts";
import type { UpstreamCloseKind, UpstreamFrame, UpstreamHandlers } from "../src/upstream.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));
const USER = { id: "0190f1c2-0000-7000-8000-0000000000aa", username: "bot", displayName: "Bot" };
const CHANNEL_ID = "0190f1c2-0000-7000-8000-00000000c0de";
const settings = ChannelChatSettings.parse({});

function harness(limits: Partial<SessionLimits> = {}, opts: { failSend?: (f: ClientFrame) => boolean } = {}) {
  const out: string[] = [];
  let closed = false;
  let buffered = 0;
  const transport: Transport = {
    kind: "tcp",
    write: (lines) => out.push(...lines),
    bufferedBytes: () => buffered,
    close: () => {
      closed = true;
    },
  };
  const sent: ClientFrame[] = [];
  const tokens: (string | null)[] = [];
  let handlers: UpstreamHandlers | null = null;
  let upstreamClosed = false;
  const session = new IrcSession(transport, {
    logger: createLogger({ service: "test", write: () => {} }),
    motd: "hello",
    limits,
    upstream: (token, h) => {
      tokens.push(token);
      handlers = h;
      return {
        send: (f) => {
          if (opts.failSend?.(f)) throw new Error("upstream send failed");
          sent.push(f);
        },
        close: () => {
          upstreamClosed = true;
        },
      };
    },
  });
  const h = {
    session,
    out,
    sent,
    tokens,
    get closed() {
      return closed;
    },
    get upstreamClosed() {
      return upstreamClosed;
    },
    setBuffered: (n: number) => {
      buffered = n;
    },
    async lines(...ls: string[]) {
      for (const l of ls) session.line(l);
      await tick();
    },
    async frame(f: ServerFrame | UpstreamFrame) {
      handlers?.frame(f);
      await tick();
    },
    async upstreamClose(kind: UpstreamCloseKind) {
      handlers?.close(kind, "");
      await tick();
    },
    take() {
      return out.splice(0);
    },
    commands() {
      return out.splice(0).map((l) => parseMessage(l)?.command);
    },
    async login(caps = "twitch.tv/tags twitch.tv/commands twitch.tv/membership", user = USER) {
      await h.lines(`CAP REQ :${caps}`, "PASS oauth:secret-token", `NICK ${user.username}`);
      await h.frame({ op: "welcome", sessionId: "s", user, heartbeatMs: 30_000 });
    },
    async join(slug = "dallas", me = { badges: ["subscriber/2"], canModerate: false, canChat: true }) {
      await h.lines(`JOIN #${slug}`);
      await h.frame({ op: "joined", channel: slug, channelId: CHANNEL_ID, settings, me });
    },
  };
  return h;
}

function chat(over: Partial<ChatMessage> = {}, user: Partial<ChatMessage["user"]> = {}): ChatMessage {
  return {
    id: crypto.randomUUID(),
    channelId: CHANNEL_ID,
    user: {
      id: "0190f1c2-0000-7000-8000-0000000000bb",
      username: "viewer",
      displayName: "Viewer",
      color: null,
      badges: [],
      accountType: "human",
      ...user,
    },
    body: "hello",
    emotes: [],
    isAction: false,
    replyTo: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe("registration", () => {
  test("tmi.js flow: CAP REQ, PASS, NICK → welcome numerics and GLOBALUSERSTATE", async () => {
    const h = harness();
    await h.lines("CAP REQ :twitch.tv/tags twitch.tv/commands", "PASS oauth:abc", "NICK bot");
    expect(h.take()).toEqual([":tmi.twitch.tv CAP * ACK :twitch.tv/tags twitch.tv/commands"]);
    expect(h.tokens).toEqual(["abc"]);
    await h.frame({ op: "welcome", sessionId: "s", user: USER, heartbeatMs: 30_000 });
    const lines = h.take();
    expect(lines.map((l) => parseMessage(l)?.command)).toEqual([
      "001",
      "002",
      "003",
      "004",
      "375",
      "372",
      "376",
      "GLOBALUSERSTATE",
    ]);
    expect(lines[0]).toBe(":tmi.twitch.tv 001 bot :Welcome, GLHF!");
    expect(lines[5]).toBe(":tmi.twitch.tv 372 bot :hello");
    expect(parseMessage(lines[7] ?? "")?.tags).toMatchObject({ "display-name": "Bot", "user-id": USER.id });
    expect(h.session.registered).toBe(true);
    h.session.close("done", false);
  });

  test("PASS without the oauth: prefix is accepted", async () => {
    const h = harness();
    await h.lines("PASS rawtoken", "NICK bot");
    expect(h.tokens).toEqual(["rawtoken"]);
    h.session.close("done", false);
  });

  test("CAP LS suspends registration until CAP END", async () => {
    const h = harness();
    await h.lines("CAP LS 302", "PASS oauth:abc", "NICK bot");
    expect(h.take()).toEqual([":tmi.twitch.tv CAP * LS :twitch.tv/tags twitch.tv/commands twitch.tv/membership"]);
    expect(h.tokens).toEqual([]);
    await h.lines("CAP REQ :twitch.tv/tags", "CAP END");
    expect(h.tokens).toEqual(["abc"]);
    h.session.close("done", false);
  });

  test("justinfan without PASS (or with SCHMOOPIIE) connects anonymously", async () => {
    const h = harness();
    await h.lines("PASS SCHMOOPIIE", "NICK justinfan12345");
    expect(h.tokens).toEqual([null]);
    await h.frame({ op: "welcome", sessionId: "s", user: null, heartbeatMs: 30_000 });
    expect(h.take()[0]).toBe(":tmi.twitch.tv 001 justinfan12345 :Welcome, GLHF!");
    h.session.close("done", false);
  });

  test("a named nick without PASS is refused", async () => {
    const h = harness();
    await h.lines("NICK bot");
    expect(h.take()).toEqual([":tmi.twitch.tv NOTICE * :Improperly formatted auth"]);
    expect(h.closed).toBe(true);
  });

  test("upstream rejecting the token → Login authentication failed", async () => {
    const h = harness();
    await h.lines("PASS oauth:bad", "NICK bot");
    await h.upstreamClose("rejected");
    expect(h.take()).toEqual([":tmi.twitch.tv NOTICE * :Login authentication failed"]);
    expect(h.closed).toBe(true);
  });

  test("upstream welcome without a user for a token → Login authentication failed", async () => {
    const h = harness();
    await h.lines("PASS oauth:bad", "NICK bot");
    await h.frame({ op: "welcome", sessionId: "s", user: null, heartbeatMs: 30_000 });
    expect(h.take()).toEqual([":tmi.twitch.tv NOTICE * :Login authentication failed"]);
  });

  test("unreachable upstream → ERROR line, so clients retry", async () => {
    const h = harness();
    await h.lines("PASS oauth:x", "NICK bot");
    await h.upstreamClose("unreachable");
    expect(h.take()).toEqual(["ERROR :Closing Link: Chat service unavailable"]);
  });

  test("invalid NICK", async () => {
    const h = harness();
    await h.lines("NICK bad-nick!");
    expect(h.take()).toEqual([":tmi.twitch.tv NOTICE * :Invalid NICK"]);
    expect(h.closed).toBe(true);
  });

  test("commands before registration → 451", async () => {
    const h = harness();
    await h.lines("JOIN #dallas");
    expect(h.take()).toEqual([":tmi.twitch.tv 451 * JOIN :You have not registered"]);
    h.session.close("done", false);
  });

  test("registration timeout closes the connection", async () => {
    const h = harness({ registrationTimeoutMs: 20 });
    await new Promise((r) => setTimeout(r, 40));
    expect(h.take()).toEqual(["ERROR :Closing Link: Registration timeout"]);
    expect(h.closed).toBe(true);
  });
});

describe("channels", () => {
  test("JOIN → JOIN, 353, 366, USERSTATE, ROOMSTATE", async () => {
    const h = harness();
    await h.login();
    h.take();
    await h.lines("JOIN #Dallas");
    expect(h.sent.at(-1)).toMatchObject({ op: "join", channel: "dallas" });
    await h.frame({
      op: "joined",
      channel: "dallas",
      channelId: CHANNEL_ID,
      settings,
      me: { badges: ["moderator"], canModerate: true, canChat: true },
    });
    const lines = h.take();
    expect(lines.slice(0, 3)).toEqual([
      ":bot!bot@bot.tmi.twitch.tv JOIN #dallas",
      ":bot.tmi.twitch.tv 353 bot = #dallas :bot",
      ":bot.tmi.twitch.tv 366 bot #dallas :End of /NAMES list",
    ]);
    expect(parseMessage(lines[3] ?? "")).toMatchObject({
      command: "USERSTATE",
      tags: { mod: "1", "user-type": "mod", badges: "moderator/1" },
    });
    expect(parseMessage(lines[4] ?? "")).toMatchObject({ command: "ROOMSTATE", tags: { "room-id": CHANNEL_ID } });
    h.session.close("done", false);
  });

  test("without twitch.tv/commands only JOIN and NAMES are sent; without tags no tags", async () => {
    const h = harness();
    await h.login("twitch.tv/membership");
    h.take();
    await h.join();
    expect(h.commands()).toEqual(["JOIN", "353", "366"]);
    h.session.close("done", false);
  });

  test("JOIN a,b and PART", async () => {
    const h = harness();
    await h.login();
    await h.lines("JOIN #aaa,#bbb");
    expect(h.sent.slice(-2)).toMatchObject([
      { op: "join", channel: "aaa" },
      { op: "join", channel: "bbb" },
    ]);
    await h.frame({
      op: "joined",
      channel: "aaa",
      channelId: CHANNEL_ID,
      settings,
      me: { badges: [], canModerate: false, canChat: true },
    });
    h.take();
    await h.lines("PART #aaa");
    expect(h.sent.at(-1)).toMatchObject({ op: "part", channel: "aaa" });
    await h.frame({ op: "parted", channel: "aaa" });
    expect(h.take()).toEqual([":bot!bot@bot.tmi.twitch.tv PART #aaa"]);
    h.session.close("done", false);
  });

  test("invalid channel names → 403; too many channels → 405", async () => {
    const h = harness({ maxChannels: 2 });
    await h.login();
    h.take();
    await h.lines("JOIN #x,#aaa,#bbb,#ccc");
    expect(h.take()).toEqual([
      ":tmi.twitch.tv 403 bot #x :No such channel",
      ":tmi.twitch.tv 405 bot #ccc :You have joined too many channels",
    ]);
    expect(h.sent.filter((f) => f.op === "join")).toHaveLength(2);
    h.session.close("done", false);
  });

  test("a failure notice for a pending join frees the slot", async () => {
    const h = harness({ maxChannels: 1 });
    await h.login();
    await h.lines("JOIN #aaa");
    await h.frame({ op: "notice", channel: "aaa", code: "msg_channel_suspended", text: "suspended" });
    h.take();
    await h.lines("JOIN #bbb");
    expect(h.sent.at(-1)).toMatchObject({ op: "join", channel: "bbb" });
    h.session.close("done", false);
  });
});

describe("messages", () => {
  test("PRIVMSG → send; ack → USERSTATE; own echo is suppressed", async () => {
    const h = harness();
    await h.login();
    await h.join();
    h.take();
    await h.lines("PRIVMSG #dallas :hello world");
    const send = h.sent.at(-1);
    expect(send).toMatchObject({ op: "send", channel: "dallas", body: "hello world", isAction: false });
    const nonce = send?.op === "send" ? send.nonce : undefined;
    const id = crypto.randomUUID();
    // Upstream fan-out may deliver our own message before the ack.
    await h.frame({
      op: "message",
      channel: "dallas",
      message: chat({ id, body: "hello world" }, { id: USER.id, username: "bot" }),
    });
    await h.frame({ op: "ack", nonce, id, held: false });
    expect(h.commands()).toEqual(["USERSTATE"]);
    h.session.close("done", false);
  });

  test("own messages sent from another client are delivered", async () => {
    const h = harness();
    await h.login();
    await h.join();
    h.take();
    await h.frame({
      op: "message",
      channel: "dallas",
      message: chat({ body: "from web" }, { id: USER.id, username: "bot" }),
    });
    expect(h.take()).toHaveLength(1);
    h.session.close("done", false);
  });

  test("other users' messages: PRIVMSG with tags; membership adds a JOIN the first time", async () => {
    const h = harness();
    await h.login();
    await h.join();
    h.take();
    await h.frame({ op: "message", channel: "dallas", message: chat() });
    await h.frame({ op: "message", channel: "dallas", message: chat() });
    const lines = h.take();
    expect(lines.map((l) => parseMessage(l)?.command)).toEqual(["JOIN", "PRIVMSG", "PRIVMSG"]);
    expect(lines[0]).toBe(":viewer!viewer@viewer.tmi.twitch.tv JOIN #dallas");
    h.session.close("done", false);
  });

  test("ACTION, replies via reply-parent-msg-id client tag", async () => {
    const h = harness();
    await h.login();
    await h.join();
    await h.lines("PRIVMSG #dallas :\x01ACTION dances\x01");
    expect(h.sent.at(-1)).toMatchObject({ op: "send", body: "dances", isAction: true });
    const parent = crypto.randomUUID();
    await h.lines(`@reply-parent-msg-id=${parent} PRIVMSG #dallas :agreed`);
    expect(h.sent.at(-1)).toMatchObject({ op: "send", body: "agreed", replyToId: parent });
    h.session.close("done", false);
  });

  test("moderation commands: /ban → command frame; cmd_success → ban_success", async () => {
    const h = harness();
    await h.login();
    await h.join();
    h.take();
    await h.lines("PRIVMSG #dallas :/ban troll spamming");
    expect(h.sent.at(-1)).toMatchObject({
      op: "command",
      channel: "dallas",
      command: "ban",
      args: ["troll", "spamming"],
    });
    await h.frame({
      op: "notice",
      channel: "dallas",
      code: "cmd_success",
      text: "troll is now banned from this channel.",
    });
    expect(h.take()).toEqual([
      "@msg-id=ban_success :tmi.twitch.tv NOTICE #dallas :troll is now banned from this channel.",
    ]);
    h.session.close("done", false);
  });

  test("usage and unknown commands are answered locally", async () => {
    const h = harness();
    await h.login();
    await h.join();
    h.take();
    const before = h.sent.length;
    await h.lines("PRIVMSG #dallas :/ban", "PRIVMSG #dallas :/color red");
    expect(h.take()).toEqual([
      "@msg-id=usage_ban :tmi.twitch.tv NOTICE #dallas :Usage: /ban <username> [reason]",
      "@msg-id=unrecognized_cmd :tmi.twitch.tv NOTICE #dallas :Unrecognized command: /color",
    ]);
    expect(h.sent.length).toBe(before);
    h.session.close("done", false);
  });

  test("delete, clear, ban, settings, notices", async () => {
    const h = harness();
    await h.login();
    await h.join();
    const m = chat({ body: "bad words" });
    await h.frame({ op: "message", channel: "dallas", message: m });
    h.take();
    await h.frame({ op: "delete", channel: "dallas", messageId: m.id, username: "viewer" });
    await h.frame({ op: "clear", channel: "dallas" });
    await h.frame({
      op: "ban",
      channel: "dallas",
      userId: m.user.id,
      username: "viewer",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      reason: "",
    });
    await h.frame({ op: "settings", channel: "dallas", settings: { ...settings, slowModeSeconds: 10 } });
    await h.frame({ op: "settings", channel: "dallas", settings: { ...settings, slowModeSeconds: 10 } });
    await h.frame({ op: "notice", channel: "dallas", code: "msg_slowmode", text: "slow down" });
    const lines = h.take().map((l) => parseMessage(l));
    expect(lines.map((l) => l?.command)).toEqual(["CLEARMSG", "CLEARCHAT", "CLEARCHAT", "ROOMSTATE", "NOTICE"]);
    expect(lines[0]?.params).toEqual(["#dallas", "bad words"]);
    expect(lines[2]?.tags["ban-duration"]).toBe("60");
    expect(lines[3]?.tags).toEqual({ "room-id": CHANNEL_ID, slow: "10" });
    expect(lines[4]?.tags["msg-id"]).toBe("msg_slowmode");
    h.session.close("done", false);
  });

  test("anonymous sessions get no USERSTATE and their PRIVMSG still goes upstream (which refuses it)", async () => {
    const h = harness();
    await h.lines("CAP REQ :twitch.tv/tags twitch.tv/commands", "NICK justinfan999");
    await h.frame({ op: "welcome", sessionId: "s", user: null, heartbeatMs: 30_000 });
    h.take();
    await h.join();
    expect(h.commands()).toEqual(["JOIN", "353", "366", "ROOMSTATE"]);
    h.session.close("done", false);
  });
});

describe("limits and lifecycle", () => {
  test("PING/PONG: bare PING gets an unprefixed PONG (tmi.js), token PING is echoed", async () => {
    const h = harness();
    await h.lines("PING", "PING :abc");
    expect(h.take()).toEqual(["PONG :tmi.twitch.tv", ":tmi.twitch.tv PONG tmi.twitch.tv :abc"]);
    h.session.close("done", false);
  });

  test("overlong non-PRIVMSG line → 417; long PRIVMSG text is allowed", async () => {
    const h = harness();
    await h.login();
    await h.join();
    h.take();
    await h.lines(`JOIN #${"a".repeat(600)}`);
    expect(h.take()).toEqual([":tmi.twitch.tv 417 bot :Input line was too long"]);
    await h.lines(`PRIVMSG #dallas :${"é".repeat(500)}`);
    expect(h.sent.at(-1)).toMatchObject({ op: "send", body: "é".repeat(500) });
    await h.lines(`@${"a=b;".repeat(2100)} PING`);
    expect(h.take()).toEqual([":tmi.twitch.tv 417 bot :Input line was too long"]);
    h.session.close("done", false);
  });

  test("flooding: excess lines are dropped with one notice, sustained flood disconnects", async () => {
    const h = harness({ rateBurst: 5, ratePerSecond: 0.001, floodDisconnectAfter: 10 });
    await h.login();
    h.take();
    for (let i = 0; i < 8; i++) h.session.line("PING :x");
    await tick();
    const lines = h.take();
    // Burst of 5, of which CAP/PASS/NICK used 3.
    expect(lines.filter((l) => l.includes("PONG"))).toHaveLength(2);
    expect(lines.filter((l) => l.includes("msg_ratelimit"))).toHaveLength(1);
    for (let i = 0; i < 20; i++) h.session.line("PING :x");
    await tick();
    expect(h.take().at(-1)).toBe("ERROR :Closing Link: Excess Flood");
    expect(h.closed).toBe(true);
    expect(h.upstreamClosed).toBe(true);
  });

  test("slow consumers are disconnected", async () => {
    const h = harness({ maxBufferedBytes: 100 });
    await h.login();
    await h.join();
    h.setBuffered(1000);
    await h.frame({ op: "message", channel: "dallas", message: chat() });
    expect(h.closed).toBe(true);
  });

  test("idle clients are PINGed, then dropped", async () => {
    const h = harness({ idlePingMs: 40 });
    await h.login();
    h.take();
    await new Promise((r) => setTimeout(r, 70));
    expect(h.take()).toContain("PING :tmi.twitch.tv");
    await new Promise((r) => setTimeout(r, 60));
    expect(h.take()).toContain("ERROR :Closing Link: Ping timeout");
    expect(h.closed).toBe(true);
  });

  test("upstream close after registration → ERROR and disconnect", async () => {
    const h = harness();
    await h.login();
    h.take();
    await h.upstreamClose("closed");
    expect(h.take()).toEqual(["ERROR :Closing Link: Chat connection closed"]);
    expect(h.closed).toBe(true);
  });

  test("RECONNECT on shutdown (commands cap only); QUIT closes both sides", async () => {
    const h = harness();
    await h.login();
    h.take();
    h.session.announceReconnect();
    await tick();
    expect(h.take()).toEqual([":tmi.twitch.tv RECONNECT"]);
    await h.lines("QUIT :bye");
    expect(h.take()).toEqual(["ERROR :Closing Link: Quit"]);
    expect(h.upstreamClosed).toBe(true);
    const plain = harness();
    await plain.login("twitch.tv/tags");
    plain.take();
    plain.session.announceReconnect();
    await tick();
    expect(plain.take()).toEqual([]);
    plain.session.close("done", false);
  });

  test("unknown commands after registration → 421", async () => {
    const h = harness();
    await h.login();
    h.take();
    await h.lines("WHO #dallas");
    expect(h.take()).toEqual([":tmi.twitch.tv 421 bot WHO :Unknown command"]);
    h.session.close("done", false);
  });
});

const nonceOf = (f: ClientFrame | undefined) => (f && "nonce" in f ? f.nonce : undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const notMember = { badges: [], canModerate: false, canChat: true };

describe("reply pairing by nonce", () => {
  test("every join/part/send/command carries a unique nonce", async () => {
    const h = harness();
    await h.login();
    await h.join();
    await h.lines("PRIVMSG #dallas :hi", "PRIVMSG #dallas :/ban troll", "PART #dallas");
    const nonces = h.sent.filter((f) => f.op !== "ping").map(nonceOf);
    expect(nonces).toHaveLength(4);
    expect(nonces.every((n) => typeof n === "string")).toBe(true);
    expect(new Set(nonces).size).toBe(nonces.length);
    h.session.close("done", false);
  });

  test("replies arriving out of order are paired with the right command", async () => {
    const h = harness();
    await h.login();
    await h.join();
    h.take();
    await h.lines("PRIVMSG #dallas :/ban troll", "PRIVMSG #dallas :/timeout other 60");
    const [ban, timeout] = h.sent.slice(-2);
    await h.frame({ op: "notice", channel: "dallas", code: "cmd_success", text: "timed out", nonce: nonceOf(timeout) });
    await h.frame({ op: "notice", channel: "dallas", code: "no_permission", text: "nope", nonce: nonceOf(ban) });
    expect(h.take()).toEqual([
      "@msg-id=timeout_success :tmi.twitch.tv NOTICE #dallas :timed out",
      "@msg-id=no_permission :tmi.twitch.tv NOTICE #dallas :nope",
    ]);
    h.session.close("done", false);
  });

  test("a notice for a send's nonce does not consume a pending command", async () => {
    const h = harness();
    await h.login();
    await h.join();
    await h.lines("PRIVMSG #dallas :/ban troll", "PRIVMSG #dallas :hello");
    const [ban, send] = h.sent.slice(-2);
    h.take();
    await h.frame({ op: "notice", channel: "dallas", code: "msg_slowmode", text: "slow", nonce: nonceOf(send) });
    await h.frame({ op: "notice", channel: "dallas", code: "cmd_success", text: "banned", nonce: nonceOf(ban) });
    expect(h.take()).toEqual([
      "@msg-id=msg_slowmode :tmi.twitch.tv NOTICE #dallas :slow",
      "@msg-id=ban_success :tmi.twitch.tv NOTICE #dallas :banned",
    ]);
    h.session.close("done", false);
  });

  test("without a nonce, the oldest pending command on that channel takes any notice", async () => {
    const h = harness();
    await h.login();
    await h.join();
    h.take();
    await h.lines("PRIVMSG #dallas :/unban a", "PRIVMSG #dallas :/vip b");
    await h.frame({ op: "notice", channel: "dallas", code: "invalid_user", text: "no such user" });
    await h.frame({ op: "notice", channel: "dallas", code: "cmd_success", text: "added" });
    expect(h.take()).toEqual([
      "@msg-id=invalid_user :tmi.twitch.tv NOTICE #dallas :no such user",
      "@msg-id=vip_success :tmi.twitch.tv NOTICE #dallas :added",
    ]);
    h.session.close("done", false);
  });

  test("an error frame for a join's nonce frees the slot and reports msg_room_not_found", async () => {
    const h = harness({ maxChannels: 1 });
    await h.login();
    h.take();
    await h.lines("JOIN #ghost");
    const nonce = nonceOf(h.sent.at(-1));
    await h.frame({ op: "error", code: "not_found", message: "No such channel", channel: "ghost", nonce });
    expect(h.take()).toEqual(["@msg-id=msg_room_not_found :tmi.twitch.tv NOTICE #ghost :No such channel"]);
    await h.lines("JOIN #other");
    expect(h.sent.at(-1)).toMatchObject({ op: "join", channel: "other" });
    h.session.close("done", false);
  });
});

describe("join pacing and expiry", () => {
  const joinsSent = (h: ReturnType<typeof harness>) => h.sent.flatMap((f) => (f.op === "join" ? [f.channel] : []));

  test("joins beyond the burst are paced at the control rate", async () => {
    const h = harness({ controlBurst: 2, controlPerSecond: 20 });
    await h.login();
    await h.lines("JOIN #aaa,#bbb,#ccc,#ddd");
    expect(joinsSent(h)).toEqual(["aaa", "bbb"]);
    await sleep(70);
    expect(joinsSent(h)).toEqual(["aaa", "bbb", "ccc"]);
    await sleep(60);
    expect(joinsSent(h)).toEqual(["aaa", "bbb", "ccc", "ddd"]);
    h.session.close("done", false);
  });

  test("parting a queued join drops it without sending anything", async () => {
    const h = harness({ controlBurst: 1, controlPerSecond: 20 });
    await h.login();
    await h.lines("JOIN #aaa,#bbb", "PART #bbb");
    await sleep(120);
    expect(h.sent.filter((f) => f.op === "join" || f.op === "part")).toMatchObject([{ op: "join", channel: "aaa" }]);
    h.session.close("done", false);
  });

  test("unanswered joins expire, freeing the channel cap, and can be retried", async () => {
    const h = harness({ maxChannels: 1, joinTimeoutMs: 30 });
    await h.login();
    h.take();
    await h.lines("JOIN #slow", "JOIN #other");
    expect(h.take()).toEqual([":tmi.twitch.tv 405 bot #other :You have joined too many channels"]);
    await sleep(50);
    await h.lines("JOIN #slow");
    expect(joinsSent(h)).toEqual(["slow", "slow"]);
    await h.frame({ op: "joined", channel: "slow", channelId: CHANNEL_ID, settings, me: notMember });
    expect(h.session.channelCount).toBe(1);
    h.session.close("done", false);
  });

  test("a `joined` for a channel we no longer want is parted upstream", async () => {
    const h = harness({ joinTimeoutMs: 20 });
    await h.login();
    await h.lines("JOIN #late");
    await sleep(40);
    h.take();
    await h.frame({ op: "joined", channel: "late", channelId: CHANNEL_ID, settings, me: notMember });
    expect(h.take()).toEqual([]);
    expect(h.sent.at(-1)).toMatchObject({ op: "part", channel: "late" });
    expect(h.session.channelCount).toBe(0);
    h.session.close("done", false);
  });
});

describe("hostile input", () => {
  test("client tokens echoed as middle params are sanitized", async () => {
    const h = harness();
    await h.lines("CAP :FOO BAR");
    expect(h.take()).toEqual([":tmi.twitch.tv 410 * FOOBAR :Invalid CAP command"]);
    await h.login();
    h.take();
    await h.lines("JOIN #ok_chan,:x", "JOIN :#a b");
    expect(h.take()).toEqual([
      ":tmi.twitch.tv 403 bot x :No such channel",
      ":tmi.twitch.tv 403 bot #ab :No such channel",
    ]);
    h.session.close("done", false);
  });

  test("an exception while handling one line does not drop the following lines", async () => {
    const h = harness({}, { failSend: (f) => f.op === "join" });
    await h.login();
    h.take();
    await h.lines("JOIN #boom", "PING :still-here");
    expect(h.take()).toEqual([":tmi.twitch.tv PONG tmi.twitch.tv :still-here"]);
    expect(h.closed).toBe(false);
    h.session.close("done", false);
  });
});
