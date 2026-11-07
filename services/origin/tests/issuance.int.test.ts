// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Relay issuance against real Postgres and Valkey: which sessions a minute counts, the live and
 * DVR allowances it multiplies, the idempotent upsert, and the leader lock.
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { vodPrefix } from "@commonair/contracts/storage";
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createValkey, type ValkeyClient } from "@commonair/service";
import { MINUTE_MS } from "../src/accounting.ts";
import { DvrPullStore } from "../src/dvr-issuance.ts";
import {
  dvrAllowances,
  IssuanceRunner,
  relaySessionCounts,
  runIssuance,
  sessionAllowance,
  upsertIssuance,
} from "../src/issuance.ts";
import { ISSUANCE_KEYS, ProductionStore } from "../src/production.ts";
import { probeProductionMinute } from "./production-probe.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6379";
let t: TestDatabase;
let valkey: ValkeyClient;
let production: ProductionStore;
let pulls: DvrPullStore;

/** Each test its own minute, far from now, so recorded production never mixes. */
let minuteN = 0;
const nextMinute = () => Date.UTC(2026, 0, 1, 0, 0) + 10 * MINUTE_MS * ++minuteN;

const ids = { owner: uuidv7(), channel: uuidv7(), r1: "", r2: "" };

async function relay(name: string): Promise<string> {
  const [row] = await t.db
    .insert(schema.relayNodes)
    .values({
      ownerId: ids.owner,
      name,
      publicUrl: `http://${name}.test.invalid`,
      declaredCapacityMbps: 100,
      publicKey: name,
      tokenHash: `hash-${name}-${uuidv7()}`,
      status: "active",
    })
    .returning({ id: schema.relayNodes.id });
  return row!.id;
}

/** A broadcast on the test channel at `live/<slug>`, with `vods` recordings. */
async function broadcast(vods = 0): Promise<{ id: string; path: string; vods: string[] }> {
  const id = uuidv7();
  const path = `live/b${id.slice(-8)}`;
  await t.db.insert(schema.broadcasts).values({ id, channelId: ids.channel, ingestProtocol: "rtmp", path });
  const vodIds = Array.from({ length: vods }, () => uuidv7());
  for (const v of vodIds)
    await t.db.insert(schema.vods).values({
      id: v,
      channelId: ids.channel,
      broadcastId: id,
      title: "rec",
      storagePrefix: vodPrefix(v, "private"),
    });
  return { id, path, vods: vodIds };
}

type SessionRow = typeof schema.playbackSessions.$inferInsert;
const session = (over: Partial<SessionRow>): SessionRow => ({
  channelId: ids.channel,
  deviceHash: "d",
  ipHash: "i",
  assignedSource: "relay",
  ...over,
});

beforeAll(async () => {
  t = await createTestDatabase();
  valkey = createValkey(VALKEY_URL, { keyPrefix: `test:${crypto.randomUUID()}:` });
  production = new ProductionStore({ valkey });
  pulls = new DvrPullStore({ valkey, windowSeconds: 600 });
  await t.db.insert(schema.users).values({ id: ids.owner, name: "o", email: "o@test.invalid", username: "issuer" });
  await t.db
    .insert(schema.channels)
    .values({ id: ids.channel, ownerId: ids.owner, slug: "issuer", displayName: "issuer" });
  ids.r1 = await relay("r1");
  ids.r2 = await relay("r2");
});

afterAll(async () => {
  await valkey?.quit();
  await t?.drop();
});

