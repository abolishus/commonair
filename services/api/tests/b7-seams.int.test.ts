// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The batch 7 contract step's API seams (§5.1, §5.3): every unit's route file is mounted (its stub
 * answers 501, not 404), the raw routes dispatch (federation 404 while the flag is off, 501 on;
 * the portability keys under /api; the Twitch callback only when the import is available), the
 * report and follow hooks are reached, and the b7 test hooks enqueue on the right queue.
 */
import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { Valkey } from "iovalkey";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  INTERNAL_ROUTES,
  INTERNAL_SECRET_HEADER,
  JURY_JOBS,
  KEYS,
  mediaPath,
  QUEUES,
  WATCH_ROOM_JOBS,
} from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { B7_TICK_QUEUES } from "../src/ops/b7-hooks.ts";
import { client, signUpAndSignIn, startApi, VALKEY_URL, type TestApi } from "./harness.ts";

let api: TestApi;
type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
let alice: User;
let bob: User;
const prefix = `test-b7-${crypto.randomUUID()}`;
const conns: Valkey[] = [];
const workers: Worker[] = [];
const ID = "01890000-0000-7000-8000-00000000c001";

beforeAll(async () => {
  api = await startApi({ env: { OPS_TEST_HOOKS: "true", WORKER_BULL_PREFIX: prefix } });
  [alice, bob] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
}, 120_000);
afterAll(async () => {
  for (const w of workers) await w.close();
  for (const c of conns) c.disconnect();
  await api?.stop();
});

/** The env is a plain object: flip a flag for one block. */
async function withEnv(patch: Record<string, unknown>, fn: () => Promise<void>) {
  const env = api.deps.env as unknown as Record<string, unknown>;
  const before = Object.fromEntries(Object.keys(patch).map((k) => [k, env[k]]));
  Object.assign(env, patch);
  try {
    await fn();
  } finally {
    Object.assign(env, before);
  }
}

describe("unit route files are mounted (stubs answer 501)", () => {
  test("one procedure of each group reaches its stub", async () => {
    const c = alice.client;
    const calls: [string, string, unknown?][] = [
      ["GET", "/api/me/watch-rooms"],
      ["GET", `/api/channels/${alice.username}/move-links`],
      ["GET", "/api/jury/status"],
      ["GET", `/api/channels/${alice.username}/twitch-import`],
      ["GET", `/api/channels/${alice.username}/federation`],
      ["GET", `/api/channels/${alice.username}/giveaways/current`],
    ];
    for (const [method, path, body] of calls) {
      const r = await c.call(method, path, body);
      expect([r.status, path]).toEqual([501, path]);
    }
  });
});

