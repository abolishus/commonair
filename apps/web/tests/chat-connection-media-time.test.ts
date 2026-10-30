// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `ChatConnection.send` adds the channel's media time (ADR 0012 amendment 1 decisions 1–2). */
import { ClientFrame } from "@commonair/contracts/chat";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ChatConnection, type SocketLike } from "../src/chat/connection.ts";
import { registerMediaClock, type PlaybackMode } from "../src/player/media-clock.ts";

const CHANNEL = "rivertide";

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  private listeners = new Map<string, ((ev: { data?: unknown }) => void)[]>();
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  frame(f: unknown): void {
    for (const fn of this.listeners.get("message") ?? []) fn({ data: JSON.stringify(f) });
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
  }
}

const offs: (() => void)[] = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
});

async function joined(channel = CHANNEL): Promise<{ conn: ChatConnection; socket: FakeSocket }> {
  let socket: FakeSocket | null = null;
  const conn = new ChatConnection(
    channel,
    {
      getToken: async () => ({ token: "tok", url: "ws://chat.test/ws" }),
      createSocket: () => (socket = new FakeSocket()),
      setTimer: () => 0,
      clearTimer: () => undefined,
    },
    {
      onStatus: () => undefined,
      onJoined: () => undefined,
      onMessage: () => undefined,
      onDelete: () => undefined,
      onClear: () => undefined,
      onNotice: () => undefined,
    },
  );
  conn.start();
  await new Promise((r) => setTimeout(r, 0));
  if (!socket) throw new Error("no socket");
  const s: FakeSocket = socket;
  s.frame({ op: "welcome", sessionId: "s1", user: null, heartbeatMs: 30_000 });
  s.frame({
    op: "joined",
    surge: { state: "off", until: null },
    channel,
    channelId: "0190f000-0000-7000-8000-000000000001",
    settings: {
      slowModeSeconds: 0,
      followersOnlyMinutes: null,
      subscribersOnly: false,
      emoteOnly: false,
      minAccountAgeDays: 0,
      requireVerifiedEmail: true,
      linksAllowed: true,
    },
    me: { badges: [], canModerate: false, canChat: true },
  });
  return { conn, socket: s };
}

function register(at: number | null, mode: PlaybackMode = "live", channel = CHANNEL) {
  offs.push(
    registerMediaClock(channel, {
      playheadWallclock: () => (at === null ? null : new Date(at)),
      playbackMode: () => mode,
    }),
  );
}

const lastSend = (s: FakeSocket) => s.sent.filter((f) => f.op === "send").at(-1);

describe("ChatConnection.send media time", () => {
  it("is open after the joined frame (fixture sanity)", async () => {
    const { conn } = await joined();
    expect(conn.status).toBe("open");
  });

  it("without a player (embedded or overlay chat): neither mediaTs nor playbackMode", async () => {
    const { conn, socket } = await joined();
    expect(conn.send("hi")).toBe(true);
    const f = lastSend(socket);
    expect(f).toMatchObject({ op: "send", channel: CHANNEL, body: "hi" });
    expect(f).not.toHaveProperty("mediaTs");
    expect(f).not.toHaveProperty("playbackMode");
  });

  it("a live player: mediaTs (ISO 8601) read at send time, playbackMode omitted", async () => {
    const { conn, socket } = await joined();
    let at = Date.parse("2026-10-30T12:00:00.000Z");
    offs.push(registerMediaClock(CHANNEL, { playheadWallclock: () => new Date(at), playbackMode: () => "live" }));
    conn.send("one");
    at += 1_500;
    conn.send("two");
    const sends = socket.sent.filter((f) => f.op === "send");
    expect(sends.map((f) => f.mediaTs)).toEqual(["2026-10-30T12:00:00.000Z", "2026-10-30T12:00:01.500Z"]);
    expect(sends.every((f) => !("playbackMode" in f))).toBe(true);
    // The frame is a valid contract `send` frame.
    expect(ClientFrame.safeParse(sends[1]).success).toBe(true);
  });

  it("a player before its first frame: no mediaTs", async () => {
    const { conn, socket } = await joined();
    register(null);
    conn.send("early");
    expect(lastSend(socket)).not.toHaveProperty("mediaTs");
  });

  it("dvr: playbackMode sent (the server drops the hint)", async () => {
    const { conn, socket } = await joined();
    register(Date.parse("2026-10-30T11:00:00.000Z"), "dvr");
    conn.send("catching up");
    const f = lastSend(socket);
    expect(f).toMatchObject({ playbackMode: "dvr", mediaTs: "2026-10-30T11:00:00.000Z" });
    expect(ClientFrame.safeParse(f).success).toBe(true);
  });

  it("another channel's player is not this chat's clock", async () => {
    const { conn, socket } = await joined();
    register(Date.parse("2026-10-30T12:00:00.000Z"), "dvr", "someone_else");
    conn.send("hi");
    expect(lastSend(socket)).not.toHaveProperty("mediaTs");
    expect(lastSend(socket)).not.toHaveProperty("playbackMode");
  });
});