describe("relaySessionCounts", () => {
  test("relay sessions alive in the minute, by relay and broadcast; DVR by mode or credited seconds", async () => {
    const S = nextMinute();
    const at = (ms: number) => new Date(S + ms);
    const b = await broadcast();
    await t.db.insert(schema.playbackSessions).values([
      // Counted for r1/b: live, rewinding, and once rewound (credited DVR seconds).
      session({ relayId: ids.r1, broadcastId: b.id, startedAt: at(-300_000), lastHeartbeatAt: at(10_000) }),
      session({ relayId: ids.r1, broadcastId: b.id, startedAt: at(0), lastHeartbeatAt: at(0), playbackMode: "dvr" }),
      session({ relayId: ids.r1, broadcastId: b.id, startedAt: at(-1), lastHeartbeatAt: at(59_999), dvrSeconds: 4 }),
      // Counted for r2/b: ended inside the minute.
      session({
        relayId: ids.r2,
        broadcastId: b.id,
        startedAt: at(-60_000),
        lastHeartbeatAt: at(1_000),
        endedAt: at(5_000),
      }),
      // Counted for r2 with no broadcast.
      session({ relayId: ids.r2, startedAt: at(-60_000), lastHeartbeatAt: at(30_000) }),
      // Not counted: served by the origin, last heard before the minute, started at its end,
      // ended before it, never heard from, and a relay session with no relay.
      session({ assignedSource: "origin", broadcastId: b.id, startedAt: at(0), lastHeartbeatAt: at(1_000) }),
      session({ relayId: ids.r2, broadcastId: b.id, startedAt: at(-120_000), lastHeartbeatAt: at(-1) }),
      session({ relayId: ids.r2, broadcastId: b.id, startedAt: at(60_000), lastHeartbeatAt: at(60_000) }),
      session({
        relayId: ids.r2,
        broadcastId: b.id,
        startedAt: at(-120_000),
        lastHeartbeatAt: at(10_000),
        endedAt: at(-1),
      }),
      session({ relayId: ids.r1, broadcastId: b.id, startedAt: at(0), lastHeartbeatAt: null }),
      session({ relayId: null, broadcastId: b.id, startedAt: at(0), lastHeartbeatAt: at(1_000) }),
    ]);
    const counts = await relaySessionCounts(t.db, at(0), at(MINUTE_MS));
    const key = (c: { relayId: string; broadcastId: string | null }) => `${c.relayId}/${c.broadcastId}`;
    expect(counts.sort((x, y) => key(x).localeCompare(key(y)))).toEqual(
      [
        { relayId: ids.r1, broadcastId: b.id, path: b.path, sessions: 3, dvrSessions: 2 },
        { relayId: ids.r2, broadcastId: b.id, path: b.path, sessions: 1, dvrSessions: 0 },
        { relayId: ids.r2, broadcastId: null, path: null, sessions: 1, dvrSessions: 0 },
      ].sort((x, y) => key(x).localeCompare(key(y))),
    );
    // A minute nobody watched.
    expect(await relaySessionCounts(t.db, at(-10 * MINUTE_MS), at(-9 * MINUTE_MS))).toEqual([]);
  });

  test("a session moved to the origin counts for the minutes it was on the relay, not after", async () => {
    const S = nextMinute();
    const at = (ms: number) => new Date(S + ms);
    const b = await broadcast();
    // Moved off r1 during the minute (the relay drained): counted in it and before, not after.
    // Moved in the minute before: not counted. Moved at the minute's first instant: counted.
    await t.db.insert(schema.playbackSessions).values([
      session({
        assignedSource: "origin",
        relayId: ids.r1,
        relayLeftAt: at(20_000),
        broadcastId: b.id,
        startedAt: at(-5 * MINUTE_MS),
        lastHeartbeatAt: at(MINUTE_MS + 30_000),
      }),
      session({
        assignedSource: "origin",
        relayId: ids.r1,
        relayLeftAt: at(-1),
        broadcastId: b.id,
        startedAt: at(-5 * MINUTE_MS),
        lastHeartbeatAt: at(30_000),
      }),
      session({
        assignedSource: "origin",
        relayId: ids.r2,
        relayLeftAt: at(0),
        broadcastId: b.id,
        startedAt: at(-5 * MINUTE_MS),
        lastHeartbeatAt: at(30_000),
      }),
    ]);
    const counts = await relaySessionCounts(t.db, at(0), at(MINUTE_MS));
    expect(counts.sort((x, y) => x.relayId.localeCompare(y.relayId))).toEqual(
      [
        { relayId: ids.r1, broadcastId: b.id, path: b.path, sessions: 1, dvrSessions: 0 },
        { relayId: ids.r2, broadcastId: b.id, path: b.path, sessions: 1, dvrSessions: 0 },
      ].sort((x, y) => x.relayId.localeCompare(y.relayId)),
    );
    expect(await relaySessionCounts(t.db, at(-MINUTE_MS), at(0))).toMatchObject(
      [
        { relayId: ids.r1, sessions: 2 },
        { relayId: ids.r2, sessions: 1 },
      ].sort((x, y) => x.relayId.localeCompare(y.relayId)),
    );
    expect(await relaySessionCounts(t.db, at(MINUTE_MS), at(2 * MINUTE_MS))).toEqual([]);
  });
});

