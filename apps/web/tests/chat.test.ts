// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vite-plus/test";
import { backoffDelay } from "../src/chat/backoff.ts";
import {
  ChatConnection,
  MAX_MESSAGES,
  appendMessage,
  type ChatEvents,
  type ChatMessageFrame,
  type ChatStatus,
  type SocketLike,
} from "../src/chat/connection.ts";

const CHANNEL = "streamer_one";
const UUID = (n: number) => `0190f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: unknown[] = [];
  closed: number | null = null;
  private listeners = new Map<string, ((ev: { data?: unknown }) => void)[]>();
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, ev: { data?: unknown } = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  frame(f: unknown): void {
    this.emit("message", { data: JSON.stringify(f) });
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number): void {
    this.closed = code ?? 1000;
    this.readyState = 3;
  }
  drop(): void {
    this.readyState = 3;
    this.emit("error");
    this.emit("close");
  }
}

class FakeTimers {
  private next = 1;
  pending = new Map<number, { fn: () => void; ms: number }>();
  set = (fn: () => void, ms: number) => {
    const id = this.next++;
    this.pending.set(id, { fn, ms });
    return id;
  };
  clear = (id: unknown) => {
    this.pending.delete(id as number);
  };
  /** Run the pending timer with the shortest delay; returns its delay. */
  runNext(): number {
    const [id, t] = [...this.pending.entries()].sort((a, b) => a[1].ms - b[1].ms)[0] ?? [];
    if (id === undefined || !t) throw new Error("no pending timer");
    this.pending.delete(id);
    t.fn();
    return t.ms;
  }
}

function setup(opts: { tokenFails?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const timers = new FakeTimers();
  const statuses: ChatStatus[] = [];
  const messages: ChatMessageFrame[] = [];
  const notices: [string, string][] = [];
  const joined: { canChat: boolean }[] = [];
  const deleted: string[] = [];
  let cleared = 0;
  let tokenCalls = 0;
  let failures = opts.tokenFails ?? 0;
  const events: ChatEvents = {
    onStatus: (s) => statuses.push(s),
    onJoined: (me) => joined.push(me),
    onMessage: (m) => messages.push(m),
    onDelete: (id) => deleted.push(id),
    onClear: () => cleared++,
    onNotice: (code, kind) => notices.push([kind, code]),
  };
  const conn = new ChatConnection(
    CHANNEL,
    {
      getToken: async () => {
        tokenCalls++;
        if (failures-- > 0) throw new Error("api down");
        return { token: `tok${tokenCalls}`, url: "ws://chat.test/ws" };
      },
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      setTimer: timers.set,
      clearTimer: timers.clear,
      random: () => 0,
    },
    events,
  );
  return {
    conn,
    sockets,
    timers,
    statuses,
    messages,
    notices,
    joined,
    deleted,
    cleared: () => cleared,
    tokenCalls: () => tokenCalls,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const welcome = { op: "welcome", sessionId: "s1", user: null, heartbeatMs: 30_000 };
const joinedFrame = (canChat = true) => ({
  op: "joined",
  channel: CHANNEL,
  channelId: UUID(1),
  settings: {
    slowModeSeconds: 0,
    followersOnlyMinutes: null,
    subscribersOnly: false,
    emoteOnly: false,
    minAccountAgeDays: 0,
    requireVerifiedEmail: true,
    linksAllowed: true,
  },
  me: { badges: [], canModerate: false, canChat },
});
const message = (n: number, body = `hi ${n}`) => ({
  id: UUID(100 + n),
  channelId: UUID(1),
  user: {
    id: UUID(2),
    username: "viewer_two",
    displayName: "Viewer Two",
    color: null,
    badges: [],
    accountType: "human",
  },
  body,
  emotes: [],
  isAction: false,
  replyTo: null,
  createdAt: "2026-10-18T12:00:00.000Z",
});

async function connected(opts: { canChat?: boolean } = {}) {
  const t = setup();
  t.conn.start();
  await flush();
  const socket = t.sockets[0];
  if (!socket) throw new Error("no socket");
  socket.open();
  socket.frame(welcome);
  socket.frame(joinedFrame(opts.canChat ?? true));
  return { ...t, socket };
}

describe("ChatConnection", () => {
  it("connects with a token, joins after welcome and opens on joined", async () => {
    const t = setup();
    t.conn.start();
    expect(t.statuses).toEqual(["connecting"]);
    await flush();
    const socket = t.sockets[0];
    expect(socket?.url).toBe("ws://chat.test/ws?token=tok1");
    socket?.open();
    socket?.frame(welcome);
    expect(socket?.sent).toEqual([{ op: "join", channel: CHANNEL }]);
    socket?.frame(joinedFrame(true));
    expect(t.statuses).toEqual(["connecting", "open"]);
    expect(t.joined).toEqual([{ canChat: true, canModerate: false }]);
  });

  it("ignores a joined frame for another channel", async () => {
    const t = setup();
    t.conn.start();
    await flush();
    t.sockets[0]?.open();
    t.sockets[0]?.frame({ ...joinedFrame(), channel: "someone_else" });
    expect(t.conn.status).toBe("connecting");
  });

  it("pings at half the server heartbeat", async () => {
    const t = await connected();
    expect(t.timers.runNext()).toBe(15_000);
    expect(t.socket.sent.at(-1)).toEqual({ op: "ping" });
    expect(t.timers.runNext()).toBe(15_000);
    expect(t.socket.sent.filter((f) => (f as { op: string }).op === "ping")).toHaveLength(2);
  });

  it("delivers valid messages and drops invalid, held or foreign ones", async () => {
    const t = await connected();
    t.socket.frame({ op: "message", channel: CHANNEL, message: message(1) });
    t.socket.frame({ op: "message", channel: CHANNEL, message: message(2), held: true });
    t.socket.frame({ op: "message", channel: "other_chan", message: message(3) });
    t.socket.frame({ op: "message", channel: CHANNEL, message: { ...message(4), id: "not-a-uuid" } });
    t.socket.emit("message", { data: "{not json" });
    t.socket.emit("message", { data: new Uint8Array([1, 2]) });
    expect(t.messages.map((m) => m.body)).toEqual(["hi 1"]);
  });

  it("forwards deletes, clears, and notice and error codes", async () => {
    const t = await connected();
    t.socket.frame({ op: "delete", channel: CHANNEL, messageId: UUID(101), username: "viewer_two" });
    t.socket.frame({ op: "clear", channel: CHANNEL });
    t.socket.frame({ op: "notice", channel: CHANNEL, code: "msg_slowmode", text: "Slow mode is on" });
    t.socket.frame({ op: "notice", channel: null, code: "msg_ratelimit", text: "Too fast" });
    t.socket.frame({ op: "notice", channel: "other_chan", code: "msg_banned", text: "not ours" });
    t.socket.frame({ op: "error", code: "UNAUTHORIZED", message: "Sign in to chat" });
    expect(t.deleted).toEqual([UUID(101)]);
    expect(t.cleared()).toBe(1);
    expect(t.notices).toEqual([
      ["notice", "msg_slowmode"],
      ["notice", "msg_ratelimit"],
      ["error", "UNAUTHORIZED"],
    ]);
  });

  it("sends trimmed messages only while open", async () => {
    const t = setup();
    t.conn.start();
    await flush();
    t.sockets[0]?.open();
    expect(t.conn.send("too early")).toBe(false);
    t.sockets[0]?.frame(welcome);
    t.sockets[0]?.frame(joinedFrame());
    expect(t.conn.send("   ")).toBe(false);
    expect(t.conn.send("  hello  ")).toBe(true);
    expect(t.sockets[0]?.sent.at(-1)).toMatchObject({ op: "send", channel: CHANNEL, body: "hello", isAction: false });
  });

  it("reconnects with backoff and a fresh token after the socket drops", async () => {
    const t = await connected();
    t.socket.drop();
    expect(t.conn.status).toBe("closed");
    expect(t.timers.runNext()).toBe(500);
    await flush();
    expect(t.tokenCalls()).toBe(2);
    expect(t.sockets[1]?.url).toBe("ws://chat.test/ws?token=tok2");
    expect(t.conn.status).toBe("connecting");
    // Dropping again before joining backs off further.
    t.sockets[1]?.drop();
    expect(t.timers.runNext()).toBe(1_000);
    await flush();
    t.sockets[2]?.open();
    t.sockets[2]?.frame(welcome);
    t.sockets[2]?.frame(joinedFrame());
    expect(t.conn.status).toBe("open");
    // A successful join resets the backoff.
    t.sockets[2]?.drop();
    expect(t.timers.runNext()).toBe(500);
  });

  it("retries when the token request fails", async () => {
    const t = setup({ tokenFails: 2 });
    t.conn.start();
    await flush();
    expect(t.sockets).toHaveLength(0);
    expect(t.timers.runNext()).toBe(500);
    await flush();
    expect(t.timers.runNext()).toBe(1_000);
    await flush();
    expect(t.sockets).toHaveLength(1);
  });

  it("stops cleanly: closes the socket and never reconnects", async () => {
    const t = await connected();
    t.conn.stop();
    expect(t.socket.closed).toBe(1000);
    expect(t.conn.status).toBe("closed");
    t.socket.drop();
    expect(t.timers.pending.size).toBe(0);
    expect(t.sockets).toHaveLength(1);
  });
});

describe("backoffDelay", () => {
  it("doubles from the base up to the cap", () => {
    const none = () => 0;
    expect([0, 1, 2, 3, 4].map((n) => backoffDelay(n, {}, none))).toEqual([500, 1_000, 2_000, 4_000, 8_000]);
    expect(backoffDelay(10, {}, none)).toBe(30_000);
    expect(backoffDelay(1_000, {}, none)).toBe(30_000);
  });
  it("applies jitter downwards only", () => {
    expect(backoffDelay(2, { jitter: 0.5 }, () => 1)).toBe(1_000);
    expect(backoffDelay(2, { jitter: 0.5 }, () => 0)).toBe(2_000);
  });
});

describe("appendMessage", () => {
  it("dedupes by id and keeps the newest MAX_MESSAGES", () => {
    const m = (n: number) => message(n) as unknown as ChatMessageFrame;
    let list: ChatMessageFrame[] = [];
    list = appendMessage(list, m(1));
    expect(appendMessage(list, m(1))).toBe(list);
    for (let i = 2; i <= MAX_MESSAGES + 5; i++) list = appendMessage(list, m(i));
    expect(list).toHaveLength(MAX_MESSAGES);
    expect(list[0]?.body).toBe("hi 6");
  });
});
