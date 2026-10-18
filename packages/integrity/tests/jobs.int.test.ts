// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Integrity DB jobs against real Postgres (as the application role) and Valkey. */
import { and, count, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema as s, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createValkey, type ValkeyClient } from "@commonair/service";
import { excludeFollowBursts, markEligibleStreamHours, scoreActiveSessions, verifyReceipts } from "../src/jobs.ts";
import { recordFetch, recordHeartbeat } from "../src/store.ts";
import type { HeartbeatSample } from "../src/types.ts";

let t: TestDatabase;
let app: Database;
let valkey: ValkeyClient;
const NOW = new Date();

beforeAll(async () => {
  t = await createTestDatabase();
  app = t.app.db;
  valkey = createValkey(process.env.VALKEY_URL ?? "redis://localhost:6379", {
    keyPrefix: `test:${crypto.randomUUID()}:`,
    name: "integrity-test",
  });
});
afterAll(async () => {
  await valkey?.quit();
  await t?.drop();
});

let seq = 0;
async function user(createdAt = new Date(NOW.getTime() - 400 * 86_400_000)): Promise<string> {
  const name = `iu${++seq}`;
  const [u] = await app
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name, createdAt })
    .returning({ id: s.users.id });
  return u!.id;
}
async function channel() {
  const ownerId = await user();
  const [c] = await app
    .insert(s.channels)
    .values({ ownerId, slug: `c${seq}`, displayName: `C${seq}` })
    .returning({ id: s.channels.id });
  const [b] = await app
    .insert(s.broadcasts)
    .values({
      channelId: c!.id,
      ingestProtocol: "rtmp",
      path: `live/c${seq}`,
      startedAt: new Date(NOW.getTime() - 3 * 3_600_000),
    })
    .returning({ id: s.broadcasts.id });
  return { ownerId, channelId: c!.id, broadcastId: b!.id };
}

const DESKTOP_FP = { webdriver: false, plugins: 5, webgl: true, innerWidth: 1280, innerHeight: 720, audio: true };
async function session(channelId: string, o: Partial<typeof s.playbackSessions.$inferInsert> = {}): Promise<string> {
  const [p] = await app
    .insert(s.playbackSessions)
    .values({
      channelId,
      deviceHash: `dev-${crypto.randomUUID()}`,
      ipHash: "ip",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      fingerprint: DESKTOP_FP,
      startedAt: new Date(NOW.getTime() - 120_000),
      lastHeartbeatAt: new Date(NOW.getTime() - 5_000),
      heartbeats: 6,
      watchSeconds: 60,
      segmentsFetched: 60,
      bytesHttp: 10_000,
      ...o,
    })
    .returning({ id: s.playbackSessions.id });
  return p!.id;
}

async function humanHistory(sessionId: string, n = 6) {
  for (let i = 0; i < n; i++) {
    const sample: HeartbeatSample = {
      at: NOW.getTime() - (n - i) * 10_000 + ((i * 7919) % 300),
      playedSeconds: 10,
      bufferSeconds: 2 + (i % 3),
      visible: true,
      muted: false,
      stalls: 0,
      bytesHttp: 0,
      bytesP2p: 0,
    };
    await recordHeartbeat(valkey, sessionId, sample);
  }
}

const flagsFor = (subjectId: string) =>
  app.select().from(s.integrityFlags).where(eq(s.integrityFlags.subjectId, subjectId));
const sessionRow = async (id: string) =>
  (await app.select().from(s.playbackSessions).where(eq(s.playbackSessions.id, id)))[0]!;

