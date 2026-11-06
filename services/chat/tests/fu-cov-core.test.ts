// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ChatCore paths the integration suites cannot reach through a real socket: credentials the
 * server already turns away, and failures (bus publish, moderation, hooks, a socket closing
 * mid-join, a directory throwing during a moderator refresh) that need to be injected. The real
 * `Rooms` and `MemoryLimiter` run; only the edges that must fail on cue are stand-ins.
 */
import { describe, expect, test } from "vite-plus/test";
import type { ServerFrame } from "@commonair/contracts";
import { createLogger } from "@commonair/observability";
import { compileFilters } from "@commonair/chat-filter";
import type { Bus } from "../src/bus.ts";
import { ChatCore, type CoreDeps, REQUIRES_LOGIN, type WatchRoomHandler } from "../src/core.ts";
import type { LoadedChannel } from "../src/directory.ts";
import { MemoryLimiter } from "../src/limiter.ts";
import { createMetrics } from "../src/metrics.ts";
import type { MessageMiddleware } from "../src/pipeline.ts";
import { Rooms } from "../src/rooms.ts";
import type { ChatSocket, ConnData } from "../src/socket.ts";
import { type Identity, NO_STANDING, type Standing, type UserProfile } from "../src/types.ts";
import { channel, NOW, user } from "./fixtures.ts";

const CH = channel();
const ALICE = user();
const MOD_ID = "00000000-0000-7000-8000-0000000000d1";

const identity = (over: Partial<Identity> = {}): Identity => ({
  userId: ALICE.id,
  scopes: ["chat:read", "chat:edit", "moderator:manage:chat"],
  appId: null,
  via: "token",
  expiresAt: null,
  tokenHash: null,
  ...over,
});

interface FakeSocket {
  ws: ChatSocket;
  sent: ServerFrame[];
}

function socket(id: Identity = identity()): FakeSocket {
  const sent: ServerFrame[] = [];
  const data: ConnData = {
    sessionId: crypto.randomUUID(),
    identity: id,
    user: null,
    rooms: new Map(),
    watchRooms: new Set(),
    lastSeen: 0,
    closed: false,
    bucket: { tokens: 10, updated: 0 },
    queue: Promise.resolve(),
    pending: 0,
    errors: 0,
  };
  const ws = {
    data,
    send: (raw: string) => {
      sent.push(JSON.parse(raw) as ServerFrame);
      return raw.length;
    },
    getBufferedAmount: () => 0,
    terminate: () => {},
  } as unknown as ChatSocket;
  return { ws, sent };
}

interface Harness {
  core: ChatCore;
  rooms: Rooms;
  logs: { level: string; msg: string; [k: string]: unknown }[];
  published: { channel: string; message: string }[];
  enqueued: unknown[];
  calls: string[];
  set: {
    publishFails: (on: boolean) => void;
    profile: (p: UserProfile | null) => void;
    standing: (fn: (userId: string) => Standing | Promise<Standing>) => void;
    channel: (fn: (slug: string) => Promise<LoadedChannel | null>) => void;
    moderation: (fn: () => Promise<{ code: "cmd_success"; text: string }>) => void;
    onJoin: (fn: (ws: ChatSocket) => void) => void;
  };
}