describe("runIssuance", () => {
  test("sessions × the minute's production, upserted: a recompute replaces the row", async () => {
    const S = nextMinute();
    const b = await broadcast();
    const [s1] = await t.db
      .insert(schema.playbackSessions)
      .values([
        session({ relayId: ids.r1, broadcastId: b.id, startedAt: new Date(S), lastHeartbeatAt: new Date(S + 5_000) }),
        session({ relayId: ids.r1, broadcastId: b.id, startedAt: new Date(S), lastHeartbeatAt: new Date(S + 5_000) }),
      ])
      .returning({ id: schema.playbackSessions.id });
    production.record(b.path, `seg-${S}-1.mp4`, "segment", 1_000, S + 1_000);
    production.record(b.path, `seg-${S}-2.mp4`, "segment", 2_000, S + 2_000);
    production.record(b.path, `r0-${S}_init.mp4`, "segment", 50, S + 2_000);
    // A rendition directory of the same channel counts toward the same path.
    production.record(`${b.path}/480p`, `seg-${S}-1.mp4`, "segment", 500, S + 1_000);
    await production.flush();
    const minute = await production.read(S);
    const each = sessionAllowance(minute.get(b.path));
    expect(each).toEqual({ segments: 3, bytes: 3_050 });

    const rows = await runIssuance(t.db, production, S, pulls);
    expect(rows).toEqual([
      { relayId: ids.r1, bucketStart: new Date(S), sessions: 2, segmentTokens: 6, bytesIssued: 6_100 },
    ]);
    const stored = () =>
      t.db
        .select()
        .from(schema.relayIssuance)
        .where(and(eq(schema.relayIssuance.relayId, ids.r1), eq(schema.relayIssuance.bucketStart, new Date(S))));
    expect(await stored()).toMatchObject([{ sessions: 2, segmentTokens: 6, bytesIssued: 6_100 }]);

    // One session left before the minute (a late heartbeat sweep): the recompute replaces the row.
    await t.db
      .update(schema.playbackSessions)
      .set({ lastHeartbeatAt: new Date(S - 1) })
      .where(eq(schema.playbackSessions.id, s1!.id));
    expect(await runIssuance(t.db, production, S, pulls)).toMatchObject([{ sessions: 1, segmentTokens: 3 }]);
    expect(await stored()).toMatchObject([{ sessions: 1, segmentTokens: 3, bytesIssued: 3_050 }]);
  });

  test("a recompute after the relay's sessions moved to the origin keeps the minutes they spent on it", async () => {
    // e2e-relay CI run 42333642371: the relay drained, some of its sessions had moved when the
    // tick recomputed the last 5 minutes, and those minutes' issuance shrank under its receipts.
    const S = nextMinute();
    const b = await broadcast();
    const [s1] = await t.db
      .insert(schema.playbackSessions)
      .values([
        session({ relayId: ids.r1, broadcastId: b.id, startedAt: new Date(S), lastHeartbeatAt: new Date(S + 5_000) }),
        session({ relayId: ids.r1, broadcastId: b.id, startedAt: new Date(S), lastHeartbeatAt: new Date(S + 5_000) }),
      ])
      .returning({ id: schema.playbackSessions.id });
    production.record(b.path, `seg-${S}-1.mp4`, "segment", 1_000, S + 1_000);
    await production.flush();
    expect(await runIssuance(t.db, production, S, pulls)).toMatchObject([{ relayId: ids.r1, sessions: 2 }]);
    // Two minutes later the relay leaves the active set and one session's heartbeat moves it.
    await t.db
      .update(schema.playbackSessions)
      .set({
        assignedSource: "origin",
        relayLeftAt: new Date(S + 2 * MINUTE_MS),
        lastHeartbeatAt: new Date(S + 2 * MINUTE_MS),
      })
      .where(eq(schema.playbackSessions.id, s1!.id));
    expect(await runIssuance(t.db, production, S, pulls)).toMatchObject([
      { relayId: ids.r1, sessions: 2, bytesIssued: 2_000 },
    ]);
  });

  test("the origin.int probe: a minute boundary during the pull still issues for the stamped sessions", async () => {
    // origin.int CI run 41834516797: the heartbeat was stamped at the end of one minute and the
    // pull's production landed in the next, which the probe chose; the issuance came out empty.
    const S = nextMinute();
    const b = await broadcast();
    const rows = await t.db
      .insert(schema.playbackSessions)
      .values([
        session({ relayId: ids.r1, broadcastId: b.id, startedAt: new Date(S - MINUTE_MS) }),
        session({ relayId: ids.r1, broadcastId: b.id, startedAt: new Date(S - MINUTE_MS) }),
      ])
      .returning({ id: schema.playbackSessions.id });
    const mine = inArray(
      schema.playbackSessions.id,
      rows.map((r) => r.id),
    );
    // Every attempt starts 20 ms before a boundary and pulls 30 ms after it.
    let now = S - 20;
    let n = 0;
    let bucket: number | undefined;
    for (let attempt = 0; attempt < 3 && bucket === undefined; attempt++) {
      bucket = await probeProductionMinute({
        now: () => now,
        stamp: async (at) => {
          await t.db.update(schema.playbackSessions).set({ lastHeartbeatAt: at }).where(mine);
        },
        pull: async () => {
          now += 50;
          production.record(b.path, `seg-${S}-${++n}.mp4`, "segment", 1_000, now);
          await production.flush();
        },
        produced: async (m) => sessionAllowance((await production.read(m)).get(b.path)).segments > 0,
      });
      if (bucket === undefined) now = S + MINUTE_MS * (attempt + 1) - 20;
    }
    expect(bucket).toBe(S);
    expect(await runIssuance(t.db, production, S, pulls)).toEqual([
      { relayId: ids.r1, bucketStart: new Date(S), sessions: 2, segmentTokens: 2, bytesIssued: 2_000 },
    ]);
  });

  test("a minute without relay sessions writes nothing", async () => {
    const S = nextMinute();
    const before = await t.db.select().from(schema.relayIssuance);
    expect(await runIssuance(t.db, production, S, pulls)).toEqual([]);
    expect(await t.db.select().from(schema.relayIssuance)).toEqual(before);
    await upsertIssuance(t.db, []);
    expect(await t.db.select().from(schema.relayIssuance)).toEqual(before);
  });

  test("DVR sessions: the larger of live and the pulls; without a pull store, live only", async () => {
    const S = nextMinute();
    const b = await broadcast(1);
    await t.db.insert(schema.playbackSessions).values(
      session({
        relayId: ids.r2,
        broadcastId: b.id,
        startedAt: new Date(S),
        lastHeartbeatAt: new Date(S + 1_000),
        playbackMode: "dvr",
      }),
    );
    production.record(b.path, `seg-${S}-live.mp4`, "segment", 100, S + 1_000);
    for (let i = 0; i < 3; i++)
      pulls.record(b.vods[0]!, { file: `r1_${i}.m4s`, bytes: 1_000, durationMs: 4_000 }, S - 30_000);
    await Promise.all([production.flush(), pulls.flush()]);
    expect(await runIssuance(t.db, production, S, pulls)).toMatchObject([
      { relayId: ids.r2, sessions: 1, segmentTokens: 3, bytesIssued: 3_000 },
    ]);
    expect(await runIssuance(t.db, production, S)).toMatchObject([
      { relayId: ids.r2, sessions: 1, segmentTokens: 1, bytesIssued: 100 },
    ]);
  });
});

