// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: Apache-2.0

import { EVENTSUB_WS_CLOSE, EVENTSUB_WS_PATH } from "@commonair/contracts/eventsub";
import type { WsMessage } from "@commonair/contracts/events";
import type { ServerWebSocket } from "bun";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  closeCodeName,
  connectEventSub,
  eventSubUrl,
  subscribe,
  type CommonAirClient,
  type EventSubNotification,
  type EventSubRevocation,
  type EventSubSession,
} from "../src/index.ts";

interface Conn {
  sessionId: string | null;
  resumed: boolean;
}

const SUB = {
  id: "0193a1b2-0000-7000-8000-0000000000aa",
  type: "channel.follow" as const,
  version: "1",
  status: "enabled",
  condition: { broadcaster_user_id: "b1" },
  transport: { method: "websocket" as const, session_id: "s" },
  created_at: "2026-10-29T11:00:00.000Z",
};

let counter = 0;
const meta = (type: WsMessage["metadata"]["message_type"], id = `m${++counter}`, sub?: boolean) => ({
  message_id: id,
  message_type: type,
  message_timestamp: new Date().toISOString(),
  ...(sub ? { subscription_type: SUB.type, subscription_version: "1" } : {}),
});

/** An in-process EventSub WebSocket server that does only what each test tells it to. */
function fakeEventSub(opts: { keepalive?: number; welcome?: boolean } = {}) {
  const sockets: ServerWebSocket<Conn>[] = [];
  const resumes = new Map<string, string>();
  let nextSession = 0;
  const welcome = (ws: ServerWebSocket<Conn>, id: string) =>
    ws.send(
      JSON.stringify({
        metadata: meta("session_welcome"),
        payload: {
          session: {
            id,
            status: "connected",
            keepalive_timeout_seconds: opts.keepalive ?? 1,
            reconnect_url: null,
            connected_at: new Date().toISOString(),
          },
        },
      }),
    );
  const server = Bun.serve<Conn>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname !== EVENTSUB_WS_PATH) return new Response("not found", { status: 404 });
      const resume = url.searchParams.get("resume");
      const sessionId = resume === null ? null : (resumes.get(resume) ?? null);
      return srv.upgrade(req, { data: { sessionId, resumed: resume !== null } })
        ? undefined
        : new Response("upgrade required", { status: 426 });
    },
    websocket: {
      open(ws) {
        sockets.push(ws);
        if (opts.welcome === false) return;
        ws.data.sessionId ??= `session-${++nextSession}`;
        welcome(ws, ws.data.sessionId);
      },
      message() {},
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    origin,
    sockets,
    /** Sockets that are still open. */
    open: () => sockets.filter((s) => s.readyState === 1),
    send(ws: ServerWebSocket<Conn> | undefined, msg: unknown) {
      ws?.send(typeof msg === "string" ? msg : JSON.stringify(msg));
    },
    notification(
      ws: ServerWebSocket<Conn> | undefined,
      id: string,
      event: Record<string, unknown> = { user_id: "u1" },
    ) {
      ws?.send(JSON.stringify({ metadata: meta("notification", id, true), payload: { subscription: SUB, event } }));
    },
    keepalive(ws: ServerWebSocket<Conn> | undefined) {
      ws?.send(JSON.stringify({ metadata: meta("session_keepalive"), payload: {} }));
    },
    /** Send `session_reconnect` with a resume URL for this socket's session. */
    reconnect(ws: ServerWebSocket<Conn>) {
      const token = `resume-${Math.random()}`;
      resumes.set(token, ws.data.sessionId ?? "");
      ws.send(
        JSON.stringify({
          metadata: meta("session_reconnect"),
          payload: {
            session: {
              id: ws.data.sessionId,
              status: "reconnecting",
              keepalive_timeout_seconds: null,
              reconnect_url: `ws://127.0.0.1:${server.port}${EVENTSUB_WS_PATH}?resume=${token}`,
              connected_at: new Date().toISOString(),
            },
          },
        }),
      );
    },
    stop: () => server.stop(true),
  };
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function start(opts: Parameters<typeof fakeEventSub>[0] = {}) {
  const server = fakeEventSub(opts);
  cleanups.push(() => server.stop());
  return server;
}

async function connect(
  server: ReturnType<typeof fakeEventSub>,
  extra: Partial<Parameters<typeof connectEventSub>[0]> = {},
) {
  const errors: Error[] = [];
  const session = await connectEventSub({
    baseUrl: server.origin,
    watchdogGraceMs: 300,
    reconnectDelayMs: { initial: 50, max: 200 },
    onError: (e) => errors.push(e),
    ...extra,
  });
  cleanups.push(() => session.close());
  return { session, errors };
}