function harness(over: { middlewares?: MessageMiddleware[]; maxRooms?: number; watchRooms?: boolean } = {}): Harness {
  const logs: Harness["logs"] = [];
  const logger = createLogger({
    service: "chat-cov",
    write: (line) => logs.push(JSON.parse(line) as Harness["logs"][number]),
  });
  const published: Harness["published"] = [];
  const enqueued: unknown[] = [];
  const calls: string[] = [];
  let publishFails = false;
  let profile: UserProfile | null = ALICE;
  let standingFn: (userId: string) => Standing | Promise<Standing> = () => NO_STANDING;
  const loaded: LoadedChannel = { state: CH, filters: compileFilters([]) };
  let channelFn = (slug: string): Promise<LoadedChannel | null> => Promise.resolve(slug === CH.slug ? loaded : null);
  let moderationFn = () => Promise.resolve({ code: "cmd_success" as const, text: "ok" });
  let onJoin: (ws: ChatSocket) => void = () => {};

  const bus = {
    names: {
      chat: (id: string) => `chat:${id}`,
      control: (id: string) => `control:${id}`,
      events: () => "events",
      live: () => "live",
      room: (id: string) => `room:${id}`,
      roomControl: () => "room-control",
    },
    acquire: () => Promise.resolve(),
    release: () => Promise.resolve(),
    publish: (channelName: string, message: string) => {
      if (publishFails) return Promise.reject(new Error("valkey down"));
      published.push({ channel: channelName, message });
      return Promise.resolve();
    },
  } as unknown as Bus;
  const metrics = createMetrics();
  const frameWriter = { maxBufferedBytes: 1 << 20, metrics };
  const realRooms = new Rooms(bus, { onChat: () => {}, onControl: () => {} }, frameWriter);
  const rooms = Object.assign(Object.create(realRooms) as Rooms, {
    join: async (ws: ChatSocket, ch: { id: string; slug: string }, m: Parameters<Rooms["join"]>[2]) => {
      await realRooms.join(ws, ch, m);
      onJoin(ws);
    },
  });
  const directory = {
    channel: (slug: string) => channelFn(slug),
    profile: (userId: string) => Promise.resolve(profile && { ...profile, id: userId }),
    standing: (_ch: unknown, userId: string) => Promise.resolve(standingFn(userId)),
    invalidateChannel: (id: string) => calls.push(`invalidateChannel:${id}`),
    invalidateStanding: (id: string, userId?: string) => calls.push(`invalidateStanding:${id}:${userId ?? "*"}`),
    invalidateUser: (id: string) => calls.push(`invalidateUser:${id}`),
  };
  const watchRooms: WatchRoomHandler = {
    join: () => Promise.resolve(null),
    part: () => Promise.resolve(null),
    send: () => Promise.resolve(null),
    sync: () => Promise.resolve(null),
    onControl: () => {},
    partAll: () => Promise.resolve(),
  };
  const deps = {
    db: {} as CoreDeps["db"],
    bus,
    rooms,
    directory: directory as unknown as CoreDeps["directory"],
    limiter: new MemoryLimiter(() => NOW.getTime()),
    writer: { enqueue: (row: unknown) => enqueued.push(row) } as unknown as CoreDeps["writer"],
    moderation: { execute: () => moderationFn() } as unknown as CoreDeps["moderation"],
    middlewares: over.middlewares ?? [],
    metrics,
    logger,
    frameWriter,
    maxRoomsPerConnection: over.maxRooms ?? 100,
    latency: { get: () => Promise.resolve(null) } as unknown as CoreDeps["latency"],
    watchGate: {
      load: () => Promise.resolve(null),
      denied: (_c: string, _u: string, r: unknown) => Promise.resolve(r),
      surge: () => Promise.resolve({ state: "off", until: null }),
      invalidate: (id: string) => calls.push(`surgeInvalidate:${id}`),
    } as unknown as CoreDeps["watchGate"],
    valkey: {} as CoreDeps["valkey"],
    internalSecret: "s".repeat(32),
    ...(over.watchRooms === false ? {} : { watchRooms: () => watchRooms }),
  } satisfies CoreDeps;
  return {
    core: new ChatCore(deps),
    rooms: realRooms,
    logs,
    published,
    enqueued,
    calls,
    set: {
      publishFails: (on) => (publishFails = on),
      profile: (p) => (profile = p),
      standing: (fn) => (standingFn = fn),
      channel: (fn) => (channelFn = fn),
      moderation: (fn) => (moderationFn = fn),
      onJoin: (fn) => (onJoin = fn),
    },
  };
}

