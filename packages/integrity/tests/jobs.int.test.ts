// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Integrity DB jobs against real Postgres (as the application role) and Valkey. */
import { and, count, eq, inArray, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema as s, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createValkey, type ValkeyClient } from "@commonair/service";
import { KEYS, P2P_EVIDENCE } from "@commonair/contracts/internal";
import { excludeFollowBursts, markEligibleStreamHours, scoreActiveSessions, verifyReceipts } from "../src/jobs.ts";
import { recordFetch, recordFetches, recordHeartbeat } from "../src/store.ts";
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
      ipHash: `ip-${crypto.randomUUID()}`,
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
    // A hosting address alone is not enough (0.6); with a webdriver flag it is.
    const dcOnly = await session(channelId, { datacenter: "TEST-NET-3 (sample hosting)", asn: 64500 });
    await humanHistory(dcOnly);
    const dc = await session(channelId, {
      datacenter: "TEST-NET-3 (sample hosting)",
      asn: 64500,
      fingerprint: { ...DESKTOP_FP, webdriver: true },
    });
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
    expect(await sessionRow(dcOnly)).toMatchObject({
      verdict: "verified",
      verdictReasons: ["datacenter_ip"],
      score: 0.6,
    });
    expect(await sessionRow(dc)).toMatchObject({ verdict: "excluded", verdictReasons: ["datacenter_ip", "headless"] });
    // Newest first: the two oldest of five concurrent sessions on one device fire.
    const multiRows = await Promise.all(multi.map(sessionRow));
    expect(multiRows.map((m) => m.verdict)).toEqual(["excluded", "excluded", "verified", "verified", "verified"]);
    expect(multiRows[0]!.verdictReasons).toEqual(["device_concurrency"]);
    const botRow = await sessionRow(bot);
    expect(botRow.verdict).toBe("excluded");
    expect(botRow.verdictReasons).toEqual(["fetch_pattern", "heartbeat_inconsistent"]);
    expect((await sessionRow(ended)).scoredAt).toBeNull();
    expect(r.newlyExcluded.sort()).toEqual([dc, multi[0]!, multi[1]!, bot].sort());

    const dcFlags = await flagsFor(dc);
    expect(dcFlags.map((f) => f.signal).sort()).toEqual(["datacenter_ip", "headless"]);
    expect(dcFlags[0]).toMatchObject({ subjectType: "session", decision: "excluded", channelId });
    expect((await flagsFor(bot)).map((f) => f.signal).sort()).toEqual(["fetch_pattern", "heartbeat_inconsistent"]);
    const audits = await app.select().from(s.auditLog).where(eq(s.auditLog.action, "integrity.session.exclude"));
    expect(audits.map((a) => a.subjectId).sort()).toEqual(r.newlyExcluded.sort());

    // Second run: exclusions are sticky, no duplicate flags, nothing deleted.
    await valkey.del(`integrity:hb:${dc}`);
    const again = await scoreActiveSessions(app, valkey, NOW);
    expect(again.newlyExcluded).toEqual([]);
    expect((await sessionRow(dc)).verdict).toBe("excluded");
    expect(await flagsFor(dc)).toHaveLength(2);
    const [{ n }] = (await app
      .select({ n: count() })
      .from(s.playbackSessions)
      .where(eq(s.playbackSessions.channelId, channelId))) as [{ n: number }];
    expect(n).toBe(11);
  });

  test("fetch-less heartbeat sessions never verify; part-only and CDN sessions are fine", async () => {
    const { channelId } = await channel();
    // Heartbeats claim 60 s of playback; the database counter saw no segment and no counters exist.
    const dbZero = await session(channelId, { segmentsFetched: 0 });
    await humanHistory(dbZero);
    // Database counter only: one segment for 60 s claimed is far too few full segments.
    const dbOne = await session(channelId, { segmentsFetched: 1 });
    await humanHistory(dbOne);
    // Origin counters exist (the consumer saw this token) and show no media at all.
    const known = await session(channelId, { segmentsFetched: 0 });
    await humanHistory(known);
    for (let i = 0; i < 5; i++) await recordFetch(valkey, { sid: known, kind: "playlist" });
    // A low-latency player: distinct parts only, zero full segments.
    const llhls = await session(channelId, { segmentsFetched: 0 });
    await humanHistory(llhls);
    await recordFetches(valkey, [
      ...Array.from({ length: 60 }, () => ({ sid: llhls, kind: "playlist" as const })),
      ...Array.from({ length: 290 }, (_, i) => ({ sid: llhls, kind: "part" as const, object: `src/part${i}.mp4` })),
    ]);
    // Re-requesting the same 5 parts 290 times does not look like 290 parts.
    const replay = await session(channelId, { segmentsFetched: 0 });
    await humanHistory(replay);
    await recordFetches(valkey, [
      ...Array.from({ length: 60 }, () => ({ sid: replay, kind: "playlist" as const })),
      ...Array.from({ length: 290 }, (_, i) => ({
        sid: replay,
        kind: "part" as const,
        object: `src/part${i % 5}.mp4`,
      })),
    ]);
    // CDN delivery has no per-session accounting (known limitation: never judged).
    const cdn = await session(channelId, { assignedSource: "cdn", segmentsFetched: 0 });
    await humanHistory(cdn);

    const r = await scoreActiveSessions(app, valkey, NOW);

    expect(await sessionRow(dbZero)).toMatchObject({ verdict: "pending", verdictReasons: ["media_unconfirmed"] });
    expect(await sessionRow(dbOne)).toMatchObject({ verdict: "pending", verdictReasons: ["media_unconfirmed"] });
    expect(await sessionRow(known)).toMatchObject({ verdict: "excluded", verdictReasons: ["fetch_pattern"] });
    expect((await flagsFor(known))[0]!.details).toMatchObject({ checks: ["no_media_fetched"] });
    expect(await sessionRow(llhls)).toMatchObject({ verdict: "verified", verdictReasons: [] });
    expect(await sessionRow(replay)).toMatchObject({
      verdict: "pending",
      verdictReasons: ["fetch_pattern", "media_unconfirmed"],
    });
    expect(await sessionRow(cdn)).toMatchObject({ verdict: "verified", verdictReasons: [] });
    expect(r.newlyExcluded).toEqual(expect.arrayContaining([known]));
    expect(r.newlyExcluded).not.toContain(dbZero);
  });

  test("relay sessions verify only on receipts verified with complete issuance", async () => {
    const { channelId } = await channel();
    const relayId = await relayNode();
    const relayBot = await session(channelId, { assignedSource: "relay", relayId, segmentsFetched: 0 });
    const relayViewer = await session(channelId, { assignedSource: "relay", relayId, segmentsFetched: 0 });
    for (const id of [relayBot, relayViewer]) await humanHistory(id);
    await receiptFor(relayId, [{ sessionId: relayViewer, segments: 300, bytes: 400_000 }], { bytesVerified: 400_000 });

    // A relay whose receipt over-claims objects for the bytes it was verified for: capped.
    const greedyRelay = await relayNode();
    const capped = await session(channelId, { assignedSource: "relay", relayId: greedyRelay, segmentsFetched: 0 });
    await humanHistory(capped);
    await receiptFor(greedyRelay, [{ sessionId: capped, segments: 300, bytes: 5_000 }], { bytesVerified: 5_000 });

    // Receipts that prove nothing: pending, rejected, or verified with unknown issuance.
    const unproven: string[] = [];
    for (const kind of ["pending", "rejected", "unknown"] as const) {
      const rid = await relayNode();
      const id = await session(channelId, { assignedSource: "relay", relayId: rid, segmentsFetched: 0 });
      await humanHistory(id);
      await receiptFor(rid, [{ sessionId: id, segments: 300, bytes: 400_000 }], {
        status: kind === "unknown" ? "verified" : kind,
        ratio: kind === "unknown" ? null : 0,
        bytesVerified: kind === "unknown" ? 400_000 : 0,
      });
      unproven.push(id);
    }
    // A relay with no receipts at all.
    const silentRelay = await relayNode();
    const unaccounted = await session(channelId, { assignedSource: "relay", relayId: silentRelay, segmentsFetched: 0 });
    await humanHistory(unaccounted);
    // Ended before any receipt arrived: held, and corrected when a late receipt lands.
    const lateRelay = await relayNode();
    const ended = await session(channelId, {
      assignedSource: "relay",
      relayId: lateRelay,
      segmentsFetched: 0,
      endedAt: new Date(NOW.getTime() - 5_000),
    });
    await humanHistory(ended);

    const r = await scoreActiveSessions(app, valkey, NOW);

    expect(await sessionRow(relayBot)).toMatchObject({ verdict: "excluded", verdictReasons: ["fetch_pattern"] });
    expect(await sessionRow(relayViewer)).toMatchObject({ verdict: "verified", verdictReasons: [] });
    // 5 000 bytes cover at most 5 objects of the 300 claimed: far too few for 50 s.
    expect(await sessionRow(capped)).toMatchObject({
      verdict: "pending",
      verdictReasons: ["fetch_pattern", "media_unconfirmed"],
    });
    for (const id of [...unproven, unaccounted, ended]) {
      expect(await sessionRow(id), id).toMatchObject({ verdict: "pending", verdictReasons: ["media_unconfirmed"] });
    }
    expect(r.newlyExcluded).toContain(relayBot);

    await receiptFor(lateRelay, [{ sessionId: ended, segments: 300, bytes: 400_000 }], { bytesVerified: 400_000 });
    await scoreActiveSessions(app, valkey, new Date(NOW.getTime() + 60_000));
    expect(await sessionRow(ended)).toMatchObject({ verdict: "verified", verdictReasons: [] });
  });

  test("a reload supersedes the stale session: it ends with an audit row, and neither is a duplicate", async () => {
    const { channelId } = await channel();
    const other = await channel();
    const device = `reload-${crypto.randomUUID()}`;
    // Two other live tabs on the same device (another channel) use up most of the allowance (3).
    const tabs = [
      await session(other.channelId, { deviceHash: device, startedAt: new Date(NOW.getTime() - 900_000) }),
      await session(other.channelId, { deviceHash: device, startedAt: new Date(NOW.getTime() - 800_000) }),
    ];
    const lastBeat = new Date(NOW.getTime() - 100_000);
    const stale = await session(channelId, {
      deviceHash: device,
      startedAt: new Date(NOW.getTime() - 600_000),
      lastHeartbeatAt: lastBeat,
      verdict: "verified",
    });
    const reload = await session(channelId, { deviceHash: device, startedAt: new Date(NOW.getTime() - 95_000) });
    for (const id of [...tabs, stale, reload]) await humanHistory(id);
    await valkey.zadd(`viewers:${channelId}`, NOW.getTime() - 100_000, stale);
    // Same pattern, but the old session's last beat was hidden (a throttled background tab): kept.
    const bgDevice = `bg-${crypto.randomUUID()}`;
    const background = await session(channelId, {
      deviceHash: bgDevice,
      startedAt: new Date(NOW.getTime() - 600_000),
      lastHeartbeatAt: lastBeat,
    });
    await recordHeartbeat(valkey, background, {
      at: lastBeat.getTime(),
      playedSeconds: 10,
      bufferSeconds: 3,
      visible: false,
      muted: false,
      stalls: 0,
      bytesHttp: 0,
      bytesP2p: 0,
    });
    await session(channelId, { deviceHash: bgDevice, startedAt: new Date(NOW.getTime() - 95_000) });

    const r = await scoreActiveSessions(app, valkey, NOW);

    expect(r.superseded).toEqual([stale]);
    const staleRow = await sessionRow(stale);
    expect(staleRow.endedAt?.getTime()).toBe(lastBeat.getTime());
    expect(staleRow.verdict).not.toBe("excluded");
    expect(await sessionRow(reload)).toMatchObject({ verdict: "verified", verdictReasons: [] });
    for (const id of tabs) expect((await sessionRow(id)).verdict).toBe("verified");
    expect(await valkey.zscore(`viewers:${channelId}`, stale)).toBeNull();
    expect((await sessionRow(background)).endedAt).toBeNull();
    const audits = await app.select().from(s.auditLog).where(eq(s.auditLog.subjectId, stale));
    expect(audits.map((a) => a.action)).toContain("integrity.session.supersede");
    // Idempotent: nothing left to supersede.
    expect((await scoreActiveSessions(app, valkey, NOW)).superseded).toEqual([]);
  });

  test("before the grace period a quiet predecessor is not counted, so the reload is never the duplicate", async () => {
    const { channelId } = await channel();
    const other = await channel();
    const device = `quiet-${crypto.randomUUID()}`;
    for (const start of [900_000, 800_000]) {
      const id = await session(other.channelId, { deviceHash: device, startedAt: new Date(NOW.getTime() - start) });
      await humanHistory(id);
    }
    const old = await session(channelId, {
      deviceHash: device,
      startedAt: new Date(NOW.getTime() - 600_000),
      lastHeartbeatAt: new Date(NOW.getTime() - 32_000),
    });
    const reload = await session(channelId, { deviceHash: device, startedAt: new Date(NOW.getTime() - 30_000) });
    for (const id of [old, reload]) await humanHistory(id);

    const r = await scoreActiveSessions(app, valkey, NOW);
    expect(r.superseded).not.toContain(old);
    expect((await sessionRow(old)).verdict).not.toBe("excluded");
    expect((await sessionRow(reload)).verdict).not.toBe("excluded");
  });

  test("appeal overturns and allowed flags stick unless new evidence arrives", async () => {
    const { channelId } = await channel();
    const viewer = await user();
    const hosted = { datacenter: "TEST-NET-3 (sample hosting)", fingerprint: { ...DESKTOP_FP, webdriver: true } };
    const appealed = await session(channelId, { userId: viewer, ...hosted });
    const cleared = await session(channelId, { ...hosted });
    for (const id of [appealed, cleared]) await humanHistory(id);
    await scoreActiveSessions(app, valkey, NOW);
    expect((await sessionRow(appealed)).verdict).toBe("excluded");
    expect((await sessionRow(cleared)).verdict).toBe("excluded");
    // Every time is stamped explicitly (no dependence on the database clock).
    await stampFlags([appealed, cleared], NOW);

    // The appeal is overturned (the resolver does not touch the verdict); an admin clears one of two flags.
    const decidedAt = new Date(NOW.getTime() + 1_000);
    await app.insert(s.appeals).values({
      appellantId: viewer,
      kind: "integrity",
      subjectType: "session",
      subjectId: appealed,
      body: "I was on my office VPN, this is me.",
      status: "overturned",
      resolution: "VPN user",
      resolvedAt: decidedAt,
    });
    const [dcFlag] = (await flagsFor(cleared)).filter((f) => f.signal === "datacenter_ip");
    await app
      .update(s.integrityFlags)
      .set({ decision: "allowed", decidedAt })
      .where(eq(s.integrityFlags.id, dcFlag!.id));

    const later = new Date(decidedAt.getTime() + 4_000);
    const r = await scoreActiveSessions(app, valkey, later);
    expect(r.restored).toEqual(expect.arrayContaining([appealed, cleared]));
    expect(await sessionRow(appealed)).toMatchObject({ verdict: "verified", verdictReasons: ["allowed_on_appeal"] });
    // The other flag (headless, 0.6) still shows but no longer excludes on its own.
    expect(await sessionRow(cleared)).toMatchObject({
      verdict: "verified",
      verdictReasons: ["headless", "allowed_on_appeal"],
    });
    const restores = await app.select().from(s.auditLog).where(eq(s.auditLog.action, "integrity.session.restore"));
    expect(restores.map((a) => a.subjectId)).toEqual(expect.arrayContaining([appealed, cleared]));

    // Rescoring again does not re-exclude (no new evidence) and writes no new flags.
    const flagsBefore = (await flagsFor(appealed)).length;
    const again = await scoreActiveSessions(app, valkey, new Date(later.getTime() + 5_000));
    expect(again.newlyExcluded).not.toContain(appealed);
    expect((await sessionRow(appealed)).verdict).toBe("verified");
    expect(await flagsFor(appealed)).toHaveLength(flagsBefore);

    // New evidence after the decision (a signal not covered) still excludes.
    const device = (await sessionRow(appealed)).deviceHash;
    for (let i = 0; i < 3; i++) {
      const id = await session(channelId, {
        deviceHash: device,
        startedAt: new Date(NOW.getTime() - 60_000 + i * 1000),
      });
      await humanHistory(id);
    }
    const third = await scoreActiveSessions(app, valkey, new Date(later.getTime() + 10_000));
    expect(third.newlyExcluded).toContain(appealed);
    expect(await sessionRow(appealed)).toMatchObject({
      verdict: "excluded",
      verdictReasons: ["device_concurrency", "allowed_on_appeal"],
    });
  });

  test("an account-level overturn covers sessions that existed at the decision, never later ones", async () => {
    const { channelId } = await channel();
    const viewer = await user();
    const hosted = { datacenter: "TEST-NET-3 (sample hosting)", fingerprint: { ...DESKTOP_FP, webdriver: true } };
    const first = await session(channelId, { userId: viewer, ...hosted, endedAt: new Date(NOW.getTime() - 5_000) });
    const concurrent = await session(channelId, { userId: viewer, ...hosted });
    for (const id of [first, concurrent]) await humanHistory(id);
    await scoreActiveSessions(app, valkey, NOW);
    expect((await sessionRow(first)).verdict).toBe("excluded");
    expect((await sessionRow(concurrent)).verdict).toBe("excluded");
    await stampFlags([first, concurrent], NOW);
    const resolvedAt = new Date(NOW.getTime() + 1_000);
    await app.insert(s.appeals).values({
      appellantId: viewer,
      kind: "integrity",
      subjectType: "user",
      subjectId: viewer,
      body: "My whole household uses this VPN.",
      status: "overturned",
      resolvedAt,
    });
    // A session started after the decision: the allowance does not reach it.
    const next = await session(channelId, {
      userId: viewer,
      ...hosted,
      startedAt: new Date(resolvedAt.getTime() + 1_000),
      lastHeartbeatAt: new Date(resolvedAt.getTime() + 2_000),
    });
    await humanHistory(next);
    await scoreActiveSessions(app, valkey, new Date(resolvedAt.getTime() + 3_000));
    expect(await sessionRow(concurrent)).toMatchObject({ verdict: "verified", verdictReasons: ["allowed_on_appeal"] });
    expect(await sessionRow(next)).toMatchObject({
      verdict: "excluded",
      verdictReasons: ["datacenter_ip", "headless"],
    });
  });

  test("server-side P2P evidence: a swarm spanning two networks lowers the HTTP bar, nothing else does", async () => {
    const { channelId } = await channel();
    const swarm = `${channelId}:${"ab".repeat(20)}`;
    const lonely = `${channelId}:${"cd".repeat(20)}`;
    // As the tracker writes them on each authenticated announce.
    async function announce(sid: string, sw: string, net: string, last = NOW.getTime() - 5_000) {
      await valkey.hset(KEYS.p2pPeer(sid), {
        swarm: sw,
        net,
        first: String(last - 60_000),
        last: String(last),
        announces: "9",
      });
      await valkey.expire(KEYS.p2pPeer(sid), P2P_EVIDENCE.peerTtlSeconds);
      await valkey.zadd(KEYS.p2pSwarm(sw), last, sid);
    }
    // 200 s claimed → 200 expected segments; each session fetched ~15 % of them over HTTP.
    async function viewer(o: Partial<typeof s.playbackSessions.$inferInsert> = {}) {
      const id = await session(channelId, { watchSeconds: 200, segmentsFetched: 30, ...o });
      await humanHistory(id);
      await recordFetches(valkey, [
        ...Array.from({ length: 200 }, () => ({ sid: id, kind: "playlist" as const })),
        ...Array.from({ length: 30 }, (_, i) => ({ sid: id, kind: "segment" as const, object: `src/seg${i}.mp4` })),
      ]);
      return id;
    }
    const a = await viewer();
    const b = await viewer();
    await announce(a, swarm, "net-a");
    await announce(b, swarm, "net-b");
    // The same session shape, but its swarm has only one network (two sessions behind it).
    const c = await viewer();
    const d = await viewer();
    await announce(c, lonely, "net-c");
    await announce(d, lonely, "net-c");
    // Announced in a two-network swarm, but too long ago.
    const stale = await viewer();
    await announce(stale, swarm, "net-z", NOW.getTime() - P2P_EVIDENCE.windowMs - 1_000);
    // Client-reported P2P bytes and a legacy `p2p` row without tracker evidence change nothing.
    const claims = await viewer({ bytesP2p: 50_000_000, bytesHttp: 1_000 });
    const legacy = await viewer({ assignedSource: "p2p" });
    // A corrupt peer key is an evidence error, not a failed run.
    const broken = await viewer();
    await valkey.set(KEYS.p2pPeer(broken), "not-a-hash");

    const r = await scoreActiveSessions(app, valkey, NOW);

    for (const id of [a, b]) expect(await sessionRow(id)).toMatchObject({ verdict: "verified", verdictReasons: [] });
    for (const id of [c, d, stale, claims, legacy, broken]) {
      expect(await sessionRow(id)).toMatchObject({
        verdict: "pending",
        verdictReasons: ["fetch_pattern", "media_unconfirmed"],
      });
    }
    expect(r.p2p).toEqual({ evidenced: 2, errors: 1 });
  });

  test("P2P evidence explains itself in the exclusion flag", async () => {
    const { channelId } = await channel();
    const swarm = `${channelId}:${"ef".repeat(20)}`;
    // A playlist poller in a real swarm: evidence lowers the bar, it does not excuse no media.
    const id = await session(channelId, { watchSeconds: 200, segmentsFetched: 0 });
    await humanHistory(id);
    for (let i = 0; i < 5; i++) await recordFetch(valkey, { sid: id, kind: "playlist" });
    const other = await session(channelId, { watchSeconds: 0, segmentsFetched: 0 });
    for (const [sid, net] of [
      [id, "net-a"],
      [other, "net-b"],
    ] as const) {
      await valkey.hset(KEYS.p2pPeer(sid), { swarm, net, first: String(NOW.getTime()), last: String(NOW.getTime()) });
      await valkey.zadd(KEYS.p2pSwarm(swarm), NOW.getTime(), sid);
    }
    await scoreActiveSessions(app, valkey, NOW);
    expect(await sessionRow(id)).toMatchObject({ verdict: "excluded", verdictReasons: ["fetch_pattern"] });
    expect((await flagsFor(id))[0]!.details).toMatchObject({
      checks: ["no_media_fetched"],
      p2pEvidenced: 1,
      swarmNetworks: 2,
      httpShare: 0.1,
      expectedSegments: 20,
    });
  });

  test("an excluded session that stays excluded still rotates (scored_at moves)", async () => {
    const { channelId } = await channel();
    const viewer = await user();
    const id = await session(channelId, {
      userId: viewer,
      datacenter: "TEST-NET-3 (sample hosting)",
      fingerprint: { ...DESKTOP_FP, webdriver: true },
    });
    await humanHistory(id);
    await scoreActiveSessions(app, valkey, NOW);
    await stampFlags([id], NOW);
    // Only the webdriver flag is cleared; the hosting address plus a fresh device crowd keep it out.
    const [flag] = (await flagsFor(id)).filter((f) => f.signal === "headless");
    await app
      .update(s.integrityFlags)
      .set({ decision: "allowed", decidedAt: new Date(NOW.getTime() + 1_000) })
      .where(eq(s.integrityFlags.id, flag!.id));
    const device = (await sessionRow(id)).deviceHash;
    for (let i = 0; i < 3; i++)
      await session(channelId, { deviceHash: device, startedAt: new Date(NOW.getTime() - 30_000 + i) });
    const at = new Date(NOW.getTime() + 2_000);
    await scoreActiveSessions(app, valkey, at);
    const row = await sessionRow(id);
    expect(row.verdict).toBe("excluded");
    expect(row.scoredAt?.getTime()).toBe(at.getTime());
  });
});