describe("dvrAllowances", () => {
  test("a split recording: per field, the larger of its VODs' allowances", async () => {
    const S = nextMinute();
    const b = await broadcast(2);
    const [v1, v2] = b.vods as [string, string];
    // v1: two small segments; v2: one big one. Segments from v1, bytes from v2.
    pulls.record(v1, { file: "a.m4s", bytes: 10, durationMs: 4_000 }, S);
    pulls.record(v1, { file: "b.m4s", bytes: 10, durationMs: 4_000 }, S);
    pulls.record(v2, { file: "c.m4s", bytes: 500, durationMs: 4_000 }, S);
    await pulls.flush();
    const lonely = await broadcast(0);
    const out = await dvrAllowances(t.db, pulls, [b.id, lonely.id], new Date(S), new Date(S + MINUTE_MS));
    expect(out).toEqual(new Map([[b.id, { segments: 2, bytes: 500 }]]));
    // Pulled more than window + slack before the minute: not servable in it.
    const late = S + pulls.lookbackMs + MINUTE_MS;
    expect(await dvrAllowances(t.db, pulls, [b.id], new Date(late), new Date(late + MINUTE_MS))).toEqual(
      new Map([[b.id, { segments: 0, bytes: 0 }]]),
    );
  });

  test("no rewound broadcasts: no query, an empty map", async () => {
    const db = new Proxy(t.db, {
      get: () => {
        throw new Error("queried");
      },
    });
    expect(await dvrAllowances(db, pulls, [], new Date(0), new Date(MINUTE_MS))).toEqual(new Map());
  });
});