const send = (body = "hello") => ({ channel: CH.slug, body, isAction: false, replyToId: null });
const pass = () => Promise.resolve("continue" as const);
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("submit", () => {
  test.each([
    ["anonymous", identity({ userId: null })],
    ["read-only", identity({ scopes: ["chat:read"] })],
  ])("%s credentials are refused before any lookup", async (_name, id) => {
    const h = harness();
    h.set.channel(() => Promise.reject(new Error("must not be called")));
    expect(await h.core.submit(id, send())).toEqual({ id: null, held: false, notice: REQUIRES_LOGIN });
  });

  test("an unknown channel is rejected", async () => {
    const h = harness();
    const r = await h.core.submit(identity(), { ...send(), channel: "nobody" });
    expect(r).toEqual({ id: null, held: false, notice: { code: "msg_rejected", text: "No such channel." } });
    expect(h.enqueued).toEqual([]);
  });

  test("a user whose profile is gone is rejected by the pipeline, not persisted", async () => {
    const h = harness();
    h.set.profile(null);
    const r = await h.core.submit(identity(), send());
    expect(r.id).toBeNull();
    expect(r.notice?.code).toBe("msg_requires_login");
    expect(h.enqueued).toEqual([]);
  });

  test("a failed fan-out and event publish still ack the persisted message, and are logged", async () => {
    const h = harness();
    h.set.publishFails(true);
    const r = await h.core.submit(identity(), send());
    expect(r.id).toBeTruthy();
    expect(r.notice).toBeNull();
    expect(h.enqueued).toHaveLength(1);
    const errors = h.logs.filter((l) => l.level === "error").map((l) => l.msg);
    expect(errors).toEqual(["chat fan-out publish failed", "chat event publish failed"]);
    // Logged by channel id only: no message body or user in the log line.
    expect(JSON.stringify(h.logs)).not.toContain("hello");
  });

  test("a rejected onMessage hook is logged and does not fail the send", async () => {
    const seen: string[] = [];
    const h = harness({
      middlewares: [
        { name: "boom", process: pass, onMessage: () => Promise.reject(new Error("hook failed")) },
        { name: "plain", process: pass },
        {
          name: "ok",
          process: pass,
          onMessage: (_ctx, m) => {
            seen.push(m.body);
            return Promise.resolve();
          },
        },
      ],
    });
    const r = await h.core.submit(identity(), send("hi there"));
    expect(r.id).toBeTruthy();
    await tick();
    expect(seen).toEqual(["hi there"]);
    expect(h.logs.find((l) => l.msg === "chat middleware onMessage failed")).toMatchObject({ middleware: "boom" });
  });

  test("skipMiddleware skips the process stages only: onMessage hooks still observe the message", async () => {
    let calls = 0;
    const h = harness({
      middlewares: [
        {
          name: "count",
          process: pass,
          onMessage: () => {
            calls++;
            return Promise.resolve();
          },
        },
      ],
    });
    await h.core.submit(identity(), send(), { skipMiddleware: true });
    await tick();
    // Plugins rely on this: the bot sees its own `say` messages and ignores them itself.
    expect(calls).toBe(1);
  });

  test("a reply to a message in the recent cache quotes it without a database read", async () => {
    const h = harness();
    const { ws } = socket();
    await h.core.join(ws, CH.slug);
    const parentId = "00000000-0000-7000-8000-00000000beef";
    h.rooms.remember(CH.id, parentId, MOD_ID, "bob", "parent body");
    await h.core.submit(identity(), { ...send(), replyToId: parentId });
    const fanout = h.published.find((p) => p.channel === `chat:${CH.id}`);
    const frame = (JSON.parse(fanout?.message ?? "{}") as { frame: Extract<ServerFrame, { op: "message" }> }).frame;
    expect(frame.message.replyTo).toEqual({ id: parentId, username: "bob", body: "parent body" });
  });

  test("an unparseable mediaTs hint is dropped, and dvr playback stores no media time", async () => {
    const h = harness();
    await h.core.submit(identity(), { ...send(), mediaTs: "not a date" });
    await h.core.submit(identity(), { ...send("two"), mediaTs: NOW.toISOString(), playbackMode: "dvr" });
    expect(h.enqueued.map((r) => (r as { mediaTs: Date | null }).mediaTs)).toEqual([null, null]);
  });
});

