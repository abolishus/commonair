// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `createOrigin`'s wiring with real Postgres and Valkey and no MediaMTX: route dispatch, the
 * trusted-proxy list, the registered routes' refusal metrics, and the issuance timer and its
 * shutdown tick.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { MINUTE_MS } from "../src/accounting.ts";
import { schema, uuidv7, type Executor } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import type { Logger } from "@commonair/observability";
import { createValkey, type ValkeyClient } from "@commonair/service";
import { generateSigningKey } from "@commonair/tokens";
import { noopMetrics, type OriginMetrics } from "../src/metrics.ts";
import { createOrigin, type OriginOptions } from "../src/origin.ts";
import { ISSUANCE_KEYS } from "../src/production.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6379";
let t: TestDatabase;
let pkcs8 = "";
const clients: ValkeyClient[] = [];

/** A Valkey client of its own per origin, so each issuance lock is that test's alone. */
function valkey(): ValkeyClient {
  const v = createValkey(VALKEY_URL, { keyPrefix: `test:${crypto.randomUUID()}:` });
  clients.push(v);
  return v;
}

function recordingLogger() {
  const lines: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const at =
    (level: string) =>
    (msg: string, fields?: Record<string, unknown>): void =>
      void lines.push({ level, msg, fields });
  const logger = {
    trace: at("trace"),
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    fatal: at("fatal"),
    child: () => logger,
  } as unknown as Logger;
  return { logger, lines };
}

const make = (over: Partial<OriginOptions> = {}) =>
  createOrigin({
    db: t.db,
    valkey: valkey(),
    playbackSigningKey: pkcs8,
    // Nothing listens there: these tests never reach MediaMTX.
    mediamtxHlsUrl: "http://127.0.0.1:9",
    internalSecret: "x".repeat(32),
    mediaPassword: "x".repeat(32),
    cacheMb: 8,
    cdn: { provider: "none" },
    segmentStream: `stream:segments:${crypto.randomUUID()}`,
    ...over,
  });

beforeAll(async () => {
  const [db, generated] = await Promise.all([createTestDatabase(), generateSigningKey()]);
  t = db;
  pkcs8 = generated.pkcs8B64;
});

afterAll(async () => {
  await Promise.allSettled(clients.map((c) => c.quit()));
  await t?.drop();
});