describe("scoreActiveSessions", () => {
  test("writes verdicts with reasons, flags exclusions, and never deletes or un-excludes", async () => {
    const { channelId } = await channel();
    const clean = await session(channelId);
    await humanHistory(clean);
    const fresh = await session(channelId, { heartbeats: 1 });
    const dc = await session(channelId, { datacenter: "TEST-NET-3 (sample hosting)", asn: 64500 });
    await humanHistory(dc);
    const device = "shared-device";
    const multi: string[] = [];
    for (let i = 0; i < 5; i++) {
      multi.push(
        await session(channelId, { deviceHash: device, startedAt: new Date(NOW.getTime() - 600_000 + i * 1000) }),
      );
    }
    for (const id of multi) await humanHistory(id);
    // Viewbot: perfectly periodic beats, frozen buffer, playlists only.
    const bot = await session(channelId, { heartbeats: 12, segmentsFetched: 0 });
    for (let i = 0; i < 12; i++) {
      await recordHeartbeat(valkey, bot, {
        at: NOW.getTime() - (12 - i) * 10_000,
        playedSeconds: 10,
        bufferSeconds: 2,
        visible: true,
        muted: false,
        stalls: 0,
        bytesHttp: 0,
        bytesP2p: 0,
      });
    }
    for (let i = 0; i < 60; i++) await recordFetch(valkey, { sid: bot, kind: "playlist" });
    // Ended and already verified: not rescored.
    const ended = await session(channelId, { endedAt: new Date(NOW.getTime() - 60_000), verdict: "verified" });

    const r = await scoreActiveSessions(app, valkey, NOW);

    expect((await sessionRow(clean)).verdict).toBe("verified");
    expect((await sessionRow(clean)).verdictReasons).toEqual([]);
    expect(await sessionRow(fresh)).toMatchObject({ verdict: "pending", verdictReasons: ["insufficient_heartbeats"] });
    expect(await sessionRow(dc)).toMatchObject({ verdict: "excluded", verdictReasons: ["datacenter_ip"], score: 0.8 });
    const multiRows = await Promise.all(multi.map(sessionRow));
    expect(multiRows.map((m) => m.verdict)).toEqual(["verified", "verified", "verified", "excluded", "excluded"]);
    expect(multiRows[3]!.verdictReasons).toEqual(["device_concurrency"]);
    const botRow = await sessionRow(bot);
    expect(botRow.verdict).toBe("excluded");
    expect(botRow.verdictReasons).toEqual(["fetch_pattern", "heartbeat_inconsistent"]);
    expect((await sessionRow(ended)).scoredAt).toBeNull();
    expect(r.newlyExcluded.sort()).toEqual([dc, multi[3]!, multi[4]!, bot].sort());

    const dcFlags = await flagsFor(dc);
    expect(dcFlags).toHaveLength(1);
    expect(dcFlags[0]).toMatchObject({
      subjectType: "session",
      signal: "datacenter_ip",
      decision: "excluded",
      channelId,
    });
    expect((await flagsFor(bot)).map((f) => f.signal).sort()).toEqual(["fetch_pattern", "heartbeat_inconsistent"]);
    const audits = await app.select().from(s.auditLog).where(eq(s.auditLog.action, "integrity.session.exclude"));
    expect(audits.map((a) => a.subjectId).sort()).toEqual(r.newlyExcluded.sort());

    // Second run: exclusions are sticky, no duplicate flags, nothing deleted.
    await valkey.del(`integrity:hb:${dc}`);
    const again = await scoreActiveSessions(app, valkey, NOW);
    expect(again.newlyExcluded).toEqual([]);
    expect((await sessionRow(dc)).verdict).toBe("excluded");
    expect(await flagsFor(dc)).toHaveLength(1);
    const [{ n }] = (await app
      .select({ n: count() })
      .from(s.playbackSessions)
      .where(eq(s.playbackSessions.channelId, channelId))) as [{ n: number }];
    expect(n).toBe(10);
  });
});