describe("raw routes", () => {
  const fed = [
    ["GET", "/api/.well-known/webfinger?resource=acct:someone@example.test"],
    ["GET", "/api/.well-known/nodeinfo"],
    ["GET", "/api/nodeinfo/2.1"],
    ["GET", `/ap/channels/${ID}`],
    ["GET", `/ap/channels/${ID}/outbox`],
    ["GET", `/ap/channels/${ID}/followers`],
    ["POST", `/ap/channels/${ID}/inbox`],
    ["POST", "/ap/inbox"],
  ] as const;
  const send = (method: string, path: string) =>
    fetch(`${api.url}${path}`, {
      method,
      headers: { "content-type": "application/activity+json" },
      ...(method === "POST" ? { body: "{}" } : {}),
    });

  test("federation: 404 while FEDERATION_ENABLED is off, whatever the method", async () => {
    for (const [method, path] of fed) {
      expect([(await send(method, path)).status, path]).toEqual([404, path]);
      expect([(await send(method === "GET" ? "POST" : "GET", path)).status, path]).toEqual([404, path]);
    }
  });

  test("federation on: every route reaches its stub (501), a wrong method is 405", async () => {
    await withEnv({ FEDERATION_ENABLED: true }, async () => {
      for (const [method, path] of fed) {
        expect([(await send(method, path)).status, path]).toEqual([501, path]);
        const wrong = await send(method === "GET" ? "POST" : "GET", path);
        expect([wrong.status, wrong.headers.get("allow")]).toEqual([405, method]);
      }
      // Unknown paths under /ap stay plain 404s.
      expect((await send("GET", `/ap/channels/${ID}/following`)).status).toBe(404);
    });
  });

  test("/api/.well-known/commonair-portability serves the key history, flags off", async () => {
    const empty = await fetch(`${api.url}/api/.well-known/commonair-portability`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ origin: new URL(api.url).origin, keys: [] });
    const firstUsedAt = new Date("2026-10-01T00:00:00.000Z");
    // The worker writes the row when it first signs; the test database's owner stands in for it.
    await api.db.db.insert(schema.portabilitySigningKeys).values({
      kid: "AAAAAAAAAAAAAAAAAAAAAA",
      publicKey: "B".repeat(43),
      firstUsedAt,
    });
    const res = await fetch(`${api.url}/api/.well-known/commonair-portability`);
    expect(await res.json()).toEqual({
      origin: new URL(api.url).origin,
      keys: [
        {
          kid: "AAAAAAAAAAAAAAAAAAAAAA",
          algorithm: "Ed25519",
          publicKey: "B".repeat(43),
          firstUsedAt: firstUsedAt.toISOString(),
          retiredAt: null,
          compromisedAt: null,
        },
      ],
    });
    expect((await fetch(`${api.url}/api/.well-known/commonair-portability`, { method: "POST" })).status).toBe(405);
    // The bare path is Caddy's to rewrite; the API itself does not serve it.
    expect((await fetch(`${api.url}/.well-known/commonair-portability`)).status).toBe(404);
  });

  test("the Twitch import callback exists only with the flag and both credentials", async () => {
    const path = "/api/twitch-import/callback?code=x&state=y";
    expect((await fetch(`${api.url}${path}`)).status).toBe(404);
    await withEnv({ TWITCH_IMPORT_ENABLED: true }, async () => {
      expect((await fetch(`${api.url}${path}`)).status).toBe(404);
    });
    await withEnv(
      { TWITCH_IMPORT_ENABLED: true, OAUTH_TWITCH_CLIENT_ID: "id", OAUTH_TWITCH_CLIENT_SECRET: "secret" },
      async () => {
        expect((await fetch(`${api.url}${path}`)).status).toBe(501);
        expect((await fetch(`${api.url}${path}`, { method: "POST" })).status).toBe(405);
        const info = await client(api).call<{ features: { twitchImport: boolean } }>("GET", "/api/instance");
        expect(info.body.features.twitchImport).toBe(true);
      },
    );
  });

  test("instance.info carries the three flags, off by default", async () => {
    const info = await client(api).call<{ features: Record<string, unknown> }>("GET", "/api/instance");
    expect(info.status).toBe(200);
    expect(info.body.features).toMatchObject({ giveaways: false, federation: false, twitchImport: false });
  });
});

describe("hooks", () => {
  test("a watch_room report reaches watchRoomEvidence (the stub finds no room: 404)", async () => {
    const r = await bob.client.call("POST", "/api/reports", {
      subjectType: "watch_room",
      subjectId: uuidv7(),
      reason: "harassment",
    });
    expect(r.status).toBe(404);
  });

  test("a follow through a move link still follows (attributeFollow is a no-op stub)", async () => {
    const r = await bob.client.call<{ following: boolean; followerCount: number }>(
      "PUT",
      `/api/channels/${alice.username}/follow`,
      { notify: true, moveLink: { nonce: "n".repeat(22) } },
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ following: true, followerCount: 1 });
    const [f] = await api.db.db.select().from(schema.follows).where(eq(schema.follows.followerId, bob.userId));
    expect(f).toMatchObject({ source: "direct", moveLinkId: null });
  });
});