/** Pin the creation time of the flags on these subjects (tests must not depend on the DB clock). */
async function stampFlags(subjectIds: string[], at: Date) {
  await app.update(s.integrityFlags).set({ createdAt: at }).where(inArray(s.integrityFlags.subjectId, subjectIds));
}

async function receiptFor(
  relayId: string,
  entries: { sessionId: string; segments: number; bytes: number }[],
  o: { status?: "pending" | "verified" | "rejected"; ratio?: number | null; bytesVerified?: number } = {},
) {
  const start = new Date(NOW.getTime() - 120_000);
  const end = new Date(NOW.getTime() - 10_000);
  const nonce = crypto.randomUUID();
  await app.insert(s.relayReceipts).values({
    relayId,
    nonce,
    periodStart: start,
    periodEnd: end,
    bytesReported: entries.reduce((a, e) => a + e.bytes, 0),
    segmentsReported: entries.reduce((a, e) => a + e.segments, 0),
    tokensReported: entries.length,
    payload: { v: 1, relayId, nonce, periodStart: start.toISOString(), periodEnd: end.toISOString(), entries },
    signature: "sig",
    status: o.status ?? "verified",
    overReportRatio: o.ratio === undefined ? 0 : o.ratio,
    bytesVerified: o.bytesVerified ?? 0,
  });
}

