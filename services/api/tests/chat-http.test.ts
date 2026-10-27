// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** REST chat relay (ack/notice/error/timeout mapping) and the held-queue DTO and fan-out shapes. */
import { describe, expect, test } from "vite-plus/test";
import { BUS, BusEvent } from "@commonair/contracts/events";
import { ChatFanout, chatMessageEventPayload, type ServerFrame } from "@commonair/contracts/chat";
import type { dto } from "@commonair/contracts";
import { allowFanout, denyFanout, releasedEvent } from "../src/chat/held.ts";
import { messageDto, type MessageRow } from "../src/chat/messages.ts";
import {
  noticeError,
  outcomeError,
  outcomeOf,
  relayToChat,
  retryAfterOf,
  type RelayRequest,
  type RelaySocketFactory,
  type RelaySocketHandlers,
} from "../src/chat/relay.ts";
import { chatScopesFor } from "../src/chat/token.ts";
import type { Caller } from "../src/lib/access.ts";

const MSG_ID = "0192f000-0000-7000-8000-0000000000aa";
const send: RelayRequest = { op: "send", channel: "streamer", body: "hello" };
const del: RelayRequest = { op: "command", channel: "streamer", command: "delete", args: [MSG_ID] };

/** A socket that answers each client frame with `reply(frame)`, recording everything. */
function fakeSocket(
  reply: (frame: Record<string, unknown>) => ServerFrame[] | "close" | "silent",
  opts: { neverOpen?: boolean } = {},
) {
  const sent: Record<string, unknown>[] = [];
  const state = { url: "", closed: 0 };
  const factory: RelaySocketFactory = (url, h: RelaySocketHandlers) => {
    state.url = url;
    if (!opts.neverOpen) queueMicrotask(() => h.open());
    return {
      send: (data) => {
        const frame = JSON.parse(data) as Record<string, unknown>;
        sent.push(frame);
        const r = reply(frame);
        if (r === "close") queueMicrotask(() => h.close());
        else if (r !== "silent") for (const f of r) queueMicrotask(() => h.message(JSON.stringify(f)));
      },
      close: () => {
        state.closed++;
      },
    };
  };
  return { factory, sent, state };
}

const relay = (request: RelayRequest, socket: RelaySocketFactory, timeoutMs = 200) =>
  relayToChat({ url: "ws://chat.test/ws", token: "tok", request, socket, timeoutMs });