const until = async (what: string, cond: () => boolean, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

const collect = (s: EventSubSession) => {
  const notes: EventSubNotification[] = [];
  const revocations: EventSubRevocation[] = [];
  s.onNotification((n) => notes.push(n));
  s.onRevocation((r) => revocations.push(r));
  return { notes, revocations };
};

describe("EventSub client", () => {
  test("welcome: the session id; notifications and revocations reach their handlers", async () => {
    const server = start({ keepalive: 10 });
    const { session } = await connect(server);
    expect(session.sessionId).toBe("session-1");
    const { notes, revocations } = collect(session);
    const raw: string[] = [];
    session.on("notification", (m) => raw.push(m.metadata.message_id));
    server.notification(server.sockets[0], "n1", { user_id: "viewer-1" });
    server.send(server.sockets[0], {
      metadata: meta("revocation", "r1", true),
      payload: { subscription: { ...SUB, status: "authorization_revoked" } },
    });
    await until("both", () => notes.length === 1 && revocations.length === 1);
    expect(notes[0]).toMatchObject({
      messageId: "n1",
      subscriptionType: "channel.follow",
      subscriptionId: SUB.id,
      event: { user_id: "viewer-1" },
    });
    expect(revocations[0]).toMatchObject({ subscriptionId: SUB.id, status: "authorization_revoked" });
    expect(raw).toEqual(["n1"]);
  });

  test("keepalives keep the session; silence past keepalive + grace reconnects from scratch", async () => {
    const server = start({ keepalive: 1 });
    const newSessions: string[] = [];
    const { session } = await connect(server, { onNewSession: (id) => void newSessions.push(id) });
    // Keepalives every 400 ms for 2 s: no reconnect.
    for (let i = 0; i < 5; i++) {
      await Bun.sleep(400);
      server.keepalive(server.sockets[0]);
    }
    expect(server.sockets).toHaveLength(1);
    expect(newSessions).toEqual([]);
    // Then silence: 1 s + 300 ms grace, then a new session.
    await until("a new session", () => newSessions.length === 1, 4_000);
    expect(newSessions).toEqual(["session-2"]);
    expect(session.sessionId).toBe("session-2");
    await until("the dead socket closed", () => server.open().length === 1);
    const { notes } = collect(session);
    server.notification(server.sockets[1], "after");
    await until("delivered on the new session", () => notes.length === 1);
  }, 15_000);

  test("session_reconnect: hand over to reconnect_url, same session, no duplicate, old socket closed", async () => {
    const server = start({ keepalive: 10 });
    const newSessions: string[] = [];
    const { session } = await connect(server, { onNewSession: (id) => void newSessions.push(id) });
    const { notes } = collect(session);
    const reconnects: WsMessage[] = [];
    session.on("session_reconnect", (m) => reconnects.push(m));
    const old = server.sockets[0];
    if (!old) throw new Error("no socket");
    server.notification(old, "before");
    server.reconnect(old);
    await until("the new socket", () => server.sockets.length === 2);
    const fresh = server.sockets[1];
    // The server sends the same message on both while handing over.
    server.notification(old, "overlap");
    await until("the old socket closed by the client", () => old.readyState !== 1);
    server.notification(fresh, "overlap");
    server.notification(fresh, "after");
    await until("after", () => notes.some((n) => n.messageId === "after"));
    expect(notes.map((n) => n.messageId)).toEqual(["before", "overlap", "after"]);
    expect(session.sessionId).toBe("session-1");
    expect(fresh?.data.resumed).toBe(true);
    expect(newSessions).toEqual([]);
    expect(reconnects).toHaveLength(1);
  });

  test("a failed hand-over falls back to a new session", async () => {
    const server = start({ keepalive: 10 });
    const newSessions: string[] = [];
    const { session, errors } = await connect(server, { onNewSession: (id) => void newSessions.push(id) });
    server.send(server.sockets[0], {
      metadata: meta("session_reconnect"),
      payload: {
        session: {
          id: "session-1",
          status: "reconnecting",
          keepalive_timeout_seconds: null,
          reconnect_url: `${server.origin.replace("http", "ws")}/nope`,
          connected_at: new Date().toISOString(),
        },
      },
    });
    await until("a new session", () => newSessions.length === 1);
    expect(session.sessionId).not.toBe("session-1");
    expect(errors.length).toBeGreaterThan(0);
  });

  test("4008: revocation, then closed with reauthorize and no reconnect", async () => {
    const server = start({ keepalive: 10 });
    const { session } = await connect(server);
    const { revocations } = collect(session);
    server.send(server.sockets[0], {
      metadata: meta("revocation", "rv", true),
      payload: { subscription: { ...SUB, status: "authorization_revoked" } },
    });
    server.sockets[0]?.close(EVENTSUB_WS_CLOSE.authorizationRevoked, "authorization revoked");
    const closed = await session.closed;
    expect(closed).toEqual({
      code: 4008,
      reason: "authorization revoked",
      name: "authorizationRevoked",
      reauthorize: true,
      byClient: false,
    });
    expect(revocations).toHaveLength(1);
    await Bun.sleep(300);
    expect(server.sockets).toHaveLength(1);
  });

  test("4003 (never subscribed) ends the client; an internal error (4000) or a dropped socket reconnects", async () => {
    const a = start({ keepalive: 10 });
    const { session: s1 } = await connect(a);
    a.sockets[0]?.close(EVENTSUB_WS_CLOSE.connectionUnused, "connection unused");
    expect(await s1.closed).toMatchObject({ code: 4003, name: "connectionUnused", reauthorize: false });

    const b = start({ keepalive: 10 });
    const ids: string[] = [];
    await connect(b, { onNewSession: (id) => void ids.push(id) });
    b.sockets[0]?.close(EVENTSUB_WS_CLOSE.internalError, "oops");
    await until("reconnect after 4000", () => ids.length === 1);
    b.sockets[1]?.terminate();
    await until("reconnect after a drop", () => ids.length === 2);
    expect(ids).toEqual(["session-2", "session-3"]);
  });

  test("inbound validation: non-JSON and off-schema frames are dropped and reported", async () => {
    const server = start({ keepalive: 10 });
    const { session, errors } = await connect(server);
    const { notes } = collect(session);
    server.send(server.sockets[0], "not json");
    server.send(server.sockets[0], { metadata: { message_id: "x", message_type: "mystery" }, payload: {} });
    server.send(server.sockets[0], {
      metadata: meta("notification", "bad-type", false),
      payload: { subscription: { ...SUB, type: "nope" } },
    });
    server.notification(server.sockets[0], "good");
    await until("the good one", () => notes.length === 1);
    expect(notes.map((n) => n.messageId)).toEqual(["good"]);
    expect(errors).toHaveLength(3);
  });

  test("close() resolves closed by the client and stops reconnecting", async () => {
    const server = start({ keepalive: 1 });
    const { session } = await connect(server);
    session.close();
    expect(await session.closed).toMatchObject({ byClient: true, code: 1000 });
    await until("server saw the close", () => server.open().length === 0);
    await Bun.sleep(1_600);
    expect(server.sockets).toHaveLength(1);
  });

  test("no welcome in time rejects connectEventSub", async () => {
    const server = start({ welcome: false });
    await expect(connectEventSub({ baseUrl: server.origin, welcomeTimeoutMs: 200 })).rejects.toThrow(/session_welcome/);
  });

  test("a close before the first welcome rejects connectEventSub and opens no second socket", async () => {
    let upgrades = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        upgrades++;
        return srv.upgrade(req, { data: undefined }) ? undefined : new Response("upgrade required", { status: 426 });
      },
      websocket: {
        open(ws) {
          ws.close(1011, "not yet"); // not a terminal EventSub code
        },
        message() {},
      },
    });
    cleanups.push(() => server.stop(true));
    await expect(
      connectEventSub({
        baseUrl: `http://127.0.0.1:${server.port}`,
        reconnectDelayMs: { initial: 10, max: 20 },
      }),
    ).rejects.toThrow(/before session_welcome/);
    await Bun.sleep(300);
    expect(upgrades).toBe(1);
  });

  test("a handler that throws is reported and does not stop delivery", async () => {
    const server = start({ keepalive: 10 });
    const { session, errors } = await connect(server);
    session.onNotification(() => {
      throw new Error("handler bug");
    });
    const { notes } = collect(session);
    server.notification(server.sockets[0], "n");
    await until("delivered", () => notes.length === 1);
    expect(errors.map((e) => e.message)).toContain("handler bug");
  });

  test("an injected WebSocket constructor is used", async () => {
    const server = start({ keepalive: 10 });
    const urls: string[] = [];
    class Spy extends WebSocket {
      constructor(url: string) {
        urls.push(url);
        super(url);
      }
    }
    await connect(server, { WebSocket: Spy, keepaliveSeconds: 30 });
    expect(urls).toEqual([`${server.origin.replace("http", "ws")}${EVENTSUB_WS_PATH}?keepalive_timeout_seconds=30`]);
  });
});

