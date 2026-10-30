// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The verified-watch writer against real Postgres (as the application role) and Valkey (ADR 0015
 * decisions 1–5): which channels, which sessions, the cap at 5, exempt roles, the key and its TTL.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { KEYS, VerifiedWatchValue } from "@commonair/contracts/internal";
import { ChannelChatSettings } from "@commonair/contracts/shapes";
import { schema as s, uuidv7, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createValkey } from "@commonair/service";
import type { ChatGateConfig } from "../src/chat-gate/config.ts";
import { verifiedWatchJitter } from "../src/chat-gate/unlocks.ts";
import type { WorkerContext } from "../src/context.ts";
import { writeVerifiedWatch } from "../src/integrity/verified-watch.ts";
import { quietLogger, VALKEY_URL } from "./fixtures.ts";

const SECRET = "verified-watch-test-secret-0123456789abcdef";
const ON: ChatGateConfig = { watchGate: true, surgeGuard: true, secret: SECRET };
const valkey = createValkey(VALKEY_URL, { keyPrefix: `test:vw:${crypto.randomUUID()}:`, name: "worker-test-vw" });
let t: TestDatabase;
let owner: Database;
let ctx: WorkerContext;

beforeAll(async () => {
  t = await createTestDatabase();
  owner = t.db;
  ctx = { db: t.app.db, valkey, logger: quietLogger, now: () => new Date() } as unknown as WorkerContext;
}, 180_000);
afterAll(async () => {
  await valkey.quit();
  await t?.drop();
});