describe("relayToChat", () => {
  test("joins, sends one frame with a nonce, resolves on the ack and closes", async () => {
    const s = fakeSocket((f) =>
      f.op === "send" ? [{ op: "ack", nonce: String(f.nonce), id: MSG_ID, held: false }] : [],
    );
    expect(await relay({ ...send, replyToId: MSG_ID }, s.factory)).toEqual({ type: "ack", id: MSG_ID, held: false });
    expect(s.sent.map((f) => f.op)).toEqual(["join", "send"]);
    expect(s.sent[0]).toMatchObject({ channel: "streamer" });
    expect(s.sent[1]).toMatchObject({ body: "hello", isAction: false, replyToId: MSG_ID });
    expect(typeof s.sent[1]?.nonce).toBe("string");
    expect(new URL(s.state.url).searchParams.get("token")).toBe("tok");
    expect(s.state.closed).toBe(1);
  });

  test("a held message: the msg_held notice is informational, the ack decides", async () => {
    const s = fakeSocket((f) =>
      f.op === "send"
        ? [
            { op: "notice", channel: "streamer", code: "msg_held", text: "held", nonce: String(f.nonce) },
            { op: "ack", nonce: String(f.nonce), id: MSG_ID, held: true },
          ]
        : [],
    );
    expect(await relay(send, s.factory)).toEqual({ type: "ack", id: MSG_ID, held: true });
  });

  test("a refusing notice resolves before the null ack", async () => {
    const s = fakeSocket((f) =>
      f.op === "send"
        ? [
            { op: "notice", channel: "streamer", code: "msg_banned", text: "banned", nonce: String(f.nonce) },
            { op: "ack", nonce: String(f.nonce), id: null, held: false },
          ]
        : [],
    );
    expect(await relay(send, s.factory)).toEqual({ type: "notice", code: "msg_banned", text: "banned" });
    expect(s.state.closed).toBe(1);
  });

  test("frames for other nonces (room traffic, another client's notice) are ignored", async () => {
    const s = fakeSocket((f) =>
      f.op === "send"
        ? [
            { op: "notice", channel: "streamer", code: "msg_banned", text: "x", nonce: "other" },
            { op: "notice", channel: "streamer", code: "msg_banned", text: "x" },
            { op: "ack", nonce: "other", id: MSG_ID, held: false },
            { op: "clear", channel: "streamer" },
            { op: "ack", nonce: String(f.nonce), id: MSG_ID, held: false },
          ]
        : [],
    );
    expect(await relay(send, s.factory)).toEqual({ type: "ack", id: MSG_ID, held: false });
  });

  test("a join error ends the call", async () => {
    const s = fakeSocket((f) =>
      f.op === "join" ? [{ op: "error", code: "channel_not_found", message: "no", nonce: String(f.nonce) }] : [],
    );
    expect(await relay(send, s.factory)).toEqual({ type: "error", code: "channel_not_found" });
  });

  test("a command resolves on its one notice, success or not", async () => {
    const ok = fakeSocket((f) =>
      f.op === "command"
        ? [{ op: "notice", channel: "streamer", code: "cmd_success", text: "", nonce: String(f.nonce) }]
        : [],
    );
    expect(await relay(del, ok.factory)).toMatchObject({ type: "notice", code: "cmd_success" });
    expect(ok.sent[1]).toMatchObject({ op: "command", command: "delete", args: [MSG_ID] });
  });

  test("timeout when chat never answers, closed when the socket drops", async () => {
    const silent = fakeSocket(() => "silent");
    expect(await relay(send, silent.factory, 30)).toEqual({ type: "timeout" });
    expect(silent.state.closed).toBe(1);
    const never = fakeSocket(() => "silent", { neverOpen: true });
    expect(await relay(send, never.factory, 30)).toEqual({ type: "timeout" });
    const dropped = fakeSocket(() => "close");
    expect(await relay(send, dropped.factory)).toEqual({ type: "closed" });
  });

  test("a factory that throws is a closed outcome", async () => {
    const throwing: RelaySocketFactory = () => {
      throw new Error("boom");
    };
    expect(await relay(send, throwing)).toEqual({ type: "closed" });
  });

  test("garbage frames are ignored", async () => {
    let handlers: RelaySocketHandlers | null = null;
    const factory: RelaySocketFactory = (_url, h) => {
      handlers = h;
      queueMicrotask(() => {
        h.message("not json");
        h.message(JSON.stringify({ op: "nope" }));
        h.message(JSON.stringify({ op: "ack", nonce: "rest-req", id: MSG_ID, held: false }));
      });
      return { send: () => {}, close: () => {} };
    };
    expect(await relay(send, factory)).toEqual({ type: "ack", id: MSG_ID, held: false });
    expect(handlers).not.toBeNull();
  });
});

describe("outcomeOf", () => {
  test("an ack without an id falls back to a rejection; acks never answer commands", () => {
    expect(outcomeOf(send, { op: "ack", nonce: "rest-req", id: null, held: false })).toMatchObject({
      type: "notice",
      code: "msg_rejected",
    });
    expect(outcomeOf(del, { op: "ack", nonce: "rest-req", id: MSG_ID, held: false })).toBeNull();
    expect(outcomeOf(del, { op: "notice", channel: "s", code: "msg_held", text: "", nonce: "rest-req" })).toMatchObject(
      { code: "msg_held" },
    );
  });
});

describe("error mapping", () => {
  const status = (e: { status: number }) => e.status;
  test("rate limits → 429 with a retry hint, standing → 403, the rest → 400; the code is in the message", () => {
    const slow = noticeError("msg_slowmode", "This room is in slow mode. You may send another message in 12 seconds.");
    expect(status(slow)).toBe(429);
    expect(slow.code).toBe("RATE_LIMITED");
    expect(slow.data).toEqual({ retryAfterSeconds: 12 });
    expect(slow.message).toContain("msg_slowmode");
    expect(noticeError("msg_ratelimit", "too quickly").data).toEqual({ retryAfterSeconds: 30 });
    for (const code of ["msg_banned", "msg_timedout", "msg_requires_login", "msg_subsonly", "no_permission"] as const)
      expect(status(noticeError(code, ""))).toBe(403);
    for (const code of ["msg_duplicate", "msg_emoteonly", "msg_rejected", "msg_links_blocked", "usage"] as const)
      expect(status(noticeError(code, ""))).toBe(400);
  });

  test("the notice's text (which may quote the body) never reaches the client", () => {
    expect(noticeError("msg_rejected", "secret body").message).not.toContain("secret");
  });

  test("errors, timeouts and drops", () => {
    expect(outcomeError({ type: "error", code: "channel_not_found" }).status).toBe(404);
    expect(outcomeError({ type: "error", code: "rate_limited" }).status).toBe(429);
    expect(outcomeError({ type: "error", code: "internal_error" }).status).toBe(503);
    expect(outcomeError({ type: "timeout" })).toMatchObject({ status: 503, code: "SERVICE_UNAVAILABLE" });
    expect(outcomeError({ type: "closed" }).status).toBe(503);
  });

  test("retryAfterOf", () => {
    expect(retryAfterOf("in 1 second")).toBe(1);
    expect(retryAfterOf("in 0 seconds")).toBe(30);
    expect(retryAfterOf("")).toBe(30);
  });
});

