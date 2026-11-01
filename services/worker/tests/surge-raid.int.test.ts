// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Surge raids against real Postgres (application role) and Valkey (batch 7 decision (w), ADR 0039
 * §4): a raid from verified viewers opens the target's surge and its raiders pass the chat gate's
 * key reads at once while a fresh account does not; a botted raid opens the surge and carries
 * nothing; the surge ends after `RAID_RULES.surgeMinutes` with its outbox and audit rows; an open
 * surge is extended, never shortened; a moderator's suppression wins; the guard, "Protect raids" or
 * the instance flag off, a suspended side, open nothing.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { RAID_RULES } from "@commonair/contracts/enums";
import { BUS } from "@commonair/contracts/events";
import { KEYS, SurgeOverride, VerifiedWatchValue } from "@commonair/contracts/internal";
import { ChannelChatSettings } from "@commonair/contracts/shapes";
import { schema as s, uuidv7, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { loadThresholds } from "@commonair/integrity";
import { surgeRaidOf } from "@commonair/interact";
import { createValkey } from "@commonair/service";
import type { ChatGateConfig } from "../src/chat-gate/config.ts";
import { surgeOpenKey } from "../src/chat-gate/state.ts";
import { runSurgeGuard } from "../src/chat-gate/surge.ts";
import type { WorkerContext } from "../src/context.ts";
import { verifiedWatchMergeArgs } from "../src/integrity/verified-watch.ts";
import { executeDueRaids } from "../src/interact/raids/execute.ts";
import { quietLogger, VALKEY_URL, waitFor } from "./fixtures.ts";

const SECRET = "surge-raid-test-secret-0123456789abcdef";
const ON: ChatGateConfig = { watchGate: true, surgeGuard: true, giveaways: false, secret: SECRET };
const valkey = createValkey(VALKEY_URL, { keyPrefix: `test:sr:${crypto.randomUUID()}:`, name: "worker-test-sr" });
const sub = createValkey(VALKEY_URL, { name: "worker-test-sr-sub" });
let t: TestDatabase;
let owner: Database;
let clock = new Date();
let ctx: WorkerContext;
const frames: { channel: string; frame: Record<string, unknown> }[] = [];

beforeAll(async () => {
  t = await createTestDatabase();
  owner = t.db;
  ctx = { db: t.app.db, valkey, logger: quietLogger, now: () => clock } as unknown as WorkerContext;
  await sub.psubscribe("chat-control:*");
  sub.on("pmessage", (_p, channel, message) => frames.push({ channel, frame: JSON.parse(message) }));
}, 180_000);
afterAll(async () => {
  await Promise.allSettled([valkey.quit(), sub.quit()]);
  await t?.drop();
});

let seq = 0;
const tag = () => `${++seq}${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

async function user(extra: { accountType?: "human" | "bot"; botVerified?: boolean } = {}): Promise<string> {
  const name = `sr${tag()}`;
  const [u] = await owner
    .insert(s.users)
    .values({ name, username: name, email: `${name}@example.test`, ...extra })
    .returning({ id: s.users.id });
  if (!u) throw new Error("no user");
  return u.id;
}

interface Chan {
  id: string;
  slug: string;
  broadcastId: string;
  ownerId: string;
}

async function liveChannel(
  surgeGuard: Partial<ChannelChatSettings["surgeGuard"]> = {},
  minVerifiedWatchSeconds = 0,
): Promise<Chan> {
  const ownerId = await user();
  const slug = `ch${tag()}`;
  const settings = ChannelChatSettings.parse({
    minVerifiedWatchSeconds,
    surgeGuard: { enabled: false, triggerUnverifiedRatio: 0.5, cooldownMinutes: 10, onRaid: true, ...surgeGuard },
  });
  const [c] = await owner
    .insert(s.channels)
    .values({ ownerId, slug, displayName: slug, chatSettings: settings })
    .returning({ id: s.channels.id });
  if (!c) throw new Error("no channel");
  const broadcastId = uuidv7();
  await owner.insert(s.broadcasts).values({
    id: broadcastId,
    channelId: c.id,
    ingestProtocol: "rtmp",
    path: `live/${slug}`,
    startedAt: new Date(clock.getTime() - 3_600_000),
  });
  await owner.update(s.channels).set({ liveBroadcastId: broadcastId }).where(eq(s.channels.id, c.id));
  return { id: c.id, slug, broadcastId, ownerId };
}

const protectedTarget = (minVerifiedWatchSeconds = 0) =>
  liveChannel({ enabled: true, onRaid: true }, minVerifiedWatchSeconds);

interface SessionOpts {
  agoSeconds?: number;
  ip?: string;
  watchSeconds?: number;
  startedAgoSeconds?: number;
}

/** One playback session of `userId` on `ch` (gate-eligible when `verified`), seen `agoSeconds` before the clock. */
async function session(ch: Chan, userId: string, verified: boolean, opts: SessionOpts = {}) {
  await owner.insert(s.playbackSessions).values({
    id: uuidv7(),
    channelId: ch.id,
    broadcastId: ch.broadcastId,
    userId,
    deviceHash: `dev-${tag()}`,
    ipHash: opts.ip ?? `ip-${tag()}`,
    startedAt: new Date(clock.getTime() - (opts.startedAgoSeconds ?? 900) * 1000),
    lastHeartbeatAt: new Date(clock.getTime() - (opts.agoSeconds ?? 5) * 1000),
    watchSeconds: opts.watchSeconds ?? 600,
    verdict: verified ? "verified" : "excluded",
    verdictReasons: verified ? [] : ["fetch_less"],
    scoredAt: new Date(clock.getTime() - 10_000),
  });
}

/** A signed-in viewer watching `ch` (gate-eligible when `verified`), seen `agoSeconds` before the clock. */
async function watcher(ch: Chan, verified: boolean, opts: SessionOpts = {}) {
  const userId = await user();
  await session(ch, userId, verified, opts);
  return userId;
}

/** A carried value: the target's broadcast, the source's seconds (600 minus the 0–30 s jitter), `f: 0`. */
function expectCarried(v: VerifiedWatchValue | null, ch: Chan, sourceSeconds = 600) {
  expect(v).not.toBeNull();
  expect(v).toMatchObject({ b: ch.broadcastId, f: 0 });
  expect(v?.s).toBeLessThanOrEqual(sourceSeconds);
  expect(v?.s).toBeGreaterThanOrEqual(Math.max(0, sourceSeconds - 30));
}

async function raid(from: Chan, to: Chan): Promise<string> {
  const [r] = await owner
    .insert(s.raids)
    .values({
      fromChannelId: from.id,
      toChannelId: to.id,
      status: "pending",
      createdAt: new Date(clock.getTime() - 31_000),
      executeAt: new Date(clock.getTime() - 1_000),
    })
    .returning({ id: s.raids.id });
  if (!r) throw new Error("no raid");
  return r.id;
}

const rawOverride = (channelId: string) => valkey.get(KEYS.surgeOverride(channelId));
const override = async (channelId: string) => {
  const raw = await rawOverride(channelId);
  return raw === null ? null : SurgeOverride.parse(JSON.parse(raw));
};
const verified = async (channelId: string, userId: string) => {
  const raw = await valkey.get(KEYS.verifiedWatch(channelId, userId));
  return raw === null ? null : VerifiedWatchValue.parse(JSON.parse(raw));
};

/**
 * The chat gate's decision from its key reads (services/chat/src/watch-gate.ts `load` and
 * rules.ts), for a sender who never chatted on the channel: surge mode raises the gate to
 * max(own, 60) and a value counts only for the live broadcast.
 */
async function gatePasses(ch: Chan, userId: string, own = 0): Promise<boolean> {
  const o = await override(ch.id);
  const required = Math.max(own, o?.state === "on" ? 60 : 0);
  if (required === 0) return true;
  const v = await verified(ch.id, userId);
  return v !== null && v.b === ch.broadcastId && v.s >= required;
}

const rows = (channelId: string) =>
  Promise.all([
    owner
      .select({ type: s.events.type, payload: s.events.payload })
      .from(s.events)
      .where(and(eq(s.events.channelId, channelId))),
    owner
      .select({ action: s.auditLog.action, details: s.auditLog.details })
      .from(s.auditLog)
      .where(and(eq(s.auditLog.channelId, channelId), eq(s.auditLog.subjectType, "channel"))),
  ]);
const surgeEvents = async (channelId: string) =>
  (await rows(channelId))[0].filter((e) => e.type.startsWith("chat.surge."));

describe("a raid into a protected channel", () => {
  test("from verified viewers: surge on for surgeMinutes, the raiders chat at once, a fresh account cannot", async () => {
    clock = new Date();
    const [src, dst] = [await liveChannel(), await protectedTarget()];
    const raiders = [await watcher(src, true), await watcher(src, true), await watcher(src, true)];
    const fresh = await user();
    const raidId = await raid(src, dst);

    expect(await executeDueRaids(ctx, 100, ON)).toEqual({ executed: 1, canceled: 0 });

    const until = new Date(clock.getTime() + RAID_RULES.surgeMinutes * 60_000).toISOString();
    expect(await override(dst.id)).toEqual({ state: "on", since: clock.toISOString(), until, by: null });
    expect(surgeRaidOf(await rawOverride(dst.id))).toEqual({ fromChannel: src.slug, verifiedCount: 3 });
    expect(await valkey.exists(surgeOpenKey(dst.id))).toBe(1);

    const [events, audits] = await rows(dst.id);
    expect(events.map((e) => e.type).sort()).toEqual(["channel.raid", "chat.surge.begin"]);
    expect(events.find((e) => e.type === "chat.surge.begin")?.payload).toEqual({
      trigger: "raid",
      until,
      by_user_id: null,
    });
    expect(audits).toEqual([
      {
        action: "chat.surge.begin",
        details: { trigger: "raid", raidId, fromChannelId: src.id, verifiedCount: 3, until },
      },
    ]);

    for (const u of raiders) {
      expectCarried(await verified(dst.id, u), dst);
      const ttl = await valkey.ttl(KEYS.verifiedWatch(dst.id, u));
      expect(ttl).toBeGreaterThan(RAID_RULES.surgeMinutes * 60);
      expect(ttl).toBeLessThanOrEqual(RAID_RULES.surgeMinutes * 60 + 60);
      expect(await gatePasses(dst, u)).toBe(true);
    }
    expect(await gatePasses(dst, fresh)).toBe(false);

    await waitFor(
      async () =>
        frames.find((f) => f.channel === BUS.chatControl(dst.id) && f.frame.op === "surge" && f.frame.state === "on") ??
        null,
      { label: "the surge frame on the target" },
    );
  });

  test("a botted raid opens the surge, carries nothing, and the bots cannot chat", async () => {
    clock = new Date();
    const [src, dst] = [await liveChannel(), await protectedTarget()];
    const bots = await Promise.all(Array.from({ length: 8 }, () => watcher(src, false)));
    await raid(src, dst);
    await executeDueRaids(ctx, 100, ON);

    expect((await override(dst.id))?.state).toBe("on");
    expect(surgeRaidOf(await rawOverride(dst.id))).toEqual({ fromChannel: src.slug, verifiedCount: 0 });
    for (const b of bots) {
      expect(await verified(dst.id, b)).toBeNull();
      expect(await gatePasses(dst, b)).toBe(false);
    }
  });

  test("raiders past carryMinutes, on another broadcast or behind a farm address over the cap do not carry", async () => {
    clock = new Date();
    const [src, dst] = [await liveChannel(), await protectedTarget()];
    const recent = await watcher(src, true, { agoSeconds: RAID_RULES.carryMinutes * 60 - 30 });
    const gone = await watcher(src, true, { agoSeconds: RAID_RULES.carryMinutes * 60 + 30 });
    const farm = [];
    for (let i = 0; i < 7; i++) farm.push(await watcher(src, true, { ip: `farm-${src.id}` }));
    await raid(src, dst);
    await executeDueRaids(ctx, 100, ON);

    expect(await gatePasses(dst, recent)).toBe(true);
    expect(await verified(dst.id, gone)).toBeNull();
    // The seeded cap (`integrity.thresholds` gateUnlocksPerAddress) leaves the farm's last accounts out.
    const carriedFarm = (await Promise.all(farm.map((u) => verified(dst.id, u)))).filter((v) => v !== null).length;
    expect(carriedFarm).toBeGreaterThan(0);
    expect(carriedFarm).toBeLessThan(farm.length);
  });

  test("a stored source key carries even when the sessions are no longer eligible", async () => {
    clock = new Date();
    const [src, dst] = [await liveChannel(), await protectedTarget()];
    const u = await watcher(src, false);
    await valkey.eval(...verifiedWatchMergeArgs(src.id, u, { b: src.broadcastId, s: 120, f: 0 }, 600));
    await raid(src, dst);
    await executeDueRaids(ctx, 100, ON);
    expect(await verified(dst.id, u)).toEqual({ b: dst.broadcastId, s: 120, f: 0 });
  });

  test("a raider carries their source standing, never more: low source seconds pass neither gate", async () => {
    clock = new Date();
    const [src, dst] = [await liveChannel(), await protectedTarget(600)];
    // Verified and scored on the source, but only 40 s of watching there.
    const brief = await watcher(src, true, { watchSeconds: 40 });
    const long = await watcher(src, true, { watchSeconds: 1200 });
    await raid(src, dst);
    await executeDueRaids(ctx, 100, ON);

    expectCarried(await verified(dst.id, brief), dst, 40);
    expect(await gatePasses(dst, brief, 600)).toBe(false);
    expect(await gatePasses(dst, brief, 0)).toBe(false);
    expectCarried(await verified(dst.id, long), dst, 1200);
    expect(await gatePasses(dst, long, 600)).toBe(true);
  });

  test("verified on the source hours ago and only an unverified session now: no carry", async () => {
    clock = new Date();
    const [src, dst] = [await liveChannel(), await protectedTarget()];
    const u = await watcher(src, true, { agoSeconds: 2 * 3600, startedAgoSeconds: 3 * 3600 });
    await session(src, u, false, { agoSeconds: 5 });
    await raid(src, dst);
    await executeDueRaids(ctx, 100, ON);
    expect(await verified(dst.id, u)).toBeNull();
    expect(await gatePasses(dst, u)).toBe(false);
  });

  test("the source's owner, moderators, VIPs and verified bots neither carry nor take places in the cap", async () => {
    clock = new Date();
    const [src, dst] = [await liveChannel(), await protectedTarget()];
    const { gateUnlocksPerAddress: cap } = await loadThresholds(t.app.db);
    const ip = `shared-${src.id}`;
    // The exempt arrive first on the shared address, so they would take the first places.
    await session(src, src.ownerId, true, { ip, startedAgoSeconds: 1800 });
    const exempt: string[] = [];
    for (const role of ["moderator", "vip"] as const) {
      const id = await watcher(src, true, { ip, startedAgoSeconds: 1700 });
      await owner.insert(s.channelRoles).values({ channelId: src.id, userId: id, role });
      exempt.push(id);
    }
    exempt.push(await watcher(src, true, { ip, startedAgoSeconds: 1600 }));
    await owner
      .update(s.users)
      .set({ accountType: "bot", botVerified: true })
      .where(eq(s.users.id, exempt[2] ?? ""));
    const viewers: string[] = [];
    for (let i = 0; i < cap; i++) viewers.push(await watcher(src, true, { ip }));
    await raid(src, dst);
    await executeDueRaids(ctx, 100, ON);

    for (const id of [src.ownerId, ...exempt]) expect(await verified(dst.id, id)).toBeNull();
    for (const id of viewers) expectCarried(await verified(dst.id, id), dst);
  });

  test("the carry never lowers a larger target value and is not clobbered by a later scoring write", async () => {
    clock = new Date();
    const [src, dst] = [await liveChannel(), await protectedTarget()];
    const [u, v] = [await watcher(src, true), await watcher(src, true)];
    await valkey.eval(...verifiedWatchMergeArgs(dst.id, u, { b: dst.broadcastId, s: 900, f: 0 }, 600));
    await raid(src, dst);
    await executeDueRaids(ctx, 100, ON);
    expect((await verified(dst.id, u))?.s).toBe(900);
    // The target's TTL is the carry's (longer) one.
    expect(await valkey.ttl(KEYS.verifiedWatch(dst.id, u))).toBeGreaterThan(600);

    // The target's scoring pass then sees v's first few seconds there: the carry stands.
    await valkey.eval(...verifiedWatchMergeArgs(dst.id, v, { b: dst.broadcastId, s: 5, f: 0 }, 600));
    expectCarried(await verified(dst.id, v), dst);
    expect(await valkey.ttl(KEYS.verifiedWatch(dst.id, v))).toBeGreaterThan(600);
    expect(await gatePasses(dst, v)).toBe(true);
  });

  test("the surge ends after surgeMinutes: chat.surge.end (expired), its audit row, keys gone", async () => {
    clock = new Date();
    const [src, dst] = [await liveChannel(), await protectedTarget()];
    await watcher(src, true);
    await raid(src, dst);
    await executeDueRaids(ctx, 100, ON);
    expect((await override(dst.id))?.state).toBe("on");

    // Before the end: the guard leaves it alone.
    clock = new Date(clock.getTime() + (RAID_RULES.surgeMinutes * 60 - 30) * 1000);
    await runSurgeGuard(ctx, ON);
    expect((await override(dst.id))?.state).toBe("on");

    clock = new Date(clock.getTime() + 31_000);
    await runSurgeGuard(ctx, ON);
    expect(await override(dst.id)).toBeNull();
    expect(await valkey.exists(surgeOpenKey(dst.id))).toBe(0);
    const [events, audits] = await rows(dst.id);
    expect(events.filter((e) => e.type === "chat.surge.end").map((e) => e.payload)).toEqual([
      { reason: "expired", by_user_id: null },
    ]);
    expect(audits.filter((a) => a.action === "chat.surge.end").map((a) => a.details)).toEqual([
      { reason: "expired", trigger: "raid" },
    ]);
  });

  test("a guard trigger during a raid surge extends it and keeps the raid on the banner", async () => {
    clock = new Date();
    const [src, dst] = [await liveChannel(), await protectedTarget()];
    await watcher(src, true);
    await raid(src, dst);
    await executeDueRaids(ctx, 100, ON);
    const raidUntil = (await override(dst.id))?.until ?? "";

    clock = new Date(clock.getTime() + 120_000);
    // A burst of new unverified sessions, old enough to be judged (as surge-guard.int.test.ts).
    await owner.insert(s.playbackSessions).values(
      Array.from({ length: 30 }, () => ({
        id: uuidv7(),
        channelId: dst.id,
        broadcastId: dst.broadcastId,
        deviceHash: `dev-${tag()}`,
        ipHash: `ip-${tag()}`,
        verdict: "pending" as const,
        verdictReasons: ["media_unconfirmed"],
        scoredAt: clock,
        startedAt: new Date(clock.getTime() - 90_000),
      })),
    );
    await runSurgeGuard(ctx, ON);
    const o = await override(dst.id);
    expect(Date.parse(o?.until ?? "")).toBeGreaterThan(Date.parse(raidUntil));
    expect(surgeRaidOf(await rawOverride(dst.id))).toEqual({ fromChannel: src.slug, verifiedCount: 1 });
    expect((await surgeEvents(dst.id)).map((e) => e.type)).toEqual(["chat.surge.begin"]);
  });
});

describe("an open surge", () => {
  const store = (channelId: string, o: SurgeOverride) =>
    valkey.set(KEYS.surgeOverride(channelId), JSON.stringify(o), "EX", 3_600);

  test("ending sooner is extended to the raid's length, with no second begin", async () => {
    clock = new Date();
    const [src, dst] = [await liveChannel(), await protectedTarget()];
    const since = new Date(clock.getTime() - 60_000).toISOString();
    await store(dst.id, { state: "on", since, until: new Date(clock.getTime() + 60_000).toISOString(), by: null });
    await valkey.set(surgeOpenKey(dst.id), "1");
    const u = await watcher(src, true);
    const raidId = await raid(src, dst);
    await executeDueRaids(ctx, 100, ON);

    const until = new Date(clock.getTime() + RAID_RULES.surgeMinutes * 60_000).toISOString();
    expect(await override(dst.id)).toEqual({ state: "on", since, until, by: null });
    expect(surgeRaidOf(await rawOverride(dst.id))?.fromChannel).toBe(src.slug);
    expect(await surgeEvents(dst.id)).toEqual([]);
    const [, audits] = await rows(dst.id);
    expect(audits.map((a) => a.action)).toEqual(["chat.surge.extend"]);
    expect(audits[0]?.details).toMatchObject({ trigger: "raid", raidId, until, extended: true });
    expect(await gatePasses(dst, u)).toBe(true);
  });

  test("ending later is never shortened", async () => {
    clock = new Date();
    const [src, dst] = [await liveChannel(), await protectedTarget()];
    const later = new Date(clock.getTime() + 40 * 60_000).toISOString();
    await store(dst.id, { state: "on", since: clock.toISOString(), until: later, by: null });
    const u = await watcher(src, true);
    await raid(src, dst);
    await executeDueRaids(ctx, 100, ON);
    expect((await override(dst.id))?.until).toBe(later);
    const [, audits] = await rows(dst.id);
    expect(audits.map((a) => [a.action, (a.details as { extended?: boolean }).extended])).toEqual([
      ["chat.surge.extend", false],
    ]);
    // The carry lasts the whole (longer) surge.
    expect(await valkey.ttl(KEYS.verifiedWatch(dst.id, u))).toBeGreaterThan(40 * 60);
  });

  test("a moderator's suppression wins: no surge, no rows, no carry", async () => {
    clock = new Date();
    const [src, dst] = [await liveChannel(), await protectedTarget()];
    const mod = await user();
    const o: SurgeOverride = {
      state: "suppressed",
      since: clock.toISOString(),
      until: new Date(clock.getTime() + 300_000).toISOString(),
      by: mod,
    };
    await store(dst.id, o);
    const u = await watcher(src, true);
    await raid(src, dst);
    expect(await executeDueRaids(ctx, 100, ON)).toEqual({ executed: 1, canceled: 0 });
    expect(await override(dst.id)).toEqual(o);
    expect(await surgeEvents(dst.id)).toEqual([]);
    expect(await verified(dst.id, u)).toBeNull();
  });
});

describe("opens nothing", () => {
  const cases: { name: string; target: () => Promise<Chan>; cfg?: ChatGateConfig }[] = [
    { name: "the target's guard off", target: () => liveChannel({ enabled: false, onRaid: true }) },
    { name: "Protect raids off", target: () => liveChannel({ enabled: true, onRaid: false }) },
    { name: "the instance surge guard off", target: protectedTarget, cfg: { ...ON, surgeGuard: false } },
  ];
  for (const c of cases)
    test(`${c.name}: the raid executes with no surge and no carry`, async () => {
      clock = new Date();
      const [src, dst] = [await liveChannel(), await c.target()];
      const u = await watcher(src, true);
      await raid(src, dst);
      expect(await executeDueRaids(ctx, 100, c.cfg ?? ON)).toEqual({ executed: 1, canceled: 0 });
      expect(await rawOverride(dst.id)).toBeNull();
      expect(await surgeEvents(dst.id)).toEqual([]);
      expect(await verified(dst.id, u)).toBeNull();
    });

  for (const side of ["source", "target"] as const)
    test(`a suspended ${side}: canceled, no surge`, async () => {
      clock = new Date();
      const [src, dst] = [await liveChannel(), await protectedTarget()];
      const u = await watcher(src, true);
      await owner
        .update(s.channels)
        .set({ suspendedAt: clock })
        .where(eq(s.channels.id, side === "source" ? src.id : dst.id));
      await raid(src, dst);
      expect(await executeDueRaids(ctx, 100, ON)).toEqual({ executed: 0, canceled: 1 });
      expect(await rawOverride(dst.id)).toBeNull();
      expect(await surgeEvents(dst.id)).toEqual([]);
      expect(await verified(dst.id, u)).toBeNull();
    });

  test("a target gone offline: canceled, no surge", async () => {
    clock = new Date();
    const [src, dst] = [await liveChannel(), await protectedTarget()];
    await owner.update(s.channels).set({ liveBroadcastId: null }).where(eq(s.channels.id, dst.id));
    await raid(src, dst);
    expect(await executeDueRaids(ctx, 100, ON)).toEqual({ executed: 0, canceled: 1 });
    expect(await rawOverride(dst.id)).toBeNull();
  });
});