describe("route dispatch", () => {
  test("without object storage, /media/ and /vod/ are not routes: the HLS handler's 404", async () => {
    const origin = await make();
    for (const path of ["/media/avatars/a.webp", `/vod/${uuidv7()}/index.m3u8`]) {
      const res = await origin.fetch(new Request(`http://origin.test${path}`));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    await origin.stop();
  });

  test("/p2p-digest/ goes to the digest handler, everything unknown to the HLS handler", async () => {
    const origin = await make();
    const digest = await origin.fetch(new Request("http://origin.test/p2p-digest/live/alice/segment1.m4s"));
    expect(digest.status).toBe(403);
    expect(await digest.json()).toEqual({ error: "forbidden: missing" });
    const hls = await origin.fetch(new Request("http://origin.test/hls/live/alice/index.m3u8"));
    expect(hls.status).toBe(403);
    await hls.body?.cancel();
    expect((await origin.fetch(new Request("http://origin.test/nope"))).status).toBe(404);
    await origin.stop();
  });

  test("a registered route's refusals are counted under its name; its successes are its own to count", async () => {
    const requests: unknown[][] = [];
    const metrics: OriginMetrics = { ...noopMetrics, request: (...args) => void requests.push(args) };
    const origin = await make({ metrics });
    const vod = uuidv7();
    expect((await origin.fetch(new Request(`http://origin.test/dvr/${vod}/index.m3u8`))).status).toBe(404);
    expect(
      (await origin.fetch(new Request(`http://origin.test/dvr/${vod}/index.m3u8`, { method: "OPTIONS" }))).status,
    ).toBe(204);
    expect(requests).toEqual([["dvr", "other", "unauthenticated", 404]]);
    await origin.stop();
  });
});

describe("trusted proxies", () => {
  test("an invalid TRUSTED_PROXY_CIDRS entry is logged and ignored; the valid ones key failures by client", async () => {
    const { logger, lines } = recordingLogger();
    const origin = await make({ trustedProxyCidrs: ["10.0.0.0/8", "bogus"], relayAuthFailuresPerMinute: 2, logger });
    expect(lines.filter((l) => l.level === "warn").map((l) => l.msg)).toEqual([
      "ignoring invalid TRUSTED_PROXY_CIDRS entry",
    ]);
    // The entry itself is never logged: it is operator config, but the rule is no raw values.
    expect(JSON.stringify(lines)).not.toContain("bogus");
    const pull = (client: string, peer: string) =>
      origin.fetch(
        new Request("http://origin.test/relay-pull/live/alice/index.m3u8", {
          headers: { authorization: "Bearer relay_unknown", "x-forwarded-for": client },
        }),
        peer,
      );
    expect((await pull("198.51.100.1", "10.0.0.2")).status).toBe(401);
    expect((await pull("198.51.100.1", "10.0.0.2")).status).toBe(401);
    expect((await pull("198.51.100.1", "10.0.0.2")).status).toBe(429);
    // Another client behind the same proxy has its own budget.
    expect((await pull("198.51.100.2", "10.0.0.2")).status).toBe(401);
    // An untrusted peer is its own key, whatever it forwards.
    expect((await pull("198.51.100.3", "192.0.2.7")).status).toBe(401);
    expect((await pull("198.51.100.4", "192.0.2.7")).status).toBe(401);
    expect((await pull("198.51.100.5", "192.0.2.7")).status).toBe(429);
    await origin.stop();
  });
});

describe("issuance", () => {
  /** One relay session alive in the minute before `now`'s, so a tick has a row to write. */
  async function seedSession(now: number): Promise<{ relayId: string; bucket: number }> {
    const owner = uuidv7();
    const channel = uuidv7();
    const slug = `iss${channel.slice(-8)}`;
    await t.db.insert(schema.users).values({ id: owner, name: slug, email: `${slug}@test.invalid`, username: slug });
    await t.db.insert(schema.channels).values({ id: channel, ownerId: owner, slug, displayName: slug });
    const [relay] = await t.db
      .insert(schema.relayNodes)
      .values({
        ownerId: owner,
        name: slug,
        publicUrl: `http://${slug}.test.invalid`,
        declaredCapacityMbps: 10,
        publicKey: slug,
        tokenHash: `hash-${slug}`,
        status: "active",
      })
      .returning({ id: schema.relayNodes.id });
    const bucket = Math.floor(now / MINUTE_MS) * MINUTE_MS - MINUTE_MS;
    await t.db.insert(schema.playbackSessions).values({
      channelId: channel,
      deviceHash: "d",
      ipHash: "i",
      assignedSource: "relay",
      relayId: relay!.id,
      startedAt: new Date(bucket),
      lastHeartbeatAt: new Date(bucket + 1_000),
    });
    return { relayId: relay!.id, bucket };
  }

  test("concurrent ticks share one run", async () => {
    const origin = await make({ issuance: { enabled: false, lookbackMinutes: 1 } });
    const a = origin.issuanceTick();
    const b = origin.issuanceTick();
    expect(a).toBe(b);
    await a;
    // Once it settles the next call is a new run (refused by the lock the first one kept).
    const c = origin.issuanceTick();
    expect(c).not.toBe(a);
    expect(await c).toBeNull();
    await origin.stop();
  });

  test("a failing tick is logged and answers null; the next tick runs again", async () => {
    const { logger, lines } = recordingLogger();
    let down = true;
    const db = new Proxy(t.db, {
      get: (target, prop, receiver) => {
        if (prop === "select" && down) throw new Error("database down");
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as Executor;
    const origin = await make({ db, logger, issuance: { enabled: false, lookbackMinutes: 1 } });
    expect(await origin.issuanceTick()).toBeNull();
    expect(lines.filter((l) => l.level === "error").map((l) => l.msg)).toEqual(["relay issuance failed"]);
    down = false;
    expect(await origin.issuanceTick()).toEqual([]);
    await origin.stop();
  });

  test("enabled: the timer ticks `grace` after the minute; stop runs one last tick past its own lock", async () => {
    // One millisecond before a minute boundary, so the aligned timer fires at once.
    const boundary = Math.ceil(Date.now() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
    let clock = boundary - 1;
    const v = valkey();
    const origin = await make({
      valkey: v,
      now: () => clock,
      issuance: { enabled: true, graceMs: 0, lookbackMinutes: 1 },
    });
    origin.start();
    await vi.waitFor(async () => expect(await v.exists(ISSUANCE_KEYS.lock)).toBe(1), { timeout: 5_000 });
    const holder = await v.get(ISSUANCE_KEYS.lock);
    // A session that only the minute ending at the next boundary counts, appearing after the timer's tick.
    clock = boundary + 5_000;
    const { relayId, bucket } = await seedSession(clock);
    await origin.stop();
    // The shutdown tick ran under the same runner and wrote the minute.
    expect(await v.get(ISSUANCE_KEYS.lock)).toBe(holder);
    const rows = await t.db.select().from(schema.relayIssuance);
    expect(rows.filter((r) => r.relayId === relayId)).toMatchObject([{ bucketStart: new Date(bucket), sessions: 1 }]);
  });

  test("disabled: start sets no timer and stop runs no tick", async () => {
    const v = valkey();
    const origin = await make({ valkey: v, issuance: { enabled: false } });
    origin.start();
    await new Promise((r) => setTimeout(r, 50));
    await origin.stop();
    expect(await v.exists(ISSUANCE_KEYS.lock)).toBe(0);
  });
});