describe("IssuanceRunner with Valkey", () => {
  test("defaults: the last five closed minutes under a 50 s lock the winner keeps", async () => {
    const S = nextMinute();
    const b = await broadcast();
    await t.db.insert(schema.playbackSessions).values(
      // Alive in the third of the five minutes only.
      session({
        relayId: ids.r1,
        broadcastId: b.id,
        startedAt: new Date(S + 2 * MINUTE_MS),
        lastHeartbeatAt: new Date(S + 2 * MINUTE_MS + 1),
        endedAt: new Date(S + 2 * MINUTE_MS + 2),
      }),
    );
    const now = () => S + 5 * MINUTE_MS + 10_000;
    const a = new IssuanceRunner({ db: t.db, valkey, production, dvrPulls: pulls, now });
    const rows = await a.tick();
    expect(rows?.map((r) => [r.relayId, r.bucketStart.getTime(), r.sessions])).toEqual([
      [ids.r1, S + 2 * MINUTE_MS, 1],
    ]);
    const ttl = await valkey.pttl(ISSUANCE_KEYS.lock);
    expect(ttl).toBeGreaterThan(40_000);
    expect(ttl).toBeLessThanOrEqual(50_000);
    expect(await new IssuanceRunner({ db: t.db, valkey, production, now }).tick()).toBeNull();
    await valkey.del(ISSUANCE_KEYS.lock);
  });

  test("a failed tick releases the lock at once", async () => {
    const broken = new Proxy(t.db, {
      get: (target, prop, receiver) => {
        if (prop === "select") throw new Error("database down");
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const runner = new IssuanceRunner({ db: broken, valkey, production, lookbackMinutes: 1 });
    await expect(runner.tick()).rejects.toThrow("database down");
    expect(await valkey.exists(ISSUANCE_KEYS.lock)).toBe(0);
  });
});