describe("verifyReceipts", () => {
  async function relay() {
    const ownerId = await user();
    const [r] = await app
      .insert(s.relayNodes)
      .values({
        ownerId,
        name: `relay${seq}`,
        publicUrl: `http://127.0.0.1:${9000 + seq}`,
        declaredCapacityMbps: 100,
        publicKey: "k",
        tokenHash: crypto.randomUUID(),
        status: "active",
      })
      .returning({ id: s.relayNodes.id });
    return r!.id;
  }
  const minute = (m: number) => new Date(Math.floor(NOW.getTime() / 60_000) * 60_000 - m * 60_000);
  async function period(relayId: string, minutesAgo: number, issued: number | null, reported: number) {
    const start = minute(minutesAgo);
    const end = new Date(start.getTime() + 60_000);
    if (issued !== null) {
      await app
        .insert(s.relayIssuance)
        .values({ relayId, bucketStart: start, sessions: 1, segmentTokens: 10, bytesIssued: issued });
    }
    const nonce = crypto.randomUUID();
    const [r] = await app
      .insert(s.relayReceipts)
      .values({
        relayId,
        nonce,
        periodStart: start,
        periodEnd: end,
        bytesReported: reported,
        segmentsReported: 10,
        tokensReported: 1,
        payload: { v: 1, relayId, nonce, periodStart: start.toISOString(), periodEnd: end.toISOString(), entries: [] },
        signature: "sig",
      })
      .returning({ id: s.relayReceipts.id });
    return r!.id;
  }
  const receipt = async (id: string) =>
    (await app.select().from(s.relayReceipts).where(eq(s.relayReceipts.id, id)))[0]!;
  const relayRow = async (id: string) => (await app.select().from(s.relayNodes).where(eq(s.relayNodes.id, id)))[0]!;

  test("verifies honest receipts, rejects over-reports and suspends repeat or gross offenders", async () => {
    const honest = await relay();
    const h1 = await period(honest, 10, 1000, 1000);
    const h2 = await period(honest, 9, 1000, 1080); // within 10 %: verified for issued bytes only
    const h3 = await period(honest, 8, 1000, 1250); // one over-report (< 3x tolerance): rejected, not suspended
    const repeat = await relay();
    await period(repeat, 10, 1000, 1200);
    await period(repeat, 9, 1000, 1000);
    await period(repeat, 8, 1000, 1250);
    const gross = await relay();
    const g1 = await period(gross, 10, null, 5000); // bytes against no issuance
    const late = await period(honest, 1, 1000, 1000); // still inside the grace period

    const r = await verifyReceipts(app, NOW);

    expect(await receipt(h1)).toMatchObject({ status: "verified", bytesVerified: 1000 });
    expect(await receipt(h2)).toMatchObject({ status: "verified", bytesVerified: 1000 });
    expect((await receipt(h2)).overReportRatio).toBeCloseTo(0.08);
    expect(await receipt(h3)).toMatchObject({ status: "rejected", bytesVerified: 0, rejectionReason: "over_report" });
    expect(await receipt(g1)).toMatchObject({
      status: "rejected",
      rejectionReason: "no_issuance",
      overReportRatio: null,
    });
    expect((await receipt(late)).status).toBe("pending");

    expect((await relayRow(honest)).status).toBe("active");
    expect(await relayRow(repeat)).toMatchObject({
      status: "suspended",
      suspendedReason: "integrity:repeated_over_report",
    });
    expect(await relayRow(gross)).toMatchObject({
      status: "suspended",
      suspendedReason: "integrity:gross_over_report",
    });
    expect(r.suspendedRelays.sort()).toEqual([repeat, gross].sort());
    expect(r).toMatchObject({ verified: 3, rejected: 4 });

    const suspFlags = await app
      .select()
      .from(s.integrityFlags)
      .where(and(eq(s.integrityFlags.subjectId, repeat), eq(s.integrityFlags.signal, "relay_suspended")));
    expect(suspFlags).toHaveLength(1);
    const audits = await app.select().from(s.auditLog).where(eq(s.auditLog.action, "integrity.relay.suspend"));
    expect(audits.map((a) => a.subjectId).sort()).toEqual([repeat, gross].sort());

    // Idempotent: nothing pending → nothing changes, no second suspension.
    const again = await verifyReceipts(app, NOW);
    expect(again).toEqual({ verified: 0, rejected: 0, suspendedRelays: [] });
    // Once the grace period passes, the late receipt is checked.
    const later = await verifyReceipts(app, new Date(NOW.getTime() + 5 * 60_000));
    expect(later.verified).toBe(1);
  });
});

