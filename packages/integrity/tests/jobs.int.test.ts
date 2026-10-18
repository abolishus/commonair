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

  test("fetch-less heartbeat sessions never verify; part-only, CDN and receipt-less relay sessions are fine", async () => {
    const { channelId } = await channel();
    // Heartbeats claim 60 s of playback; the database counter saw no segment and no counters exist.
    const dbZero = await session(channelId, { segmentsFetched: 0 });
    await humanHistory(dbZero);
    // Origin counters exist (the consumer saw this token) and show no media at all.
    const known = await session(channelId, { segmentsFetched: 0 });
    await humanHistory(known);
    for (let i = 0; i < 5; i++) await recordFetch(valkey, { sid: known, kind: "playlist" });
    // A low-latency player: parts only, zero full segments.
    const llhls = await session(channelId, { segmentsFetched: 0 });
    await humanHistory(llhls);
    for (let i = 0; i < 60; i++) await recordFetch(valkey, { sid: llhls, kind: "playlist" });
    for (let i = 0; i < 290; i++) await recordFetch(valkey, { sid: llhls, kind: "part" });
    // CDN delivery has no per-session accounting.
    const cdn = await session(channelId, { assignedSource: "cdn", segmentsFetched: 0 });
    await humanHistory(cdn);

    // Relay sessions: judged by their relay's receipts.
    const relayId = await relayNode();
    const relayBot = await session(channelId, { assignedSource: "relay", relayId, segmentsFetched: 0 });
    const relayViewer = await session(channelId, { assignedSource: "relay", relayId, segmentsFetched: 0 });
    for (const id of [relayBot, relayViewer]) await humanHistory(id);
    const start = new Date(NOW.getTime() - 120_000);
    const end = new Date(NOW.getTime() - 10_000);
    const nonce = crypto.randomUUID();
    await app.insert(s.relayReceipts).values({
      relayId,
      nonce,
      periodStart: start,
      periodEnd: end,
      bytesReported: 1000,
      segmentsReported: 300,
      tokensReported: 1,
      payload: {
        v: 1,
        relayId,
        nonce,
        periodStart: start.toISOString(),
        periodEnd: end.toISOString(),
        entries: [{ sessionId: relayViewer, segments: 300, bytes: 1000 }],
      },
      signature: "sig",
      status: "verified",
    });
    const silentRelay = await relayNode();
    const unaccounted = await session(channelId, { assignedSource: "relay", relayId: silentRelay, segmentsFetched: 0 });
    await humanHistory(unaccounted);

    const r = await scoreActiveSessions(app, valkey, NOW);

    expect(await sessionRow(dbZero)).toMatchObject({ verdict: "pending", verdictReasons: ["media_unconfirmed"] });
    expect(await sessionRow(known)).toMatchObject({ verdict: "excluded", verdictReasons: ["fetch_pattern"] });
    expect((await flagsFor(known))[0]!.details).toMatchObject({ checks: ["no_media_fetched"] });
    expect(await sessionRow(llhls)).toMatchObject({ verdict: "verified", verdictReasons: [] });
    expect(await sessionRow(cdn)).toMatchObject({ verdict: "verified", verdictReasons: [] });
    expect(await sessionRow(relayBot)).toMatchObject({ verdict: "excluded", verdictReasons: ["fetch_pattern"] });
    expect(await sessionRow(relayViewer)).toMatchObject({ verdict: "verified", verdictReasons: [] });
    expect(await sessionRow(unaccounted)).toMatchObject({ verdict: "verified" });
    expect(r.newlyExcluded).toEqual(expect.arrayContaining([known, relayBot]));
    expect(r.newlyExcluded).not.toContain(dbZero);
  });

  test("a reload supersedes the stale session: it ends, and neither is counted as a duplicate", async () => {
    const { channelId } = await channel();
    const other = await channel();
    const device = `reload-${crypto.randomUUID()}`;
    // Two other live tabs on the same device (another channel) use up most of the allowance (3).
    const tabs = [
      await session(other.channelId, { deviceHash: device, startedAt: new Date(NOW.getTime() - 900_000) }),
      await session(other.channelId, { deviceHash: device, startedAt: new Date(NOW.getTime() - 800_000) }),
    ];
    const lastBeat = new Date(NOW.getTime() - 70_000);
    const stale = await session(channelId, {
      deviceHash: device,
      startedAt: new Date(NOW.getTime() - 600_000),
      lastHeartbeatAt: lastBeat,
      verdict: "verified",
    });
    const reload = await session(channelId, { deviceHash: device, startedAt: new Date(NOW.getTime() - 65_000) });
    for (const id of [...tabs, stale, reload]) await humanHistory(id);
    await valkey.zadd(`viewers:${channelId}`, NOW.getTime() - 70_000, stale);

    const r = await scoreActiveSessions(app, valkey, NOW);

    expect(r.superseded).toEqual([stale]);
    const staleRow = await sessionRow(stale);
    expect(staleRow.endedAt?.getTime()).toBe(lastBeat.getTime());
    expect(staleRow.verdict).not.toBe("excluded");
    expect(await sessionRow(reload)).toMatchObject({ verdict: "verified", verdictReasons: [] });
    for (const id of tabs) expect((await sessionRow(id)).verdict).toBe("verified");
    expect(await valkey.zscore(`viewers:${channelId}`, stale)).toBeNull();
    // Idempotent: nothing left to supersede.
    expect((await scoreActiveSessions(app, valkey, NOW)).superseded).toEqual([]);
  });

  test("appeal overturns and allowed flags stick unless new evidence arrives", async () => {
    // Flags are stamped with the database clock, so this test runs on wall-clock time.
    const T = new Date();
    const live = { startedAt: new Date(T.getTime() - 120_000), lastHeartbeatAt: new Date(T.getTime() - 5_000) };
    const { channelId } = await channel();
    const viewer = await user();
    const hosted = { datacenter: "TEST-NET-3 (sample hosting)", fingerprint: { ...DESKTOP_FP, webdriver: true } };
    const appealed = await session(channelId, { userId: viewer, ...hosted, ...live });
    const cleared = await session(channelId, { ...hosted, ...live });
    for (const id of [appealed, cleared]) await humanHistory(id);
    await scoreActiveSessions(app, valkey, T);
    expect((await sessionRow(appealed)).verdict).toBe("excluded");
    expect((await sessionRow(cleared)).verdict).toBe("excluded");

    // The appeal is overturned (the resolver does not touch the verdict); an admin clears one of two flags.
    const decidedAt = new Date(Date.now() + 1_000);
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
        startedAt: new Date(T.getTime() - 60_000 + i * 1000),
        lastHeartbeatAt: live.lastHeartbeatAt,
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

  test("an account-level overturn covers the account's later sessions too", async () => {
    const T = new Date();
    const live = { startedAt: new Date(T.getTime() - 120_000), lastHeartbeatAt: new Date(T.getTime() - 5_000) };
    const { channelId } = await channel();
    const viewer = await user();
    const hosted = { datacenter: "TEST-NET-3 (sample hosting)", fingerprint: { ...DESKTOP_FP, webdriver: true } };
    const first = await session(channelId, { userId: viewer, ...hosted, ...live, endedAt: live.lastHeartbeatAt });
    await humanHistory(first);
    await scoreActiveSessions(app, valkey, T);
    expect((await sessionRow(first)).verdict).toBe("excluded");
    const resolvedAt = new Date(Date.now() + 1_000);
    await app.insert(s.appeals).values({
      appellantId: viewer,
      kind: "integrity",
      subjectType: "user",
      subjectId: viewer,
      body: "My whole household uses this VPN.",
      status: "overturned",
      resolvedAt,
    });
    const next = await session(channelId, { userId: viewer, ...hosted, ...live });
    await humanHistory(next);
    await scoreActiveSessions(app, valkey, new Date(resolvedAt.getTime() + 1_000));
    expect(await sessionRow(next)).toMatchObject({ verdict: "verified", verdictReasons: ["allowed_on_appeal"] });
    // Another account with the same setup is still excluded.
    const stranger = await session(channelId, { userId: await user(), ...hosted, ...live });
    await humanHistory(stranger);
    await scoreActiveSessions(app, valkey, new Date(resolvedAt.getTime() + 2_000));
    expect((await sessionRow(stranger)).verdict).toBe("excluded");
  });
});

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
    expect(again).toEqual({ verified: 0, rejected: 0, unknown: 0, suspendedRelays: [] });
    // Once the grace period passes, the late receipt is checked.
    const later = await verifyReceipts(app, new Date(NOW.getTime() + 5 * 60_000));
    expect(later.verified).toBe(1);
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
      startedAt: new Date(NOW.getTime() - 30 * 60_000),
      lastHeartbeatAt: new Date(NOW.getTime() - 5_000),
    });
    // Origin restarted: no issuance rows at all for these minutes.
    const gap1 = await period(r, 12, null, 5000);
    const gap2 = await period(r, 11, null, 5000);
    // Production record lost: a row with sessions but no bytes.
    await app
      .insert(s.relayIssuance)
      .values({ relayId: r, bucketStart: minute(10), sessions: 1, segmentTokens: 0, bytesIssued: 0 });
    const lost = await period(r, 10, null, 5000);
    // Complete issuance is still checked as usual.
    const ok = await period(r, 9, 1000, 1050);

    const res = await verifyReceipts(app, NOW);
    for (const id of [gap1, gap2, lost]) {
      expect(await receipt(id)).toMatchObject({ status: "verified", bytesVerified: 0, overReportRatio: null });
    }
    expect(await receipt(ok)).toMatchObject({ status: "verified", bytesVerified: 1000 });
    expect(res.unknown).toBe(3);
    expect(res.suspendedRelays).not.toContain(r);
    expect((await relayRow(r)).status).toBe("active");
    const unknownFlags = await app
      .select()
      .from(s.integrityFlags)
      .where(and(eq(s.integrityFlags.subjectId, r), eq(s.integrityFlags.signal, "relay_issuance_unknown")));
    expect(unknownFlags).toHaveLength(3);
    expect(unknownFlags[0]).toMatchObject({ decision: "pending_review" });
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

  test("viewers on the streamer's own network (watch address or ingest address) do not count", async () => {
    const st = await channel();
    const hourStart = new Date(Math.floor(NOW.getTime() / 3_600_000) * 3_600_000 - 5 * 3_600_000);
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
    // The streamer once watched from home (any channel, signed in): that address is theirs.
    const elsewhere = await channel();
    await session(elsewhere.channelId, { userId: st.ownerId, ipHash: homeIp, ...inHour });
    // The stream key was last used from the studio.
    await app.insert(s.streamKeys).values({
      channelId: st.channelId,
      keyHash: crypto.randomUUID(),
      prefix: "live_xx",
      lastUsedIpHash: studioIp,
    });
    // Sock puppets: fresh devices and accounts on the streamer's addresses.
    await session(st.channelId, { ipHash: homeIp, ...inHour });
    await session(st.channelId, { userId: await user(), ipHash: studioIp, ...inHour });
    // One genuine viewer.
    await session(st.channelId, { userId: await user(), ...inHour });

    const count = async () =>
      (await app.select().from(s.streamHours).where(eq(s.streamHours.broadcastId, st.broadcastId)))[0]!;
    await markEligibleStreamHours(app, NOW);
    expect(await count()).toMatchObject({ verifiedOtherViewers: 1, eligible: false });

    // A second genuine viewer makes the hour count.
    await session(st.channelId, { userId: null, ...inHour });
    await markEligibleStreamHours(app, NOW);
    expect(await count()).toMatchObject({ verifiedOtherViewers: 2, eligible: true });
  });
});