let seq = 0;
const tag = () => `${++seq}${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

async function user(opts: { bot?: boolean; botVerified?: boolean } = {}): Promise<string> {
  const name = `vw${tag()}`;
  const [u] = await owner
    .insert(s.users)
    .values({
      name,
      username: name,
      email: `${name}@example.test`,
      accountType: opts.bot ? "bot" : "human",
      botVerified: opts.botVerified ?? false,
    })
    .returning({ id: s.users.id });
  if (!u) throw new Error("no user");
  return u.id;
}

async function liveChannel(settings: Partial<ChannelChatSettings> = { minVerifiedWatchSeconds: 60 }) {
  const ownerId = await user();
  const slug = `ch${tag()}`;
  const [c] = await owner
    .insert(s.channels)
    .values({ ownerId, slug, displayName: slug, chatSettings: ChannelChatSettings.parse(settings) })
    .returning({ id: s.channels.id });
  if (!c) throw new Error("no channel");
  const broadcastId = uuidv7();
  await owner
    .insert(s.broadcasts)
    .values({ id: broadcastId, channelId: c.id, ingestProtocol: "rtmp", path: `live/${slug}`, startedAt: new Date() });
  await owner.update(s.channels).set({ liveBroadcastId: broadcastId }).where(eq(s.channels.id, c.id));
  return { id: c.id, ownerId, broadcastId };
}

async function session(
  ch: { id: string; broadcastId: string },
  userId: string | null,
  watchSeconds: number,
  opts: {
    reasons?: string[];
    verdict?: "verified" | "pending";
    ip?: string;
    datacenter?: string;
    startedAt?: Date;
  } = {},
) {
  await owner.insert(s.playbackSessions).values({
    id: uuidv7(),
    channelId: ch.id,
    broadcastId: ch.broadcastId,
    userId,
    deviceHash: `dev-${tag()}`,
    ipHash: opts.ip ?? `ip-${tag()}`,
    datacenter: opts.datacenter ?? null,
    watchSeconds,
    verdict: opts.verdict ?? "verified",
    verdictReasons: opts.reasons ?? [],
    scoredAt: new Date(),
    startedAt: opts.startedAt ?? new Date(),
  });
}

const read = async (channelId: string, userId: string) => {
  const raw = await valkey.get(KEYS.verifiedWatch(channelId, userId));
  return raw === null ? null : VerifiedWatchValue.parse(JSON.parse(raw));
};

describe("writeVerifiedWatch", () => {
  test("one key per gate-eligible signed-in viewer: summed seconds minus jitter, TTL 600", async () => {
    const ch = await liveChannel();
    const v = await user();
    await session(ch, v, 100);
    await session(ch, v, 50);
    await session(ch, null, 900);
    const r = await writeVerifiedWatch(ctx, ON);
    expect(r.keys).toBeGreaterThanOrEqual(1);
    expect(await read(ch.id, v)).toEqual({
      b: ch.broadcastId,
      s: 150 - verifiedWatchJitter(SECRET, ch.broadcastId, v),
      f: 0,
    });
    const ttl = await valkey.ttl(KEYS.verifiedWatch(ch.id, v));
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  test("a fetch_unjudged session writes nothing; nor does a pending or unscored one", async () => {
    const ch = await liveChannel();
    const [cdn, pending] = [await user(), await user()];
    await session(ch, cdn, 900, { reasons: ["fetch_unjudged"] });
    await session(ch, pending, 900, { verdict: "pending" });
    await writeVerifiedWatch(ctx, ON);
    expect(await read(ch.id, cdn)).toBeNull();
    expect(await read(ch.id, pending)).toBeNull();
  });

  test("the cap at 5: six users on one ip_hash, the last to arrive gets no key", async () => {
    const ch = await liveChannel();
    const users = [];
    for (let i = 0; i < 6; i++) {
      const u = await user();
      users.push(u);
      await session(ch, u, 300, { ip: "shared-ip", startedAt: new Date(Date.now() - (60 - i) * 1_000) });
    }
    await writeVerifiedWatch(ctx, ON);
    const got = await Promise.all(users.map((u) => read(ch.id, u)));
    expect(got.slice(0, 5).every((v) => v !== null)).toBe(true);
    expect(got[5]).toBeNull();
  });

  test("privacy-relay viewers are uncapped and marked f: 1", async () => {
    const ch = await liveChannel();
    const users = [];
    for (let i = 0; i < 7; i++) {
      const u = await user();
      users.push(u);
      await session(ch, u, 300, { ip: "relay-ip", datacenter: "privacy_relay:icloud" });
    }
    await writeVerifiedWatch(ctx, ON);
    for (const u of users) expect((await read(ch.id, u))?.f).toBe(1);
  });

  test("exempt roles get no key and do not count toward the cap", async () => {
    const ch = await liveChannel();
    const [mod, vip, bot] = [await user(), await user(), await user({ bot: true, botVerified: true })];
    await owner.insert(s.channelRoles).values([
      { channelId: ch.id, userId: mod, role: "moderator" },
      { channelId: ch.id, userId: vip, role: "vip" },
    ]);
    const early = new Date(Date.now() - 600_000);
    for (const u of [ch.ownerId, mod, vip, bot]) await session(ch, u, 300, { ip: "home", startedAt: early });
    const viewers = [];
    for (let i = 0; i < 5; i++) {
      const u = await user();
      viewers.push(u);
      await session(ch, u, 300, { ip: "home" });
    }
    await writeVerifiedWatch(ctx, ON);
    for (const u of [ch.ownerId, mod, vip, bot]) expect(await read(ch.id, u)).toBeNull();
    for (const u of viewers) expect(await read(ch.id, u)).not.toBeNull();
  });

  test("channels: the gate only while CHAT_WATCH_GATE is on, the guard only while CHAT_SURGE_GUARD is on", async () => {
    const gated = await liveChannel({ minVerifiedWatchSeconds: 60 });
    const guarded = await liveChannel({
      minVerifiedWatchSeconds: 0,
      surgeGuard: { enabled: true, triggerUnverifiedRatio: 0.5, cooldownMinutes: 10 },
    });
    const neither = await liveChannel({ minVerifiedWatchSeconds: 0 });
    const [a, b, c] = [await user(), await user(), await user()];
    await session(gated, a, 300);
    await session(guarded, b, 300);
    await session(neither, c, 300);

    await writeVerifiedWatch(ctx, { ...ON, watchGate: false, surgeGuard: false });
    expect(await read(gated.id, a)).toBeNull();
    await writeVerifiedWatch(ctx, { ...ON, surgeGuard: false });
    expect(await read(gated.id, a)).not.toBeNull();
    expect(await read(guarded.id, b)).toBeNull();
    await writeVerifiedWatch(ctx, { ...ON, watchGate: false });
    expect(await read(guarded.id, b)).not.toBeNull();
    await writeVerifiedWatch(ctx, ON);
    expect(await read(neither.id, c)).toBeNull();
  });

  test("sessions of an earlier broadcast do not count", async () => {
    const ch = await liveChannel();
    const v = await user();
    const old = uuidv7();
    await owner.insert(s.broadcasts).values({
      id: old,
      channelId: ch.id,
      ingestProtocol: "rtmp",
      path: `live/old-${tag()}`,
      startedAt: new Date(Date.now() - 86_400_000),
      endedAt: new Date(Date.now() - 80_000_000),
    });
    await session({ id: ch.id, broadcastId: old }, v, 3600);
    await writeVerifiedWatch(ctx, ON);
    expect(await read(ch.id, v)).toBeNull();
  });
});
