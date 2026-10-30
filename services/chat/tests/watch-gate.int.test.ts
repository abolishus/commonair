// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The verified-watch gate against real Valkey and Postgres (ADR 0015): the reader's cache and the
 * key's TTL, `surge()` for every override state, the surge exemption's query, and the send path
 * through a chat instance (one denial code, the attempt limit, exemptions, a joined frame's surge).
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { KEYS } from "@commonair/contracts/internal";
import { schema, uuidv7, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createValkey, type ValkeyClient } from "@commonair/service";
import { ValkeyLimiter } from "../src/limiter.ts";
import { createMetrics } from "../src/metrics.ts";
import type { ChatService } from "../src/server.ts";
import type { ChannelState } from "../src/types.ts";
import { WatchGate } from "../src/watch-gate.ts";
import { channel as channelState } from "./fixtures.ts";
import {
  chatToken,
  Client,
  createChannel,
  createUser,
  isolation,
  quietLogger,
  startInstance,
  VALKEY_URL,
} from "./helpers.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let svc: ChatService;
let valkey: ValkeyClient;
const iso = isolation();
const clients: Client[] = [];
const GUARD = { enabled: true, triggerUnverifiedRatio: 0.5, cooldownMinutes: 10 };

beforeAll(async () => {
  t = await createTestDatabase();
  valkey = createValkey(VALKEY_URL, { keyPrefix: iso.keyPrefix, name: "chat-test-watch-gate" });
  svc = await startInstance(t.db, iso, { watchGate: true, surgeGuard: true });
});

afterAll(async () => {
  for (const c of clients) c.close();
  await svc?.stop();
  await valkey?.quit();
  await t?.drop();
});

async function liveChannel(db: Database, settings: Parameters<typeof createChannel>[2] = {}) {
  const owner = await createUser(db);
  const ch = await createChannel(db, owner, { requireVerifiedEmail: false, ...settings });
  const broadcastId = uuidv7();
  await db.insert(schema.broadcasts).values({
    id: broadcastId,
    channelId: ch.id,
    ingestProtocol: "rtmp",
    path: `live/${ch.slug}`,
    startedAt: new Date(Date.now() - 600_000),
  });
  await db.update(schema.channels).set({ liveBroadcastId: broadcastId }).where(eq(schema.channels.id, ch.id));
  return { owner, ...ch, broadcastId };
}

const watched = (channelId: string, userId: string, b: string, s: number, ttl = 600) =>
  valkey.set(KEYS.verifiedWatch(channelId, userId), JSON.stringify({ b, s, f: 0 }), "EX", ttl);
const override = (channelId: string, state: "on" | "suppressed", since: Date, ttl = 660) =>
  valkey.set(
    KEYS.surgeOverride(channelId),
    JSON.stringify({
      state,
      since: since.toISOString(),
      until: new Date(Date.now() + 600_000).toISOString(),
      by: null,
    }),
    "EX",
    ttl,
  );

function reader(ttlMs: { verified?: number; override?: number } = {}) {
  return new WatchGate({
    valkey,
    db: t.db,
    limiter: new ValkeyLimiter(valkey),
    metrics: createMetrics(),
    logger: quietLogger,
    enabled: { watchGate: true, surgeGuard: true },
    ttlMs,
  });
}

const state = (c: { id: string; slug: string; broadcastId: string }, settings = {}): ChannelState =>
  channelState(
    { minVerifiedWatchSeconds: 120, surgeGuard: GUARD, ...settings },
    {
      id: c.id,
      slug: c.slug,
      liveBroadcastId: c.broadcastId,
    },
  );

describe("WatchGate reader (real Valkey and Postgres)", () => {
  test("the cached read, then TTL expiry removes the unlock", async () => {
    const c = await liveChannel(t.db);
    const u = await createUser(t.db);
    const g = reader({ verified: 200 });
    await watched(c.id, u.id, c.broadcastId, 150, 1);
    expect((await g.load(state(c), u.id, new Date()))?.verified?.seconds).toBe(150);
    await Bun.sleep(1_300);
    // Still cached for at most the cache's lifetime, then the expired key reads as none.
    await Bun.sleep(250);
    expect((await g.load(state(c), u.id, new Date()))?.verified).toBeNull();
  });

  test("a key for another broadcast is ignored", async () => {
    const c = await liveChannel(t.db);
    const u = await createUser(t.db);
    await watched(c.id, u.id, uuidv7(), 900);
    expect((await reader().load(state(c), u.id, new Date()))?.verified).toBeNull();
  });

  test("the fallback account age comes from integrity.thresholds", async () => {
    const c = await liveChannel(t.db);
    const u = await createUser(t.db);
    const [row] = await t.db
      .select({ value: schema.governanceSettings.value })
      .from(schema.governanceSettings)
      .where(eq(schema.governanceSettings.key, "integrity.thresholds"));
    const expected =
      (row?.value as { gateFallbackAccountAgeDays?: number } | undefined)?.gateFallbackAccountAgeDays ?? 7;
    expect((await reader().load(state(c), u.id, new Date()))?.fallbackAccountAgeDays).toBe(expected);
  });

  test("surge(): on, suppressed, absent, and the flag off", async () => {
    const c = await liveChannel(t.db);
    const ch = state(c);
    const g = reader({ override: 0 });
    expect(await g.surge(ch, new Date())).toEqual({ state: "off", until: null });
    await override(c.id, "on", new Date());
    expect((await g.surge(ch, new Date())).state).toBe("on");
    await override(c.id, "suppressed", new Date());
    expect((await g.surge(ch, new Date())).state).toBe("suppressed");
    const off = new WatchGate({
      valkey,
      db: t.db,
      limiter: new ValkeyLimiter(valkey),
      metrics: createMetrics(),
      logger: quietLogger,
      enabled: { watchGate: true, surgeGuard: false },
    });
    expect(await off.surge(ch, new Date())).toEqual({ state: "off", until: null });
  });

  test("surge exemption: a non-deleted message before the surge began", async () => {
    const c = await liveChannel(t.db, { minVerifiedWatchSeconds: 0, surgeGuard: GUARD });
    const [early, deleted, late, never] = await Promise.all([1, 2, 3, 4].map(() => createUser(t.db)));
    const since = new Date(Date.now() - 60_000);
    const msg = (userId: string, at: Date, deletedAt: Date | null = null) =>
      t.db
        .insert(schema.chatMessages)
        .values({ id: uuidv7(), channelId: c.id, userId, body: "hi", createdAt: at, deletedAt });
    await msg(early!.id, new Date(since.getTime() - 3_600_000));
    await msg(deleted!.id, new Date(since.getTime() - 3_600_000), new Date());
    await msg(late!.id, new Date(since.getTime() + 1_000));
    await override(c.id, "on", since);
    const g = reader();
    const ch = state(c, { minVerifiedWatchSeconds: 0 });
    expect(await g.load(ch, early!.id, new Date())).toMatchObject({ surgeExempt: true, requiredSeconds: 0 });
    for (const u of [deleted!, late!, never!])
      expect(await g.load(ch, u.id, new Date())).toMatchObject({ surgeExempt: false, requiredSeconds: 60 });
  });
});

describe("the gate on the send path (chat instance with both flags on)", () => {
  const connect = async (uid: string) => {
    const cl = await Client.connect(svc, { token: await chatToken(uid) });
    clients.push(cl);
    return cl;
  };

  test("refused with msg_verified_watch until watched; the 7th denial in a minute is msg_ratelimit", async () => {
    const c = await liveChannel(t.db, { minVerifiedWatchSeconds: 60 });
    const viewer = await createUser(t.db);
    const cl = await connect(viewer.id);
    for (let i = 0; i < 6; i++) {
      const r = await cl.say(c.slug, `hi ${i}`);
      expect(r.ack.id).toBeNull();
      expect(r.notice?.code).toBe("msg_verified_watch");
    }
    const seventh = await cl.say(c.slug, "hi 7");
    expect(seventh.notice?.code).toBe("msg_ratelimit");
    // Watching long enough unlocks at once (the pipeline runs before the attempt count).
    await watched(c.id, viewer.id, c.broadcastId, 61);
    await Bun.sleep(5_100);
    const ok = await cl.say(c.slug, "now I can");
    expect(ok.ack.id).not.toBeNull();
  });

  test("the broadcaster and moderators chat without watching", async () => {
    const c = await liveChannel(t.db, { minVerifiedWatchSeconds: 600 });
    const mod = await createUser(t.db);
    await t.db.insert(schema.channelRoles).values({ channelId: c.id, userId: mod.id, role: "moderator" });
    for (const id of [c.owner.id, mod.id]) {
      const r = await (await connect(id)).say(c.slug, "hello");
      expect(r.ack.id).not.toBeNull();
    }
  });

  test("a mid-surge joiner learns the surge from the joined frame", async () => {
    const c = await liveChannel(t.db, { surgeGuard: GUARD });
    await override(c.id, "on", new Date());
    const viewer = await createUser(t.db);
    const joined = await (await connect(viewer.id)).join(c.slug);
    expect(joined.surge.state).toBe("on");
  });
});