async function relayNode(status: "active" | "suspended" = "active") {
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
      status,
    })
    .returning({ id: s.relayNodes.id });
  return r!.id;
}

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
    // All three are assignable before the run (as their heartbeats published them).
    await valkey.hset(KEYS.relays, honest, "{}", repeat, "{}", gross, "{}");

    const r = await verifyReceipts(app, NOW, { valkey });

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
    expect(r).toMatchObject({ verified: 3, rejected: 4, deassignFailed: 0 });
    // Suspended relays leave assignment at once, not on their next heartbeat.
    expect(await valkey.hexists(KEYS.relays, repeat)).toBe(0);
    expect(await valkey.hexists(KEYS.relays, gross)).toBe(0);
    expect(await valkey.hexists(KEYS.relays, honest)).toBe(1);

    const suspFlags = await app
      .select()
      .from(s.integrityFlags)
      .where(and(eq(s.integrityFlags.subjectId, repeat), eq(s.integrityFlags.signal, "relay_suspended")));
    expect(suspFlags).toHaveLength(1);
    const audits = await app.select().from(s.auditLog).where(eq(s.auditLog.action, "integrity.relay.suspend"));
    expect(audits.map((a) => a.subjectId).sort()).toEqual([repeat, gross].sort());

    // Idempotent: nothing pending → nothing changes, no second suspension.
    const again = await verifyReceipts(app, NOW);
    expect(again).toEqual({ verified: 0, rejected: 0, unknown: 0, suspendedRelays: [], deassignFailed: 0 });
    // Once the grace period passes, the late receipt is checked.
    const later = await verifyReceipts(app, new Date(NOW.getTime() + 5 * 60_000));
    expect(later.verified).toBeGreaterThanOrEqual(1);
    expect((await receipt(late)).status).toBe("verified");
  });

  test("a reinstated relay is not suspended again for receipts from before its reinstatement", async () => {
    const r = await relay();
    // Checked history from before the suspension: gross over-reports.
    for (const m of [30, 29]) {
      const id = await period(r, m, null, 5000);
      await app
        .update(s.relayReceipts)
        .set({ status: "rejected", rejectionReason: "no_issuance", checkedAt: NOW })
        .where(eq(s.relayReceipts.id, id));
    }
    // Still pending from before the reinstatement, checked only now: rejected, but forgiven.
    const old = await period(r, 25, 1000, 2000);
    await app.insert(s.auditLog).values({
      actorType: "admin",
      action: "relay.reinstate",
      subjectType: "relay",
      subjectId: r,
      reason: "operator fixed the counter",
      createdAt: minute(20),
    });
    const fresh = await period(r, 10, 1000, 1000);

    const res = await verifyReceipts(app, NOW);
    expect(await receipt(old)).toMatchObject({ status: "rejected", rejectionReason: "over_report" });
    expect(await receipt(fresh)).toMatchObject({ status: "verified", bytesVerified: 1000 });
    expect(res.suspendedRelays).not.toContain(r);
    expect((await relayRow(r)).status).toBe("active");

    // Fresh misbehaviour after the reinstatement still suspends.
    await period(r, 8, 1000, 4000);
    const res2 = await verifyReceipts(app, NOW);
    expect(res2.suspendedRelays).toContain(r);
    expect(await relayRow(r)).toMatchObject({ status: "suspended", suspendedReason: "integrity:gross_over_report" });
  });

  test("missing issuance while the relay had live sessions is unknown, not over-reporting", async () => {
    const r = await relay();
    const { channelId } = await channel();
    // A live viewer assigned to the relay for the whole window.
    await session(channelId, {
      assignedSource: "relay",
      relayId: r,
      startedAt: new Date(NOW.getTime() - 60 * 60_000),
      lastHeartbeatAt: new Date(NOW.getTime() - 5_000),
    });
    // Origin restarted: no issuance rows at all for these minutes.
    const gap1 = await period(r, 45, null, 5000);
    const gap2 = await period(r, 44, null, 5000);
    // Production record lost: a row with sessions but no bytes, and nobody else issued bytes.
    await app
      .insert(s.relayIssuance)
      .values({ relayId: r, bucketStart: minute(43), sessions: 1, segmentTokens: 0, bytesIssued: 0 });
    const lost = await period(r, 43, null, 5000);
    // Complete issuance is still checked as usual.
    const ok = await period(r, 42, 1000, 1050);
    // Regression: another relay was issued bytes in this minute (another broadcast's production).
    // That is not coverage for r, whose own issuance for the minute is missing.
    const busy = await relay();
    await app
      .insert(s.relayIssuance)
      .values({ relayId: busy, bucketStart: minute(41), sessions: 1, segmentTokens: 10, bytesIssued: 1000 });
    const other = await period(r, 41, null, 5000);

    const res = await verifyReceipts(app, NOW);
    for (const id of [gap1, gap2, lost, other]) {
      expect(await receipt(id)).toMatchObject({ status: "verified", bytesVerified: 0, overReportRatio: null });
    }
    expect(await receipt(ok)).toMatchObject({ status: "verified", bytesVerified: 1000 });
    expect(res.suspendedRelays).not.toContain(r);
    expect(res.unknown).toBe(4);
    const unknownFlags = await app
      .select()
      .from(s.integrityFlags)
      .where(and(eq(s.integrityFlags.subjectId, r), eq(s.integrityFlags.signal, "relay_issuance_unknown")));
    expect(unknownFlags).toHaveLength(4);
    expect(unknownFlags[0]).toMatchObject({ decision: "pending_review" });
  });

  test("bytes reported for a minute without live sessions on the relay and without issuance are real", async () => {
    const r = await relay();
    // Other relays had issuance in this minute, but r had no live session: nothing was issued to r.
    const busy = await relay();
    await app
      .insert(s.relayIssuance)
      .values({ relayId: busy, bucketStart: minute(39), sessions: 1, segmentTokens: 10, bytesIssued: 1000 });
    const real = await period(r, 39, null, 5000);
    const res = await verifyReceipts(app, NOW);
    expect(await receipt(real)).toMatchObject({ status: "rejected", rejectionReason: "no_issuance" });
    // A no-issuance rejection is a gross over-report: the relay is suspended for it alone.
    expect(res.suspendedRelays).toContain(r);
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
        verdict: "verified",
      });
    }
    // Old accounts whose only "prior viewing" was botted (excluded or never verified) sessions.
    const botted: string[] = [];
    for (const verdict of ["excluded", "pending"] as const) {
      const id = await user();
      botted.push(id);
      await session(channelId, {
        userId: id,
        startedAt: new Date(burstMinute.getTime() - 86_400_000),
        endedAt: new Date(burstMinute.getTime() - 80_000_000),
        watchSeconds: 1800,
        verdict,
      });
    }
    await app.insert(s.follows).values(
      [...fresh, ...established, ...botted].map((followerId, i) => ({
        followerId,
        channelId,
        createdAt: new Date(burstMinute.getTime() + i * 1000),
      })),
    );
    // A fresh account that started watching 10 s before following (its session ran on for 30 min):
    // only the 10 s before the follow count as prior viewing.
    await session(channelId, {
      userId: fresh[0]!,
      startedAt: new Date(burstMinute.getTime() - 10_000),
      endedAt: new Date(burstMinute.getTime() + 1_790_000),
      watchSeconds: 1800,
      verdict: "verified",
    });
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
    expect(excluded.map((e) => e.followerId).sort()).toEqual([...fresh, ...botted].sort());
    const calmExcluded = await app
      .select()
      .from(s.follows)
      .where(and(eq(s.follows.channelId, calm.channelId), isNotNull(s.follows.excludedAt)));
    expect(calmExcluded).toEqual([]);
    // Follows are kept (not deleted) and each exclusion is flagged with a stable subject.
    const all = await app.select().from(s.follows).where(eq(s.follows.channelId, channelId));
    expect(all).toHaveLength(37);
    const followFlags = await app
      .select()
      .from(s.integrityFlags)
      .where(and(eq(s.integrityFlags.channelId, channelId), eq(s.integrityFlags.subjectType, "follow")));
    expect(followFlags.map((f) => f.subjectId).sort()).toEqual([...fresh, ...botted].sort());
    expect(followFlags.find((f) => f.subjectId === fresh[0])!.details).toMatchObject({ priorViewingSeconds: 10 });
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
    // An hour needs membership.classes.streamer.minVerifiedViewers (2) distinct viewers.
    expect(rows.map((x) => [x.verifiedOtherViewers, x.eligible])).toEqual([
      [0, false],
      [2, true],
      [1, false],
    ]);
    expect(r).toEqual({ updated: 2, eligible: 1 });

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
      [1, false],
      [0, false],
    ]);
  });

  test("viewers on the streamer's network count against the hour only when time-aligned", async () => {
    // channel() starts the broadcast 3 h ago; judge the hour starting 2 h ago.
    const st = await channel();
    const hourStart = new Date(Math.floor(NOW.getTime() / 3_600_000) * 3_600_000 - 2 * 3_600_000);
    await app
      .insert(s.streamHours)
      .values({ broadcastId: st.broadcastId, channelId: st.channelId, hourStart, liveSeconds: 3600 });
    const inHour = {
      verdict: "verified" as const,
      startedAt: new Date(hourStart.getTime() + 60_000),
      endedAt: new Date(hourStart.getTime() + 1_800_000),
    };
    const homeIp = `home-${crypto.randomUUID()}`;
    const studioIp = `studio-${crypto.randomUUID()}`;
    const oldHomeIp = `oldhome-${crypto.randomUUID()}`;
    const oldStudioIp = `oldstudio-${crypto.randomUUID()}`;
    // The streamer watched (another channel, signed in) from home during the hour: that address is theirs then.
    const elsewhere = await channel();
    await session(elsewhere.channelId, { userId: st.ownerId, ipHash: homeIp, ...inHour });
    // …and from another address six hours earlier: not aligned with this hour.
    await session(elsewhere.channelId, {
      userId: st.ownerId,
      ipHash: oldHomeIp,
      startedAt: new Date(hourStart.getTime() - 6 * 3_600_000),
      endedAt: new Date(hourStart.getTime() - 5.5 * 3_600_000),
    });
    // The stream key used for this broadcast, and an old key last used two days ago.
    await app.insert(s.streamKeys).values([
      {
        channelId: st.channelId,
        keyHash: crypto.randomUUID(),
        prefix: "live_xx",
        lastUsedIpHash: studioIp,
        lastUsedAt: new Date(NOW.getTime() - 3 * 3_600_000 + 60_000),
      },
      {
        channelId: st.channelId,
        keyHash: crypto.randomUUID(),
        prefix: "live_yy",
        lastUsedIpHash: oldStudioIp,
        lastUsedAt: new Date(NOW.getTime() - 48 * 3_600_000),
      },
    ]);
    // Sock puppets: fresh devices and accounts on the streamer's aligned addresses.
    await session(st.channelId, { ipHash: homeIp, ...inHour });
    await session(st.channelId, { userId: await user(), ipHash: studioIp, ...inHour });
    // One genuine viewer.
    await session(st.channelId, { userId: await user(), ...inHour });

    const count = async () =>
      (await app.select().from(s.streamHours).where(eq(s.streamHours.broadcastId, st.broadcastId)))[0]!;
    await markEligibleStreamHours(app, NOW);
    expect(await count()).toMatchObject({ verifiedOtherViewers: 1, eligible: false });

    // Viewers who merely share an address the streamer used at another time do count.
    await session(st.channelId, { userId: await user(), ipHash: oldHomeIp, ...inHour });
    await session(st.channelId, { userId: null, ipHash: oldStudioIp, ...inHour });
    await markEligibleStreamHours(app, NOW);
    expect(await count()).toMatchObject({ verifiedOtherViewers: 3, eligible: true });
  });
});