describe("excludeFollowBursts", () => {
  test("excludes fresh / never-watched follows in a burst minute and keeps established viewers", async () => {
    const { channelId } = await channel();
    const burstMinute = new Date(Math.floor(NOW.getTime() / 60_000) * 60_000 - 10 * 60_000);
    const fresh: string[] = [];
    for (let i = 0; i < 32; i++) fresh.push(await user(new Date(burstMinute.getTime() - 3_600_000)));
    const established: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await user();
      established.push(id);
      await session(channelId, {
        userId: id,
        startedAt: new Date(burstMinute.getTime() - 86_400_000),
        endedAt: new Date(burstMinute.getTime() - 80_000_000),
        watchSeconds: 1800,
      });
    }
    await app.insert(s.follows).values(
      [...fresh, ...established].map((followerId, i) => ({
        followerId,
        channelId,
        createdAt: new Date(burstMinute.getTime() + i * 1000),
      })),
    );
    // A different, calm channel: a few fresh follows, no burst.
    const calm = await channel();
    await app
      .insert(s.follows)
      .values(
        fresh.slice(0, 5).map((followerId) => ({ followerId, channelId: calm.channelId, createdAt: burstMinute })),
      );

    const r = await excludeFollowBursts(app, NOW);
    expect(r.channels).toEqual([channelId]);
    const excluded = await app
      .select({ followerId: s.follows.followerId })
      .from(s.follows)
      .where(and(eq(s.follows.channelId, channelId), isNotNull(s.follows.excludedAt)));
    expect(excluded.map((e) => e.followerId).sort()).toEqual([...fresh].sort());
    const calmExcluded = await app
      .select()
      .from(s.follows)
      .where(and(eq(s.follows.channelId, calm.channelId), isNotNull(s.follows.excludedAt)));
    expect(calmExcluded).toEqual([]);
    // Follows are kept (not deleted) and each exclusion is flagged with a stable subject.
    const all = await app.select().from(s.follows).where(eq(s.follows.channelId, channelId));
    expect(all).toHaveLength(35);
    const followFlags = await app
      .select()
      .from(s.integrityFlags)
      .where(and(eq(s.integrityFlags.channelId, channelId), eq(s.integrityFlags.subjectType, "follow")));
    expect(followFlags.map((f) => f.subjectId).sort()).toEqual([...fresh].sort());
    expect(await app.select().from(s.auditLog).where(eq(s.auditLog.action, "integrity.follows.exclude"))).toHaveLength(
      1,
    );

    // Idempotent.
    const again = await excludeFollowBursts(app, NOW);
    expect(again.excluded).toEqual([]);
  });
});

describe("markEligibleStreamHours", () => {
  test("counts verified viewers other than the streamer (by account and by device)", async () => {
    const st = await channel();
    const hour = (h: number) => new Date(Math.floor(NOW.getTime() / 3_600_000) * 3_600_000 - h * 3_600_000);
    await app.insert(s.streamHours).values(
      [3, 2, 1].map((h) => ({
        broadcastId: st.broadcastId,
        channelId: st.channelId,
        hourStart: hour(h),
        liveSeconds: 3600,
      })),
    );
    const span = (h: number) => ({
      startedAt: new Date(hour(h).getTime() + 60_000),
      endedAt: new Date(hour(h).getTime() + 1_800_000),
    });
    // Hour -3: only the streamer, signed in, and the same device signed out.
    await session(st.channelId, { userId: st.ownerId, deviceHash: "owner-device", verdict: "verified", ...span(3) });
    await session(st.channelId, { userId: null, deviceHash: "owner-device", verdict: "verified", ...span(3) });
    // Hour -2: two real viewers (one anonymous), one excluded bot, one pending.
    const viewer = await user();
    await session(st.channelId, { userId: viewer, verdict: "verified", ...span(2) });
    await session(st.channelId, { userId: null, deviceHash: "anon-device", verdict: "verified", ...span(2) });
    await session(st.channelId, { verdict: "excluded", ...span(2) });
    await session(st.channelId, { verdict: "pending", ...span(2) });
    // Hour -1: one viewer whose session spans into it from hour -2 (counted in both).
    await session(st.channelId, {
      userId: viewer,
      verdict: "verified",
      startedAt: new Date(hour(2).getTime() + 3_000_000),
      endedAt: new Date(hour(1).getTime() + 600_000),
    });

    const r = await markEligibleStreamHours(app, NOW);
    const rows = await app
      .select()
      .from(s.streamHours)
      .where(eq(s.streamHours.broadcastId, st.broadcastId))
      .orderBy(s.streamHours.hourStart);
    expect(rows.map((x) => [x.verifiedOtherViewers, x.eligible])).toEqual([
      [0, false],
      [2, true],
      [1, true],
    ]);
    expect(r).toEqual({ updated: 2, eligible: 2 });

    // Idempotent; and a later exclusion makes the hour ineligible again.
    expect(await markEligibleStreamHours(app, NOW)).toEqual({ updated: 0, eligible: 0 });
    await app.update(s.playbackSessions).set({ verdict: "excluded" }).where(eq(s.playbackSessions.userId, viewer));
    await markEligibleStreamHours(app, NOW);
    const after = await app
      .select()
      .from(s.streamHours)
      .where(eq(s.streamHours.broadcastId, st.broadcastId))
      .orderBy(s.streamHours.hourStart);
    expect(after.map((x) => [x.verifiedOtherViewers, x.eligible])).toEqual([
      [0, false],
      [1, true],
      [0, false],
    ]);
  });
});
