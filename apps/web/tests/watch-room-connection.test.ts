// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The watch room's own chat socket (decision (r)): join, playhead reports, frames, reconnects. */
import { describe, expect, it } from "vite-plus/test";
import type { SocketLike } from "../src/chat/connection.ts";
import { RoomConnection, type RoomFrame } from "../src/components/watch-room/connection.ts";

const ROOM = "01890000-0000-7000-8000-00000000a001";

class FakeSocket implements SocketLike {
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  private listeners = new Map<string, ((ev: { data?: unknown }) => void)[]>();
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
  }
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, data?: unknown) {
    for (const fn of this.listeners.get(type) ?? [])
      fn({ data: data === undefined ? undefined : JSON.stringify(data) });
  }
}

function setup(playhead: { at: Date | null; mode: "live" | "dvr"; edge?: Date | null; buffered?: Date | null }) {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const repeats: { fn: () => void; ms: number }[] = [];
  const frames: RoomFrame[] = [];
  const notices: string[] = [];
  let roomTokens = 0;
  const conn = new RoomConnection(
    "chan",
    ROOM,
    {
      getChatToken: async () => ({ token: "chat", url: "ws://chat.test/ws" }),
      getRoomToken: async () => `room-${++roomTokens}`,
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      playhead: () => playhead,
      setTimer: (fn, ms) => timers.push({ fn, ms }),
      clearTimer: () => undefined,
      setRepeat: (fn, ms) => repeats.push({ fn, ms }),
      clearRepeat: () => undefined,
    },
    { onStatus: () => undefined, onFrame: (f) => frames.push(f), onNotice: (c) => notices.push(c) },
  );
  return { conn, sockets, timers, repeats, frames, notices };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("RoomConnection", () => {
  it("joins after welcome, reports the playhead every 2 s, and passes room frames on", async () => {
    const at = new Date("2026-11-01T10:00:00.000Z");
    const s = setup({ at, mode: "live" });
    s.conn.start();
    await tick();
    const sock = s.sockets[0]!;
    expect(new URL(sock.url).searchParams.get("token")).toBe("chat");
    sock.emit("message", { op: "welcome", sessionId: "x", user: null, heartbeatMs: 30_000 });
    expect(sock.sent[0]).toEqual({ op: "room.join", roomId: ROOM, token: "room-1", nonce: "join" });
    const report = s.repeats.find((r) => r.ms === 2000)!;
    report.fn();
    expect(sock.sent.at(-1)).toEqual({
      op: "room.sync",
      roomId: ROOM,
      playheadWallclock: at.toISOString(),
      mode: "live",
    });
    sock.emit("message", { op: "room.sync", roomId: ROOM, target: at.toISOString() });
    sock.emit("message", { op: "room.sync", roomId: "01890000-0000-7000-8000-00000000a002", target: at.toISOString() });
    sock.emit("message", { op: "notice", channel: null, code: "room_blocked", text: "x" });
    expect(s.frames).toHaveLength(1);
    expect(s.notices).toEqual(["room_blocked"]);
    expect(s.conn.send("hi")).toBe(true);
    expect(sock.sent.at(-1)).toMatchObject({ op: "room.send", roomId: ROOM, body: "hi" });
  });

  it("reports the edge and where the buffered media ends in live mode, null for both in DVR", async () => {
    const at = new Date("2026-11-01T10:00:00.000Z");
    const edge = new Date(at.getTime() + 6600);
    const buffered = new Date(at.getTime() + 1200);
    const live = setup({ at, mode: "live", edge, buffered });
    live.conn.start();
    await tick();
    live.sockets[0]!.emit("message", { op: "welcome", sessionId: "x", user: null, heartbeatMs: 30_000 });
    live.repeats.find((r) => r.ms === 2000)!.fn();
    expect(live.sockets[0]!.sent.at(-1)).toMatchObject({
      op: "room.sync",
      edgeWallclock: edge.toISOString(),
      bufferedWallclock: buffered.toISOString(),
    });
    const dvr = setup({ at, mode: "dvr", edge, buffered });
    dvr.conn.start();
    await tick();
    dvr.sockets[0]!.emit("message", { op: "welcome", sessionId: "x", user: null, heartbeatMs: 30_000 });
    dvr.repeats.find((r) => r.ms === 2000)!.fn();
    expect(dvr.sockets[0]!.sent.at(-1)).toMatchObject({ edgeWallclock: null, bufferedWallclock: null });
  });

  it("no playhead, no report; a closed room stops the connection", async () => {
    const s = setup({ at: null, mode: "live" });
    s.conn.start();
    await tick();
    const sock = s.sockets[0]!;
    sock.emit("message", { op: "welcome", sessionId: "x", user: null, heartbeatMs: 30_000 });
    s.repeats.find((r) => r.ms === 2000)!.fn();
    expect(sock.sent.filter((f) => f["op"] === "room.sync")).toEqual([]);
    sock.emit("message", { op: "room.closed", roomId: ROOM, reason: "host_closed" });
    expect(s.frames.map((f) => f.op)).toEqual(["room.closed"]);
    expect(s.conn.send("late")).toBe(false);
  });

  it("an unexpected close reconnects with a fresh room token", async () => {
    const s = setup({ at: null, mode: "live" });
    s.conn.start();
    await tick();
    s.sockets[0]!.emit("close");
    expect(s.timers).toHaveLength(1);
    s.timers[0]!.fn();
    await tick();
    const next = s.sockets[1]!;
    next.emit("message", { op: "welcome", sessionId: "y", user: null, heartbeatMs: 30_000 });
    expect(next.sent[0]).toMatchObject({ op: "room.join", token: "room-2" });
  });
});
