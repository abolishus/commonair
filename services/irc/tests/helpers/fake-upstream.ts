// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A fake chat service speaking the real ClientFrame/ServerFrame protocol, for
 * gateway integration tests. It authenticates `Authorization: Bearer` tokens
 * against a fixed table, echoes messages to the room (including the sender,
 * as the real service does), answers `!ping` as a channel bot, and applies
 * `ban`/`timeout` for moderators.
 */
import type { ServerWebSocket } from "bun";
import { ChannelChatSettings, ClientFrame } from "@commonair/contracts";
import type { ChatMessage } from "@commonair/contracts/dto";
import type { UpstreamFrame } from "../../src/upstream.ts";

export interface FakeUser {
  id: string;
  username: string;
  displayName: string;
  moderator?: boolean;
}

interface Conn {
  user: FakeUser | null;
  authorization: string | null;
  rooms: Set<string>;
}

const BOT: FakeUser = {
  id: "0190f1c2-0000-7000-8000-0000000000b0",
  username: "commonairbot",
  displayName: "CommonAirBot",
};
export const channelIdOf = (slug: string) =>
  `0190f1c2-0000-7000-8000-${Buffer.from(slug.padEnd(6, "_").slice(0, 6)).toString("hex")}`;

export function startFakeUpstream(users: Record<string, FakeUser>) {
  const sockets = new Set<ServerWebSocket<Conn>>();
  const received: { user: string | null; frame: ClientFrame }[] = [];
  const authHeaders: (string | null)[] = [];
  const settings = ChannelChatSettings.parse({});

  const message = (slug: string, user: FakeUser, body: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
    id: crypto.randomUUID(),
    channelId: channelIdOf(slug),
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      color: "chat-1",
      badges: user.moderator ? [{ type: "moderator" }] : [],
      accountType: user === BOT ? "bot" : "human",
    },
    body,
    emotes: [],
    isAction: false,
    replyTo: null,
    createdAt: new Date().toISOString(),
    ...over,
  });

  const send = (ws: ServerWebSocket<Conn>, f: UpstreamFrame) => ws.send(JSON.stringify(f));
  const broadcast = (slug: string, f: UpstreamFrame) => {
    for (const ws of sockets) if (ws.data.rooms.has(slug)) send(ws, f);
  };

  function handle(ws: ServerWebSocket<Conn>, f: ClientFrame) {
    const me = ws.data.user;
    switch (f.op) {
      case "join":
        if (f.channel.startsWith("missing"))
          return send(ws, {
            op: "error",
            code: "not_found",
            message: "No such channel.",
            channel: f.channel,
            nonce: f.nonce,
          });
        ws.data.rooms.add(f.channel);
        return send(ws, {
          op: "joined",
          surge: { state: "off", until: null },
          channel: f.channel,
          channelId: channelIdOf(f.channel),
          settings,
          me: { badges: me?.moderator ? ["moderator"] : [], canModerate: !!me?.moderator, canChat: !!me },
        });
      case "part":
        ws.data.rooms.delete(f.channel);
        return send(ws, { op: "parted", channel: f.channel });
      case "ping":
        return send(ws, { op: "pong", nonce: f.nonce });
      case "send": {
        if (!me) {
          send(ws, {
            op: "notice",
            channel: f.channel,
            code: "msg_requires_login",
            text: "Log in to chat.",
            nonce: f.nonce,
          });
          return send(ws, { op: "ack", nonce: f.nonce, id: null, held: false });
        }
        const m = message(f.channel, me, f.body, { isAction: f.isAction });
        send(ws, { op: "ack", nonce: f.nonce, id: m.id, held: false });
        broadcast(f.channel, { op: "message", channel: f.channel, message: m });
        if (f.body.startsWith("!ping"))
          broadcast(f.channel, {
            op: "message",
            channel: f.channel,
            message: message(f.channel, BOT, `@${me.username} pong!`),
          });
        return;
      }
      case "command": {
        // A broadcast notice without a nonce first, as other moderators' actions produce: it must not
        // be mistaken for this command's answer.
        if (f.command === "slow")
          broadcast(f.channel, {
            op: "notice",
            channel: f.channel,
            code: "slow_on",
            text: "This room is now in slow mode.",
          });
        if (!me?.moderator)
          return send(ws, {
            op: "notice",
            channel: f.channel,
            code: "no_permission",
            text: "You don't have permission.",
            nonce: f.nonce,
          });
        const target = f.args[0] ?? "";
        if (f.command === "ban" || f.command === "timeout") {
          const secs = f.command === "timeout" ? Number(f.args[1] ?? 600) : null;
          broadcast(f.channel, {
            op: "ban",
            channel: f.channel,
            userId: "0190f1c2-0000-7000-8000-00000000dead",
            username: target,
            expiresAt: secs === null ? null : new Date(Date.now() + secs * 1000).toISOString(),
            reason: f.args[2] ?? "",
          });
          return send(ws, {
            op: "notice",
            channel: f.channel,
            code: "cmd_success",
            text: `${target} done.`,
            nonce: f.nonce,
          });
        }
        return send(ws, {
          op: "notice",
          channel: f.channel,
          code: "unrecognized_cmd",
          text: "Unknown.",
          nonce: f.nonce,
        });
      }
    }
  }

  const server = Bun.serve<Conn>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      if (new URL(req.url).pathname !== "/ws") return new Response("not found", { status: 404 });
      const authorization = req.headers.get("authorization");
      authHeaders.push(authorization);
      let user: FakeUser | null = null;
      if (authorization !== null) {
        const token = /^Bearer (.+)$/.exec(authorization)?.[1] ?? "";
        user = users[token] ?? null;
        if (!user) return new Response("invalid token", { status: 401 });
      }
      if (srv.upgrade(req, { data: { user, authorization, rooms: new Set() } })) return undefined;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        send(ws, {
          op: "welcome",
          sessionId: crypto.randomUUID(),
          user: ws.data.user && {
            id: ws.data.user.id,
            username: ws.data.user.username,
            displayName: ws.data.user.displayName,
          },
          heartbeatMs: 30_000,
        });
      },
      message(ws, raw) {
        const parsed = ClientFrame.safeParse(JSON.parse(String(raw)));
        if (!parsed.success) {
          send(ws, { op: "error", code: "bad_frame", message: "invalid frame" });
          return;
        }
        received.push({ user: ws.data.user?.username ?? null, frame: parsed.data });
        handle(ws, parsed.data);
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });

  return {
    url: `ws://127.0.0.1:${server.port}/ws`,
    received,
    authHeaders,
    message,
    broadcast,
    /** Close every upstream connection (simulates a chat service restart). */
    dropAll: () => {
      for (const ws of sockets) ws.close(1012, "restart");
    },
    connections: () => sockets.size,
    stop: () => server.stop(true),
  };
}