describe("command", () => {
  test("anonymous callers get a login notice", async () => {
    const h = harness();
    expect(await h.core.command(identity({ userId: null }), CH.slug, "clear", [])).toMatchObject({
      code: "msg_requires_login",
    });
  });

  test("unknown commands report the parser's code", async () => {
    const h = harness();
    const r = await h.core.command(identity(), CH.slug, "definitely-not-a-command", []);
    expect(r.code).not.toBe("cmd_success");
  });

  test("an unknown channel is rejected", async () => {
    const h = harness();
    expect(await h.core.command(identity(), "nobody", "clear", [])).toEqual({
      code: "msg_rejected",
      text: "No such channel.",
    });
  });

  test("a caller whose profile is gone gets a login notice", async () => {
    const h = harness();
    h.set.profile(null);
    expect((await h.core.command(identity(), CH.slug, "clear", [])).code).toBe("msg_requires_login");
  });

  test("a throwing moderation action yields one generic notice and a log line", async () => {
    const h = harness();
    h.set.moderation(() => Promise.reject(new Error("db exploded: SELECT secret")));
    const r = await h.core.command(identity(), CH.slug, "clear", []);
    expect(r).toEqual({ code: "msg_rejected", text: "The command failed. Try again." });
    expect(r.text).not.toContain("SELECT");
    expect(h.logs.find((l) => l.msg === "chat command failed")).toMatchObject({ command: "clear", channelId: CH.id });
  });

  test("/me returns the submit notice, or a success notice when it was sent", async () => {
    const h = harness();
    expect(await h.core.command(identity(), CH.slug, "me", ["waves"])).toEqual({
      code: "cmd_success",
      text: "Message sent.",
    });
    expect(await h.core.command(identity({ scopes: ["chat:read"] }), CH.slug, "me", ["waves"])).toEqual(REQUIRES_LOGIN);
  });
});

describe("join and part", () => {
  test("the room cap counts distinct rooms; rejoining a joined room is allowed", async () => {
    const h = harness({ maxRooms: 1 });
    const { ws, sent } = socket();
    expect(await h.core.join(ws, CH.slug)).toBeNull();
    expect(await h.core.join(ws, "other")).toEqual({
      code: "too_many_rooms",
      message: "At most 1 rooms per connection.",
    });
    expect(await h.core.join(ws, CH.slug)).toBeNull();
    expect(sent.filter((f) => f.op === "joined")).toHaveLength(2);
  });

  test("an unknown channel is reported", async () => {
    const h = harness();
    const { ws } = socket();
    expect(await h.core.join(ws, "nobody")).toEqual({
      code: "channel_not_found",
      message: "No channel named nobody.",
    });
  });

  test("a socket that closes while joining is parted again and gets no joined frame", async () => {
    const h = harness();
    const { ws, sent } = socket();
    h.set.onJoin((s) => (s.data.closed = true));
    expect(await h.core.join(ws, CH.slug)).toBeNull();
    expect(ws.data.rooms.size).toBe(0);
    expect(h.rooms.get(CH.id)).toBeUndefined();
    expect(sent).toEqual([]);
  });

  test("an anonymous joiner gets no badges and cannot moderate", async () => {
    const h = harness();
    h.set.profile(null);
    const { ws, sent } = socket(identity({ userId: null, scopes: ["chat:read"] }));
    await h.core.join(ws, CH.slug);
    expect(sent[0]).toMatchObject({ op: "joined", me: { badges: [], canModerate: false, canChat: false } });
  });

  test("a moderator role without the moderate scope is not a moderator view", async () => {
    const h = harness();
    h.set.standing(() => ({ ...NO_STANDING, isModerator: true }));
    const scoped = socket();
    const unscoped = socket(identity({ scopes: ["chat:read", "chat:edit"] }));
    await h.core.join(scoped.ws, CH.slug);
    await h.core.join(unscoped.ws, CH.slug);
    expect(scoped.sent[0]).toMatchObject({ me: { canModerate: true } });
    expect(unscoped.sent[0]).toMatchObject({ me: { canModerate: false } });
  });

  test("parting a room that was never joined still answers parted", async () => {
    const h = harness();
    const { ws, sent } = socket();
    await h.core.part(ws, "never-joined");
    expect(sent).toEqual([{ op: "parted", channel: "never-joined" }]);
  });

  test("partAll leaves every room and empties the socket's room map", async () => {
    const h = harness();
    const { ws } = socket();
    await h.core.join(ws, CH.slug);
    await h.core.partAll(ws);
    expect(ws.data.rooms.size).toBe(0);
    expect(h.rooms.get(CH.id)).toBeUndefined();
  });
});

