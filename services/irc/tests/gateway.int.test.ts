// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * End-to-end: unmodified tmi.js (WebSocket) and raw TCP/TLS clients against the
 * gateway, which talks to a fake upstream chat service over the real protocol.
 */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import tmi from "tmi.js";
import { createLogger } from "@commonair/observability";
import { startGateway, type Gateway } from "../src/gateway.ts";
import { startHealth } from "../src/health.ts";
import { trustedProxies } from "../src/env.ts";
import { generateSelfSignedCert } from "../src/tls.ts";
import { websocketUpstream } from "../src/upstream.ts";
import { channelIdOf, startFakeUpstream } from "./helpers/fake-upstream.ts";
import { rawClient, wsRawClient } from "./helpers/raw-client.ts";

const logger = createLogger({ service: "irc-test", write: () => {} });
const users = {
  "streamer-token": {
    id: "0190f1c2-0000-7000-8000-000000000001",
    username: "streamer",
    displayName: "Streamer",
    moderator: true,
  },
  "viewer-token": { id: "0190f1c2-0000-7000-8000-000000000002", username: "viewer", displayName: "Viewer" },
};
const tlsMaterial = generateSelfSignedCert();
let upstream: ReturnType<typeof startFakeUpstream>;
let gateway: Gateway;

beforeAll(() => {
  upstream = startFakeUpstream(users);
  gateway = startGateway({
    hostname: "127.0.0.1",
    tcpPort: 0,
    tlsPort: 0,
    wsPort: 0,
    tls: tlsMaterial,
    upstream: websocketUpstream(upstream.url, logger),
    logger,
    motd: "test instance",
  });
});
afterAll(async () => {
  await gateway.shutdown(200);
  await upstream.stop();
});

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
};
const once = <T extends unknown[]>(client: tmi.Client, event: string, pred: (...args: T) => boolean = () => true) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${event} event`)), 3000);
    const handler = (...args: T) => {
      if (!pred(...args)) return;
      clearTimeout(timer);
      client.removeListener(event as keyof tmi.Events, handler as never);
      resolve(args);
    };
    client.on(event as keyof tmi.Events, handler as never);
  });

function tmiClient(identity?: { username: string; password: string }, port = gateway.ports.ws ?? 0) {
  return new tmi.Client({
    // skipUpdatingEmotesets: otherwise tmi.js fetches emote sets from Twitch's API on login.
    options: { skipUpdatingEmotesets: true, skipMembership: false },
    connection: { server: "127.0.0.1", port, secure: false, reconnect: false },
    identity,
    channels: [],
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

describe("unmodified tmi.js over WebSocket", () => {
  test("login, join, receive tagged PRIVMSG, send, !command round-trip, moderation, CLEARCHAT and NOTICE", async () => {
    const client = tmiClient({ username: "streamer", password: "oauth:streamer-token" });
    await client.connect();
    expect(client.getUsername()).toBe("streamer");
    expect(upstream.authHeaders.at(-1)).toBe("Bearer streamer-token");

    const roomstate = once<[string, tmi.RoomState]>(client, "roomstate");
    await client.join("dallas");
    const [, rs] = await roomstate;
    expect(rs["room-id"]).toBe(channelIdOf("dallas"));
    expect(client.isMod("#dallas", "streamer")).toBe(true);

    // A tagged PRIVMSG from someone else, with an emote after an astral character.
    const incoming = once<[string, tmi.ChatUserstate, string, boolean]>(client, "message", (_c, _t, msg) =>
      msg.includes("Kappa"),
    );
    const body = "🎉 Kappa";
    upstream.broadcast("dallas", {
      op: "message",
      channel: "dallas",
      message: upstream.message("dallas", { ...users["viewer-token"], moderator: false }, body, {
        emotes: [{ emoteId: "25", code: "Kappa", start: 3, end: 8 }],
        user: {
          id: users["viewer-token"].id,
          username: "viewer",
          displayName: "Viewer",
          color: "chat-2",
          badges: [{ type: "subscriber", tier: 2 }, { type: "vip" }],
          accountType: "human",
        },
      }),
    });
    const [channel, tags, text, self] = await incoming;
    expect(channel).toBe("#dallas");
    expect(text).toBe(body);
    expect(self).toBe(false);
    expect(tags.username).toBe("viewer");
    expect(tags["display-name"]).toBe("Viewer");
    expect(tags.color).toBe("#0000FF");
    expect(tags.badges).toEqual({ subscriber: "2000", vip: "1" });
    expect(tags.emotes).toEqual({ "25": ["2-6"] });
    expect(tags.subscriber).toBe(true);
    expect(tags["room-id"]).toBe(channelIdOf("dallas"));

    // Our own message goes upstream and is not echoed back as someone else's.
    const echoes: string[] = [];
    client.on("message", (_c, _t, msg, isSelf) => {
      if (!isSelf && msg === "hello chat") echoes.push(msg);
    });
    await client.say("dallas", "hello chat");
    await until(() => upstream.received.some((r) => r.frame.op === "send" && r.frame.body === "hello chat"));

    // `!ping` → the fake upstream's bot answers in the room.
    const botReply = once<[string, tmi.ChatUserstate, string]>(
      client,
      "message",
      (_c, t) => t.username === "commonairbot",
    );
    await client.say("dallas", "!ping");
    const [, botTags, botText] = await botReply;
    expect(botText).toBe("@streamer pong!");
    expect(botTags["display-name"]).toBe("CommonAirBot");

    // /me → action
    await client.action("dallas", "waves");
    await until(() =>
      upstream.received.some((r) => r.frame.op === "send" && r.frame.isAction && r.frame.body === "waves"),
    );

    // client.ban() resolves on ban_success, and the CLEARCHAT reaches the `ban` event.
    const banEvent = once<[string, string]>(client, "ban");
    await expect(client.ban("dallas", "troll", "spam")).resolves.toEqual(["#dallas", "troll", "spam"]);
    expect((await banEvent)[1]).toBe("troll");
    expect(upstream.received.at(-1)?.frame).toMatchObject({ op: "command", command: "ban", args: ["troll", "spam"] });

    // timeout → CLEARCHAT with ban-duration
    const timeoutEvent = once<[string, string, string, number]>(client, "timeout");
    await client.timeout("dallas", "troll", 300, "cool off");
    const [, who, , duration] = await timeoutEvent;
    expect(who).toBe("troll");
    expect(duration).toBeGreaterThanOrEqual(299);

    // Chat cleared and an upstream NOTICE.
    const cleared = once<[string]>(client, "clearchat");
    upstream.broadcast("dallas", { op: "clear", channel: "dallas" });
    expect((await cleared)[0]).toBe("#dallas");
    const notice = once<[string, string, string]>(client, "notice", (_c, id) => id === "msg_slowmode");
    upstream.broadcast("dallas", { op: "notice", channel: "dallas", code: "msg_slowmode", text: "slow mode" });
    expect((await notice)[2]).toBe("slow mode");

    // A held message is reported as AutoMod.
    const automod = once<[string, string]>(client, "automod");
    upstream.broadcast("dallas", { op: "notice", channel: "dallas", code: "msg_held", text: "held for review" });
    expect((await automod)[1]).toBe("msg_rejected");

    // Subs and raids arrive as USERNOTICE.
    const raided = once<[string, string, number]>(client, "raided");
    upstream.broadcast("dallas", {
      op: "event",
      channel: "dallas",
      type: "channel.raid",
      data: {
        from_broadcaster_user_id: "0190f1c2-0000-7000-8000-0000000000ee",
        from_broadcaster_user_login: "raider",
        from_broadcaster_user_name: "Raider",
        to_broadcaster_user_id: channelIdOf("dallas"),
        to_broadcaster_user_login: "dallas",
        to_broadcaster_user_name: "Dallas",
        viewers: 12,
      },
    });
    expect(await raided).toEqual(["#dallas", "Raider", 12, expect.anything()]);

    expect(echoes).toEqual([]);
    await client.part("dallas");
    await client.disconnect();
  });

  test("a viewer without moderator rights gets no_permission for /ban", async () => {
    const client = tmiClient({ username: "viewer", password: "viewer-token" });
    await client.connect();
    await client.join("dallas");
    await expect(client.ban("dallas", "someone")).rejects.toBe("no_permission");
    await client.disconnect();
  });

  test("anonymous justinfan is read-only", async () => {
    const client = tmiClient();
    await client.connect();
    expect(client.getUsername()).toMatch(/^justinfan\d+$/);
    expect(upstream.authHeaders.at(-1)).toBeNull();
    await client.join("dallas");
    const got = once<[string, tmi.ChatUserstate, string]>(client, "message");
    upstream.broadcast("dallas", {
      op: "message",
      channel: "dallas",
      message: upstream.message("dallas", users["viewer-token"], "hi lurkers"),
    });
    expect((await got)[2]).toBe("hi lurkers");
    await expect(client.say("dallas", "can I talk?")).rejects.toBe("Cannot send anonymous messages.");
    await client.disconnect();
  });

  test("an invalid token fails login", async () => {
    const client = tmiClient({ username: "viewer", password: "oauth:wrong" });
    await expect(client.connect()).rejects.toBe("Login authentication failed");
  });
});

describe("raw clients", () => {
  test("plain TCP: CAP LS/REQ/END negotiation, login, JOIN, PRIVMSG both ways, batched lines", async () => {
    const c = await rawClient({ port: gateway.ports.tcp ?? 0 });
    c.send("CAP LS 302");
    await c.waitFor((m) => m.command === "CAP" && m.params[1] === "LS");
    // Several lines in one write, as many clients do.
    c.send(
      "CAP REQ :twitch.tv/tags twitch.tv/commands",
      "PASS oauth:viewer-token",
      "NICK viewer",
      "USER viewer 0 * :viewer",
    );
    await c.waitFor((m) => m.command === "CAP" && m.params[1] === "ACK");
    await Bun.sleep(50);
    expect(c.lines.some((l) => l.includes(" 001 "))).toBe(false); // still suspended until CAP END
    c.send("CAP END");
    await c.waitFor((_m, raw) => raw === ":tmi.twitch.tv 001 viewer :Welcome, GLHF!");
    await c.waitFor((m) => m.command === "376");
    await c.waitFor((m) => m.command === "GLOBALUSERSTATE");

    c.send("JOIN #dallas");
    await c.waitFor((m) => m.command === "JOIN" && m.prefix === "viewer!viewer@viewer.tmi.twitch.tv");
    await c.waitFor((m) => m.command === "ROOMSTATE");

    upstream.broadcast("dallas", {
      op: "message",
      channel: "dallas",
      message: upstream.message("dallas", users["streamer-token"], "welcome in"),
    });
    const pm = await c.waitFor((m) => m.command === "PRIVMSG");
    expect(pm.params).toEqual(["#dallas", "welcome in"]);
    expect(pm.tags).toMatchObject({ "display-name": "Streamer", mod: "1", "user-type": "mod", color: "#FF0000" });

    c.send("PRIVMSG #dallas :raw hello");
    await c.waitFor((m) => m.command === "USERSTATE");
    expect(
      upstream.received.some((r) => r.user === "viewer" && r.frame.op === "send" && r.frame.body === "raw hello"),
    ).toBe(true);

    c.send("PING :keepalive");
    await c.waitFor((_m, raw) => raw === ":tmi.twitch.tv PONG tmi.twitch.tv :keepalive");
    c.send("QUIT");
    await c.closed;
  });

  test("TLS with the ephemeral certificate", async () => {
    const c = await rawClient({ port: gateway.ports.tls ?? 0, tls: { ca: tlsMaterial.cert } });
    expect(c.authorized).toBe(true);
    c.send("PASS oauth:streamer-token", "NICK streamer");
    await c.waitFor((m) => m.command === "376");
    c.send("JOIN #tlsroom");
    await c.waitFor((m) => m.command === "366");
    c.close();
    await c.closed;
  });

  test("upstream closing → ERROR line and disconnect", async () => {
    const c = await rawClient({ port: gateway.ports.tcp ?? 0 });
    c.send("PASS oauth:viewer-token", "NICK viewer");
    await c.waitFor((m) => m.command === "376");
    await until(() => gateway.stats().registered >= 1);
    upstream.dropAll();
    const err = await c.waitFor((m) => m.command === "ERROR");
    expect(err.params).toEqual(["Closing Link: Chat connection closed"]);
    await c.closed;
  });
});

describe("health and shutdown", () => {
  test("/stats reports connection counts; shutdown sends RECONNECT and closes clients", async () => {
    const up = startFakeUpstream(users);
    const gw = startGateway({
      hostname: "127.0.0.1",
      tcpPort: 0,
      tlsPort: null,
      wsPort: 0,
      upstream: websocketUpstream(up.url, logger),
      logger,
      motd: "m",
    });
    const health = startHealth({ gateway: gw, port: 0, hostname: "127.0.0.1", logger });
    try {
      const c = await rawClient({ port: gw.ports.tcp ?? 0 });
      c.send("CAP REQ :twitch.tv/commands", "PASS oauth:viewer-token", "NICK viewer");
      await c.waitFor((m) => m.command === "376");
      const ws = tmiClient({ username: "streamer", password: "oauth:streamer-token" }, gw.ports.ws ?? 0);
      await ws.connect();
      await ws.join("dallas");

      const stats = (await (await fetch(new URL("/stats", health.url))).json()) as {
        connections: Record<string, number>;
        registered: number;
        channels: number;
      };
      expect(stats.connections).toEqual({ tcp: 1, tls: 0, ws: 1 });
      expect(stats.registered).toBe(2);
      expect(stats.channels).toBe(1);
      expect((await fetch(new URL("/readyz", health.url))).status).toBe(200);

      const disconnected = once<[string]>(ws, "disconnected");
      await health.stop(); // runs gateway.shutdown()
      await c.waitFor((m) => m.command === "RECONNECT");
      await c.closed;
      await disconnected;
      expect(gw.stats().total).toBe(0);
    } finally {
      await up.stop();
    }
  });
});

describe("WebSocket subprotocols", () => {
  test("no subprotocol: upgrade succeeds and batched lines work", async () => {
    const c = await wsRawClient({ port: gateway.ports.ws ?? 0 });
    expect(c.protocol).toBe("");
    c.send("PASS oauth:viewer-token", "NICK viewer");
    await c.waitFor((_m, raw) => raw === ":tmi.twitch.tv 001 viewer :Welcome, GLHF!");
    c.close();
    await c.closed;
  });

  test("text.ircv3.net is negotiated and echoed", async () => {
    const c = await wsRawClient({ port: gateway.ports.ws ?? 0, protocols: ["text.ircv3.net"] });
    expect(c.protocol).toBe("text.ircv3.net");
    c.send("PASS oauth:viewer-token");
    c.send("NICK viewer");
    await c.waitFor((m) => m.command === "376");
    c.close();
    await c.closed;
  });

  test("an unsupported subprotocol is refused", async () => {
    await expect(wsRawClient({ port: gateway.ports.ws ?? 0, protocols: ["mqtt"] })).rejects.toThrow(/failed to open/);
  });
});

describe("reply pairing end to end", () => {
  test("a broadcast notice without a nonce does not steal a command's success", async () => {
    const c = await rawClient({ port: gateway.ports.tcp ?? 0 });
    c.send("CAP REQ :twitch.tv/tags twitch.tv/commands", "PASS oauth:streamer-token", "NICK streamer");
    await c.waitFor((m) => m.command === "376");
    c.send("JOIN #pairing");
    await c.waitFor((m) => m.command === "ROOMSTATE");
    c.send("PRIVMSG #pairing :/slow 10", "PRIVMSG #pairing :/ban troll");
    await c.waitFor((m) => m.command === "NOTICE" && m.tags["msg-id"] === "slow_on");
    const ban = await c.waitFor((m) => m.command === "NOTICE" && m.tags["msg-id"] === "ban_success");
    expect(ban.params).toEqual(["#pairing", "troll done."]);
    c.send("QUIT");
    await c.closed;
  });

  test("tmi.js join() of a channel upstream rejects fails fast and frees the slot", async () => {
    const client = tmiClient({ username: "viewer", password: "oauth:viewer-token" });
    await client.connect();
    await expect(client.join("missingchan")).rejects.toBe("msg_room_not_found");
    await expect(client.join("dallas")).resolves.toEqual(["#dallas"]);
    await client.disconnect();
  });
});

describe("connection admission", () => {
  async function withGateway(
    extra: Pick<Parameters<typeof startGateway>[0], "connectionLimits" | "trustedProxies">,
    fn: (gw: Gateway) => Promise<void>,
  ) {
    const up = startFakeUpstream(users);
    const gw = startGateway({
      hostname: "127.0.0.1",
      tcpPort: 0,
      tlsPort: null,
      wsPort: 0,
      upstream: websocketUpstream(up.url, logger),
      logger,
      motd: "m",
      ...extra,
    });
    try {
      await fn(gw);
    } finally {
      await gw.shutdown(50);
      await up.stop();
    }
  }

  test("per-IP cap refuses with an ERROR line and frees the slot on disconnect", async () => {
    await withGateway({ connectionLimits: { maxPerIp: 1 } }, async (gw) => {
      const first = await rawClient({ port: gw.ports.tcp ?? 0 });
      first.send("PASS oauth:viewer-token", "NICK viewer");
      await first.waitFor((m) => m.command === "376");
      const second = await rawClient({ port: gw.ports.tcp ?? 0 });
      const err = await second.waitFor((m) => m.command === "ERROR");
      expect(err.params).toEqual(["Closing Link: Too many connections from your address"]);
      await second.closed;
      first.send("QUIT");
      await first.closed;
      await until(() => gw.stats().total === 0);
      const third = await rawClient({ port: gw.ports.tcp ?? 0 });
      third.send("PASS oauth:viewer-token", "NICK viewer");
      await third.waitFor((m) => m.command === "376");
      third.close();
      await third.closed;
    });
  });

  test("global cap and connection rate", async () => {
    await withGateway({ connectionLimits: { maxConnections: 1 } }, async (gw) => {
      const first = await rawClient({ port: gw.ports.tcp ?? 0 });
      const second = await rawClient({ port: gw.ports.tcp ?? 0 });
      expect((await second.waitFor((m) => m.command === "ERROR")).params).toEqual(["Closing Link: Server full"]);
      first.close();
      await first.closed;
    });
    await withGateway({ connectionLimits: { connectBurstPerIp: 2, connectPerSecondPerIp: 0.01 } }, async (gw) => {
      const a = await rawClient({ port: gw.ports.tcp ?? 0 });
      const b = await rawClient({ port: gw.ports.tcp ?? 0 });
      const c = await rawClient({ port: gw.ports.tcp ?? 0 });
      expect((await c.waitFor((m) => m.command === "ERROR")).params).toEqual(["Closing Link: Reconnecting too fast"]);
      a.close();
      b.close();
      await Promise.all([a.closed, b.closed]);
    });
  });

  test("X-Forwarded-For counts per client only behind a trusted proxy", async () => {
    const xff = (ip: string) => ({ "X-Forwarded-For": ip });
    const register = async (c: Awaited<ReturnType<typeof wsRawClient>>) => {
      c.send("PASS oauth:viewer-token", "NICK viewer");
      return c.waitFor((m) => m.command === "376" || m.command === "ERROR");
    };
    await withGateway(
      { connectionLimits: { maxPerIp: 1 }, trustedProxies: trustedProxies(["127.0.0.1/32"]) },
      async (gw) => {
        const port = gw.ports.ws ?? 0;
        const a = await wsRawClient({ port, headers: xff("198.51.100.1") });
        const b = await wsRawClient({ port, headers: xff("198.51.100.2") });
        expect((await register(a)).command).toBe("376");
        expect((await register(b)).command).toBe("376");
        const again = await wsRawClient({ port, headers: xff("198.51.100.1") });
        expect((await again.waitFor((m) => m.command === "ERROR")).params[0]).toMatch(/Too many connections/);
        a.close();
        b.close();
      },
    );
    await withGateway({ connectionLimits: { maxPerIp: 1 } }, async (gw) => {
      const port = gw.ports.ws ?? 0;
      const a = await wsRawClient({ port, headers: xff("198.51.100.1") });
      expect((await register(a)).command).toBe("376");
      // Untrusted peer: the header is ignored, so this is the same address (127.0.0.1).
      const spoof = await wsRawClient({ port, headers: xff("198.51.100.2") });
      expect((await spoof.waitFor((m) => m.command === "ERROR")).params[0]).toMatch(/Too many connections/);
      a.close();
    });
  });
});