describe("chat token scopes", () => {
  const user = { id: MSG_ID, username: "u", role: "user" as const, accountType: "human" as const, suspended: false };
  test("session: all chat scopes; token: only those granted; suspended or anonymous: read only", () => {
    expect(chatScopesFor({ kind: "session", user, sessionId: "s" })).toEqual([
      "chat:read",
      "chat:edit",
      "moderator:manage:chat",
    ]);
    const token: Caller = {
      kind: "token",
      user,
      tokenId: "t",
      appId: null,
      scopes: ["chat:edit"],
      expiresAt: new Date(),
    };
    expect(chatScopesFor(token)).toEqual(["chat:read", "chat:edit"]);
    expect(chatScopesFor({ kind: "session", user: { ...user, suspended: true }, sessionId: "s" })).toEqual([
      "chat:read",
    ]);
    expect(chatScopesFor(null)).toEqual(["chat:read"]);
  });
});

const channel = {
  id: "0192f000-0000-7000-8000-000000000001",
  ownerId: "0192f000-0000-7000-8000-000000000002",
  slug: "streamer",
  displayName: "Streamer",
};

const row = (over: Partial<MessageRow["m"]> = {}): MessageRow =>
  ({
    m: {
      id: MSG_ID,
      channelId: channel.id,
      broadcastId: null,
      userId: "0192f000-0000-7000-8000-000000000003",
      body: "hi @streamer",
      emotes: [],
      isAction: false,
      replyToId: null,
      viaAppId: null,
      heldAt: new Date("2026-10-27T10:00:00Z"),
      deletedAt: null,
      deletedBy: null,
      createdAt: new Date("2026-10-27T10:00:00Z"),
      ...over,
    },
    u: {
      id: "0192f000-0000-7000-8000-000000000003",
      username: "troll",
      name: "Troll",
      accountType: "human",
    },
  }) as unknown as MessageRow;

describe("held DTO", () => {
  test("shaped like chat.history rows: badges, reply (blank once deleted), ISO time", () => {
    const m = messageDto(row({ replyToId: channel.ownerId }), [{ type: "subscriber", tier: 2 }], {
      id: channel.ownerId,
      username: "streamer",
      body: "quoted",
      deleted: true,
    });
    expect(m).toEqual({
      id: MSG_ID,
      channelId: channel.id,
      user: {
        id: "0192f000-0000-7000-8000-000000000003",
        username: "troll",
        displayName: "Troll",
        color: null,
        badges: [{ type: "subscriber", tier: 2 }],
        accountType: "human",
      },
      body: "hi @streamer",
      emotes: [],
      isAction: false,
      replyTo: { id: channel.ownerId, username: "streamer", body: "" },
      createdAt: "2026-10-27T10:00:00.000Z",
    });
    expect(messageDto(row(), [], undefined).replyTo).toBeNull();
  });
});

describe("held fan-out", () => {
  const message: dto.ChatMessage = messageDto(row(), [], undefined);

  test("allow: one message frame to everyone, a valid ChatFanout", () => {
    const env = allowFanout(channel, message, 123);
    expect(ChatFanout.parse(env)).toEqual(env);
    expect(env).toEqual({ v: 1, audience: "all", sentAt: 123, frame: { op: "message", channel: "streamer", message } });
    expect("held" in env.frame).toBe(false);
  });

  test("deny: a delete frame to moderators only", () => {
    expect(denyFanout(channel, MSG_ID, "troll", 5)).toEqual({
      v: 1,
      audience: "moderators",
      sentAt: 5,
      frame: { op: "delete", channel: "streamer", messageId: MSG_ID, username: "troll" },
    });
  });

  test("the released event is channel.chat.message with the shared payload", () => {
    const e = releasedEvent(channel, message);
    expect(BusEvent.parse(e)).toEqual(e);
    expect(e).toMatchObject({ type: "channel.chat.message", version: "1", channelId: channel.id });
    expect(e.payload).toEqual(chatMessageEventPayload(channel, message));
    expect(e.occurredAt).toBe(message.createdAt);
    expect(BUS.chat(channel.id)).toBe(`chat:${channel.id}`);
  });
});