describe("b7 test hooks", () => {
  const call = (path: string, method: string, body: unknown, secret: string | null = api.internalSecret) =>
    fetch(`${api.url}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(secret ? { [INTERNAL_SECRET_HEADER]: secret } : {}) },
      body: JSON.stringify(body),
    });

  test("404 while off (before the secret check), 401 without the secret, 405 and 400 otherwise", async () => {
    await withEnv({ OPS_TEST_HOOKS: false }, async () => {
      for (const p of [INTERNAL_ROUTES.b7Tick, INTERNAL_ROUTES.watchRoomAge, INTERNAL_ROUTES.relayPurgeHold])
        expect((await call(p, "POST", {}, null)).status).toBe(404);
    });
    expect((await call(INTERNAL_ROUTES.b7Tick, "POST", { job: JURY_JOBS.draw }, null)).status).toBe(401);
    expect((await call(INTERNAL_ROUTES.b7Tick, "PUT", { job: JURY_JOBS.draw })).status).toBe(405);
    expect((await call(INTERNAL_ROUTES.b7Tick, "POST", { job: "portability-build" })).status).toBe(400);
    expect((await call(INTERNAL_ROUTES.relayPurgeHold, "POST", { seconds: 1 })).status).toBe(405);
    expect((await call(INTERNAL_ROUTES.relayPurgeHold, "PUT", { seconds: 30 })).status).toBe(400);
    expect((await call(INTERNAL_ROUTES.watchRoomAge, "POST", { roomId: "x", days: 31 })).status).toBe(400);
    expect((await call(INTERNAL_ROUTES.watchRoomAge, "POST", { roomId: uuidv7(), days: 31 })).status).toBe(404);
  });

  test("age a room: it ends, its open memberships are left, and its times move back", async () => {
    const ready = await call(INTERNAL_ROUTES.mediaReady, "POST", {
      path: mediaPath(alice.username),
      sourceType: "rtmpConn",
      sourceId: crypto.randomUUID(),
    });
    expect(ready.status).toBe(204);
    const db = api.db.db;
    const [ch] = await db.select().from(schema.channels).where(eq(schema.channels.slug, alice.username));
    if (!ch?.liveBroadcastId) throw new Error("not live");
    const [room] = await db
      .insert(schema.watchRooms)
      .values({
        hostId: alice.userId,
        channelId: ch.id,
        broadcastId: ch.liveBroadcastId,
        ageBand: "adult",
        inviteHash: "a".repeat(64),
      })
      .returning();
    if (!room) throw new Error("no room");
    await db.insert(schema.watchRoomMembers).values({ roomId: room.id, userId: alice.userId });
    const before = Date.now();
    expect((await call(INTERNAL_ROUTES.watchRoomAge, "POST", { roomId: room.id, days: 31 })).status).toBe(200);
    const [aged] = await db.select().from(schema.watchRooms).where(eq(schema.watchRooms.id, room.id));
    expect(aged).toMatchObject({ endReason: "host_closed", inviteHash: null });
    const day = 86_400_000;
    expect(before - (aged?.endedAt?.getTime() ?? 0)).toBeGreaterThan(31 * day - 60_000);
    expect(room.createdAt.getTime() - (aged?.createdAt.getTime() ?? 0)).toBe(31 * day);
    const members = await db.select().from(schema.watchRoomMembers).where(eq(schema.watchRoomMembers.roomId, room.id));
    expect(members.every((m) => m.leftAt !== null)).toBe(true);
    // An ended room keeps its end; aging again only moves it further back.
    expect((await call(INTERNAL_ROUTES.watchRoomAge, "POST", { roomId: room.id, days: 1 })).status).toBe(200);
    const [again] = await db.select().from(schema.watchRooms).where(eq(schema.watchRooms.id, room.id));
    expect((aged?.endedAt?.getTime() ?? 0) - (again?.endedAt?.getTime() ?? 0)).toBe(day);
  });

  test("every tickable job has a queue", () => {
    expect(B7_TICK_QUEUES[WATCH_ROOM_JOBS.retention]).toBe(QUEUES.watchRooms);
    expect(new Set(Object.values(B7_TICK_QUEUES))).toEqual(
      new Set([QUEUES.watchRooms, QUEUES.jury, QUEUES.interact, QUEUES.federation]),
    );
  });

  test("the tick runs the job now on its queue and returns its result", async () => {
    const seen: { name: string; data: unknown }[] = [];
    const conn = new Valkey(VALKEY_URL, { maxRetriesPerRequest: null });
    conns.push(conn);
    workers.push(
      new Worker(
        QUEUES.jury,
        async (job) => {
          seen.push({ name: job.name, data: job.data });
          return { drawn: 7 };
        },
        { connection: conn, prefix },
      ),
    );
    const r = await call(INTERNAL_ROUTES.b7Tick, "POST", { job: JURY_JOBS.draw });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ drawn: 7 });
    expect(seen).toEqual([{ name: JURY_JOBS.draw, data: {} }]);
  });

  test("the purge hold is set and cleared", async () => {
    expect((await call(INTERNAL_ROUTES.relayPurgeHold, "PUT", { seconds: 1 })).status).toBe(200);
    expect(await api.deps.valkey.get(KEYS.relayPurgeHold)).toBe("1");
    expect((await call(INTERNAL_ROUTES.relayPurgeHold, "PUT", { seconds: null })).status).toBe(200);
    expect(await api.deps.valkey.get(KEYS.relayPurgeHold)).toBeNull();
  });
});