describe("helpers", () => {
  test("eventSubUrl maps http→ws and https→wss", () => {
    expect(eventSubUrl("https://api.example.test/")).toBe(`wss://api.example.test${EVENTSUB_WS_PATH}`);
    expect(eventSubUrl("http://127.0.0.1:3001", 10)).toBe(
      `ws://127.0.0.1:3001${EVENTSUB_WS_PATH}?keepalive_timeout_seconds=10`,
    );
  });

  test("closeCodeName names every EventSub close code", () => {
    for (const [name, code] of Object.entries(EVENTSUB_WS_CLOSE)) expect(closeCodeName(code)).toBe(name);
    expect(closeCodeName(1000)).toBeNull();
  });

  test("subscribe calls developer.events.subscribe with the websocket transport", async () => {
    const calls: unknown[] = [];
    const client = {
      developer: { events: { subscribe: async (input: unknown) => (calls.push(input), { id: "sub" }) } },
    } as unknown as CommonAirClient;
    await subscribe(client, { type: "channel.follow", condition: { broadcaster_user_id: "b" }, sessionId: "s1" });
    expect(calls).toEqual([
      {
        type: "channel.follow",
        version: "1",
        condition: { broadcaster_user_id: "b" },
        transport: { method: "websocket", sessionId: "s1" },
      },
    ]);
  });
});
