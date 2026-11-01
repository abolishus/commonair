// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Batch 7 contract step §5.4: `server.ts` dispatches the `room.*` frames to the watch-room handler
 * (a non-null answer comes back as a notice with the frame's nonce), `BUS.roomControl` messages
 * reach `onControl`, and a closing socket leaves its rooms. The handler's behaviour is
 * W3-watch-rooms'; for an unknown room it refuses joins and sends with `room_closed`.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { BUS, type ClientFrame, type RoomControlMessage } from "@commonair/contracts";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createValkey } from "@commonair/service";
import type { WatchRoomDeps, WatchRoomHandler } from "../src/core.ts";
import type { ChatService } from "../src/server.ts";
import type { ChatSocket } from "../src/socket.ts";
import { chatToken, Client, createUser, eventually, isolation, startInstance, VALKEY_URL } from "./helpers.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

/** A handler that records every call; `send` refuses, the rest answer nothing. */
class Recorder implements WatchRoomHandler {
  readonly calls: { op: string; userId: string | null; roomId?: string }[] = [];
  readonly control: RoomControlMessage[] = [];
  deps: WatchRoomDeps | null = null;
  private record(ws: ChatSocket, frame: ClientFrame & { roomId: string }) {
    this.calls.push({ op: frame.op, userId: ws.data.identity.userId, roomId: frame.roomId });
  }
  async join(ws: ChatSocket, f: Extract<ClientFrame, { op: "room.join" }>) {
    this.record(ws, f);
    ws.data.watchRooms.add(f.roomId);
    return null;
  }
  async part(ws: ChatSocket, f: Extract<ClientFrame, { op: "room.part" }>) {
    this.record(ws, f);
    return null;
  }
  async send(ws: ChatSocket, f: Extract<ClientFrame, { op: "room.send" }>) {
    this.record(ws, f);
    return { code: "room_blocked" as const, text: "blocked" };
  }
  async sync(ws: ChatSocket, f: Extract<ClientFrame, { op: "room.sync" }>) {
    this.record(ws, f);
    return null;
  }
  onControl(msg: RoomControlMessage) {
    this.control.push(msg);
  }
  async partAll(ws: ChatSocket) {
    this.calls.push({ op: "partAll", userId: ws.data.identity.userId });
    ws.data.watchRooms.clear();
  }
}

let t: TestDatabase;
const pub = createValkey(VALKEY_URL, { name: "room-dispatch-pub" });
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await pub.quit();
  await t?.drop();
});

describe("room frame dispatch", () => {
  let svc: ChatService;
  const rec = new Recorder();
  const iso = isolation();
  beforeAll(async () => {
    svc = await startInstance(t.db, iso, {
      watchRooms: (deps) => {
        rec.deps = deps;
        return rec;
      },
    });
  });
  afterAll(async () => {
    await svc.stop();
  });

  test("the handler gets the filter pipeline, the bus and Valkey", () => {
    expect(rec.deps).toMatchObject({
      filterRunner: expect.anything(),
      bus: expect.anything(),
      valkey: expect.anything(),
      directory: expect.anything(),
    });
    expect(rec.deps?.bus.names.room("r")).toBe(`${iso.busPrefix}${BUS.room("r")}`);
  });

  test("each room op reaches its method; a refusal comes back as a notice with the nonce", async () => {
    const u = await createUser(t.db);
    const c = await Client.connect(svc, { token: await chatToken(u.id) });
    const roomId = crypto.randomUUID();
    const at = new Date().toISOString();
    c.send({ op: "room.join", roomId, token: "room-token", nonce: "j" });
    c.send({ op: "room.sync", roomId, playheadWallclock: at, mode: "live", nonce: "y" });
    c.send({ op: "room.send", roomId, body: "hi", nonce: "s" });
    const notice = await c.waitFor<"notice">((f) => f.op === "notice");
    expect(notice).toMatchObject({ code: "room_blocked", channel: null, nonce: "s" });
    c.send({ op: "room.part", roomId, nonce: "p" });
    await eventually(() => rec.calls.some((x) => x.op === "room.part"));
    expect(rec.calls.filter((x) => x.userId === u.id).map((x) => x.op)).toEqual([
      "room.join",
      "room.sync",
      "room.send",
      "room.part",
    ]);
    // Only the refusal answered.
    expect(c.frames.filter((f) => f.op === "notice")).toHaveLength(1);

    c.close();
    await eventually(() => rec.calls.some((x) => x.op === "partAll" && x.userId === u.id));
  });

  test("an anonymous socket is told to sign in and never reaches the handler", async () => {
    const before = rec.calls.length;
    const c = await Client.connect(svc, { token: await chatToken(null, ["chat:read"]) });
    c.send({ op: "room.join", roomId: crypto.randomUUID(), token: "x", nonce: "a" });
    const notice = await c.waitFor<"notice">((f) => f.op === "notice");
    expect(notice).toMatchObject({ code: "msg_requires_login", nonce: "a" });
    expect(rec.calls.slice(before).filter((x) => x.op !== "partAll")).toEqual([]);
    c.close();
  });

  test("BUS.roomControl close and kick reach onControl; malformed messages are dropped", async () => {
    const roomId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const channel = iso.busPrefix + BUS.roomControl;
    await pub.publish(channel, "not json");
    await pub.publish(channel, JSON.stringify({ op: "room.close", roomId: "nope", reason: "host_left" }));
    await pub.publish(channel, JSON.stringify({ op: "room.kick", roomId, userId, reason: "banned" }));
    await eventually(() => rec.control.length > 0);
    expect(rec.control).toEqual([{ op: "room.kick", roomId, userId, reason: "banned" }]);
  });
});

describe("the shipped handler refuses an unknown room with room_closed", () => {
  test("refuses joins and sends with room_closed", async () => {
    const svc = await startInstance(t.db, isolation());
    try {
      const u = await createUser(t.db);
      const c = await Client.connect(svc, { token: await chatToken(u.id) });
      const roomId = crypto.randomUUID();
      c.send({ op: "room.join", roomId, token: "room-token", nonce: "j" });
      expect(await c.waitFor<"notice">((f) => f.op === "notice" && f.nonce === "j")).toMatchObject({
        code: "room_closed",
      });
      c.send({ op: "room.send", roomId, body: "hi", nonce: "s" });
      expect(await c.waitFor<"notice">((f) => f.op === "notice" && f.nonce === "s")).toMatchObject({
        code: "room_closed",
      });
      c.close();
    } finally {
      await svc.stop();
    }
  });
});