describe("bus handlers", () => {
  async function joinedRoom(h: Harness) {
    const viewer = socket(identity({ scopes: ["chat:read", "chat:edit"] }));
    h.set.standing((id) => (id === MOD_ID ? { ...NO_STANDING, isModerator: true } : NO_STANDING));
    await h.core.join(viewer.ws, CH.slug);
    const mod = socket(identity({ userId: MOD_ID }));
    await h.core.join(mod.ws, CH.slug);
    viewer.sent.length = 0;
    mod.sent.length = 0;
    return { viewer, mod };
  }

  test("onChat ignores malformed envelopes and routes held-audience frames to moderators", async () => {
    const h = harness();
    const { viewer, mod } = await joinedRoom(h);
    for (const raw of ["{", "null", "[]", '{"v":2,"frame":{"op":"clear"}}', '{"v":1}', '{"v":1,"frame":{"op":3}}'])
      expect(() => h.core.onChat(CH.id, raw)).not.toThrow();
    expect([...viewer.sent, ...mod.sent]).toEqual([]);
    // No sentAt: no latency sample, still delivered.
    h.core.onChat(CH.id, JSON.stringify({ v: 1, audience: "moderators", frame: { op: "clear", channel: CH.slug } }));
    expect(mod.sent).toEqual([{ op: "clear", channel: CH.slug }]);
    expect(viewer.sent).toEqual([]);
    h.core.onChat(CH.id, JSON.stringify({ v: 1, audience: "bogus", frame: { op: "clear", channel: CH.slug } }));
    expect(viewer.sent).toEqual([{ op: "clear", channel: CH.slug }]);
  });

  test("onChat remembers delivered messages for replies, not held ones", async () => {
    const h = harness();
    await joinedRoom(h);
    const message = (id: string) => ({
      id,
      channelId: CH.id,
      user: { id: MOD_ID, username: "bob", displayName: "Bob", color: "chat-1", badges: [], accountType: "human" },
      body: `body ${id}`,
      emotes: [],
      isAction: false,
      replyTo: null,
      createdAt: NOW.toISOString(),
    });
    const a = "00000000-0000-7000-8000-00000000000a";
    const b = "00000000-0000-7000-8000-00000000000b";
    h.core.onChat(
      CH.id,
      JSON.stringify({
        v: 1,
        audience: "all",
        sentAt: Date.now(),
        frame: { op: "message", channel: CH.slug, message: message(a) },
      }),
    );
    h.core.onChat(
      CH.id,
      JSON.stringify({
        v: 1,
        audience: "moderators",
        sentAt: Date.now(),
        frame: { op: "message", channel: CH.slug, message: message(b), held: true },
      }),
    );
    expect(h.rooms.get(CH.id)?.recent.has(a)).toBe(true);
    expect(h.rooms.get(CH.id)?.recent.has(b)).toBe(false);
  });

  test("onControl drops malformed messages with a warning and forwards nothing", async () => {
    const h = harness();
    const { viewer } = await joinedRoom(h);
    for (const raw of ["{", '{"op":"nope"}', '{"op":"invalidate","scope":"everything"}', '{"op":"pong"}'])
      h.core.onControl(CH.id, raw);
    expect(viewer.sent).toEqual([]);
    expect(h.logs.filter((l) => l.msg === "malformed chat control message")).toHaveLength(4);
    expect(h.calls).toEqual([]);
  });

  test("invalidate: channel scope drops the channel; user scope drops one standing or all of them", async () => {
    const h = harness();
    const { viewer } = await joinedRoom(h);
    h.core.onControl(CH.id, JSON.stringify({ op: "invalidate", scope: "channel" }));
    h.core.onControl(CH.id, JSON.stringify({ op: "invalidate", scope: "user", userId: MOD_ID }));
    h.core.onControl(CH.id, JSON.stringify({ op: "invalidate", scope: "user" }));
    await tick();
    expect(h.calls).toEqual([
      `invalidateChannel:${CH.id}`,
      `invalidateStanding:${CH.id}:${MOD_ID}`,
      `invalidateStanding:${CH.id}:*`,
    ]);
    // Invalidations are cache signals only: nothing reaches the sockets.
    expect(viewer.sent).toEqual([]);
  });

  test("refreshModerators promotes and demotes from fresh standings, for one user or the whole room", async () => {
    const h = harness();
    const { viewer, mod } = await joinedRoom(h);
    const isMod = new Set<string>([MOD_ID]);
    h.set.standing((id) => ({ ...NO_STANDING, isModerator: isMod.has(id) }));
    const scopedId = "00000000-0000-7000-8000-0000000000d2";
    const scoped = socket(identity({ userId: scopedId }));
    await h.core.join(scoped.ws, CH.slug);
    scoped.sent.length = 0;
    const members = () => [...(h.rooms.get(CH.id)?.members.values() ?? [])];
    const flag = (uid: string) => members().find((m) => m.userId === uid)?.canModerate;

    // A member whose socket has the moderate scope is promoted by a one-user refresh.
    expect(flag(scopedId)).toBe(false);
    isMod.add(scopedId);
    h.core.onControl(CH.id, JSON.stringify({ op: "invalidate", scope: "user", userId: scopedId }));
    await tick();
    expect(flag(scopedId)).toBe(true);
    // The viewer is promoted, but its socket lacks the moderate scope: still not a moderator view.
    isMod.add(ALICE.id);
    h.core.onControl(CH.id, JSON.stringify({ op: "invalidate", scope: "user", userId: ALICE.id }));
    await tick();
    expect(flag(ALICE.id)).toBe(false);
    // The moderator is demoted by a room-wide refresh.
    isMod.delete(MOD_ID);
    h.core.onControl(CH.id, JSON.stringify({ op: "invalidate", scope: "user" }));
    await tick();
    expect(flag(MOD_ID)).toBe(false);
    expect(viewer.sent).toEqual([]);
    expect(mod.sent).toEqual([]);
  });

  test("refreshModerators logs a failing standing lookup and gives up on a vanished channel", async () => {
    const h = harness();
    await joinedRoom(h);
    h.set.standing(() => Promise.reject(new Error("db down")));
    h.core.onControl(CH.id, JSON.stringify({ op: "invalidate", scope: "user", userId: MOD_ID }));
    await tick();
    expect(h.logs.find((l) => l.msg === "moderator refresh failed")).toMatchObject({ channelId: CH.id });

    h.set.channel(() => Promise.resolve(null));
    h.set.standing(() => {
      throw new Error("must not be called");
    });
    h.core.onControl(CH.id, JSON.stringify({ op: "invalidate", scope: "user", userId: MOD_ID }));
    await tick();
    expect(h.logs.filter((l) => l.msg === "moderator refresh failed")).toHaveLength(1);

    // A room this instance does not host: nothing to refresh.
    h.core.onControl("00000000-0000-7000-8000-0000000000ff", JSON.stringify({ op: "invalidate", scope: "user" }));
    await tick();
    expect(h.logs.filter((l) => l.msg === "moderator refresh failed")).toHaveLength(1);
  });

  test("ban: moderators get the reason, everyone else an empty one; the cache forgets the user", async () => {
    const h = harness();
    const { viewer, mod } = await joinedRoom(h);
    h.rooms.remember(CH.id, "00000000-0000-7000-8000-00000000000c", ALICE.id, "alice", "x");
    const ban = { op: "ban", channel: CH.slug, userId: ALICE.id, username: "alice", expiresAt: null, reason: "spam" };
    h.core.onControl(CH.id, JSON.stringify(ban));
    expect(mod.sent).toEqual([ban]);
    expect(viewer.sent).toEqual([{ ...ban, reason: "" }]);
    expect(h.calls).toEqual([`invalidateStanding:${CH.id}:${ALICE.id}`]);
    expect(h.rooms.get(CH.id)?.recent.size).toBe(0);
  });

  test("settings, delete, clear and surge update caches and reach everyone", async () => {
    const h = harness();
    const { viewer, mod } = await joinedRoom(h);
    const msgId = "00000000-0000-7000-8000-00000000000d";
    const other = "00000000-0000-7000-8000-00000000000e";
    h.rooms.remember(CH.id, msgId, MOD_ID, "bob", "x");
    h.rooms.remember(CH.id, other, MOD_ID, "bob", "y");
    const frames = [
      { op: "settings", channel: CH.slug, settings: CH.settings },
      { op: "delete", channel: CH.slug, messageId: msgId, username: "bob" },
      { op: "surge", channel: CH.slug, state: "on", until: null },
    ];
    for (const f of frames) h.core.onControl(CH.id, JSON.stringify(f));
    expect(h.rooms.get(CH.id)?.recent.has(msgId)).toBe(false);
    expect(h.rooms.get(CH.id)?.recent.has(other)).toBe(true);
    h.core.onControl(CH.id, JSON.stringify({ op: "clear", channel: CH.slug }));
    expect(h.rooms.get(CH.id)?.recent.size).toBe(0);
    expect(h.calls).toEqual([`invalidateChannel:${CH.id}`, `surgeInvalidate:${CH.id}`]);
    expect(viewer.sent.map((f) => f.op)).toEqual(["settings", "delete", "surge", "clear"]);
    expect(mod.sent.map((f) => f.op)).toEqual(["settings", "delete", "surge", "clear"]);
  });

  test("invalidateUser drops the user everywhere and refreshes only rooms the user is in", async () => {
    const h = harness();
    await joinedRoom(h);
    const looked: string[] = [];
    h.set.standing((id) => {
      looked.push(id);
      return NO_STANDING;
    });
    h.core.invalidateUser(MOD_ID);
    h.core.invalidateUser("00000000-0000-7000-8000-0000000000ee");
    await tick();
    await tick();
    expect(h.calls).toEqual([`invalidateUser:${MOD_ID}`, "invalidateUser:00000000-0000-7000-8000-0000000000ee"]);
    expect(looked).toEqual([MOD_ID]);
  });

  test("onEvent drops malformed, unrouted, unhosted and invalid events", async () => {
    const h = harness();
    const { viewer, mod } = await joinedRoom(h);
    const good = {
      id: "00000000-0000-7000-8000-0000000000e1",
      type: "channel.tip",
      version: "1",
      channelId: CH.id,
      payload: { amount: 5 },
      occurredAt: NOW.toISOString(),
    };
    const bad = [
      "{",
      "null",
      JSON.stringify({ ...good, type: 7 }),
      JSON.stringify({ ...good, channelId: null }),
      JSON.stringify({ ...good, type: "channel.chat.message" }),
      JSON.stringify({ ...good, channelId: "00000000-0000-7000-8000-0000000000ff" }),
      JSON.stringify({ ...good, version: 1 }),
      JSON.stringify({ ...good, payload: undefined }),
    ];
    for (const raw of bad) h.core.onEvent(raw);
    expect([...viewer.sent, ...mod.sent]).toEqual([]);
    h.core.onEvent(JSON.stringify(good));
    const frame = { op: "event", channel: CH.slug, type: "channel.tip", data: { amount: 5 } };
    expect(viewer.sent).toEqual([frame]);
    expect(mod.sent).toEqual([frame]);
    h.core.onEvent(JSON.stringify({ ...good, type: "channel.follow", payload: { user_id: ALICE.id } }));
    expect(mod.sent).toHaveLength(2);
    expect(viewer.sent).toHaveLength(1);
  });

  test("onLive invalidates the channel named by a live event and ignores anything else", () => {
    const h = harness();
    for (const raw of ["{", "null", "42", '{"channelId":5}', "{}"]) expect(() => h.core.onLive(raw)).not.toThrow();
    expect(h.calls).toEqual([]);
    h.core.onLive(JSON.stringify({ channelId: CH.id, status: "online" }));
    expect(h.calls).toEqual([`invalidateChannel:${CH.id}`]);
  });
});

describe("construction", () => {
  test("without a watch-room factory the built-in WatchRooms handler is used", () => {
    const h = harness({ watchRooms: false });
    expect(typeof h.core.watchRooms.join).toBe("function");
    expect(typeof h.core.watchRooms.onControl).toBe("function");
  });
});
