// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `rescoreExclusionGroup` against real Postgres, as the application role. */
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { schema as s, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { rescoreExclusionGroup } from "../src/rescore.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let app: Database;
const NOW = new Date();
const HOUR = 3_600_000;

beforeAll(async () => {
  t = await createTestDatabase();
  app = t.app.db;
});
afterAll(async () => {
  await t?.drop();
});

let seq = 0;
async function user(db: Database = app): Promise<string> {
  const name = `ru${++seq}`;
  const [u] = await db
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: s.users.id });
  return u!.id;
}

async function broadcast(db: Database = app) {
  const ownerId = await user(db);
  const [c] = await db
    .insert(s.channels)
    .values({ ownerId, slug: `rc${seq}`, displayName: `RC${seq}` })
    .returning({ id: s.channels.id });
  const mk = async () => {
    const [b] = await db
      .insert(s.broadcasts)
      .values({
        channelId: c!.id,
        ingestProtocol: "rtmp",
        path: `live/rc${seq}`,
        startedAt: new Date(NOW.getTime() - 30 * HOUR),
        endedAt: new Date(NOW.getTime() - 29 * HOUR),
      })
      .returning({ id: s.broadcasts.id });
    return b!.id;
  };
  return { ownerId, channelId: c!.id, broadcastId: await mk(), otherBroadcastId: await mk() };
}

type Ctx = Awaited<ReturnType<typeof broadcast>>;

async function session(
  ctx: Ctx,
  reasons: string[],
  o: Partial<typeof s.playbackSessions.$inferInsert> = {},
  db: Database = app,
): Promise<string> {
  const [p] = await db
    .insert(s.playbackSessions)
    .values({
      channelId: ctx.channelId,
      broadcastId: ctx.broadcastId,
      deviceHash: `dev-${crypto.randomUUID()}`,
      ipHash: `ip-${crypto.randomUUID()}`,
      startedAt: new Date(NOW.getTime() - 29.8 * HOUR),
      endedAt: new Date(NOW.getTime() - 29.2 * HOUR),
      heartbeats: 20,
      verdict: "excluded",
      verdictReasons: reasons,
      score: 0.9,
      scoredAt: new Date(NOW.getTime() - 29 * HOUR),
      ...o,
    })
    .returning({ id: s.playbackSessions.id });
  const id = p!.id;
  // As the scorer stores them; the seeded threshold is 0.7.
  const scores: Record<string, number> = {
    datacenter_ip: 0.6,
    headless: 0.8,
    device_concurrency: 0.9,
    fetch_pattern: 0.5,
    heartbeat_inconsistent: 0.45,
  };
  const signals = reasons.filter((r) => r in scores);
  if (signals.length)
    await db.insert(s.integrityFlags).values(
      signals.map((signal) => ({
        subjectType: "session" as const,
        subjectId: id,
        channelId: ctx.channelId,
        signal,
        score: scores[signal]!,
        decision: "excluded" as const,
      })),
    );
  return id;
}

const verdicts = async (ids: string[], db: Database = app) =>
  Object.fromEntries(
    (
      await db
        .select({
          id: s.playbackSessions.id,
          verdict: s.playbackSessions.verdict,
          reasons: s.playbackSessions.verdictReasons,
          score: s.playbackSessions.score,
        })
        .from(s.playbackSessions)
        .where(inArray(s.playbackSessions.id, ids))
    ).map((r) => [r.id, r]),
  );

describe("rescoreExclusionGroup", () => {
  test("changes exactly the covered sessions, allows their flags, audits and writes the event", async () => {
    const ctx = await broadcast();
    const staff = await user();
    const only = await session(ctx, ["datacenter_ip"]);
    const moves = await session(ctx, ["datacenter_ip", "headless"]);
    const unjudged = await session(ctx, ["datacenter_ip", "fetch_unjudged"]);
    const few = await session(ctx, ["datacenter_ip"], { heartbeats: 1 });
    const otherCat = await session(ctx, ["headless", "datacenter_ip"]);
    const later = await session(ctx, ["datacenter_ip"], {
      startedAt: new Date(NOW.getTime() + 60_000),
      endedAt: new Date(NOW.getTime() + 120_000),
    });
    const open = await session(ctx, ["datacenter_ip"], { endedAt: null });
    const verified = await session(ctx, [], { verdict: "verified" });
    const elsewhere = await session(ctx, ["datacenter_ip"], { broadcastId: ctx.otherBroadcastId });
    const all = [only, moves, unjudged, few, otherCat, later, open, verified, elsewhere];
    const before = await verdicts(all);

    const r = await app.transaction((tx) =>
      rescoreExclusionGroup(tx, {
        broadcastId: ctx.broadcastId,
        category: "datacenter",
        decidedAt: NOW,
        decidedById: staff,
        appealId: "01900000-0000-7000-8000-00000000a001",
      }),
    );
    expect(r).toEqual({ rescored: 5, restored: 4 });

    const after = await verdicts(all);
    expect(after[only]).toMatchObject({ verdict: "verified", reasons: ["allowed_on_appeal"], score: 0 });
    expect(after[moves]).toMatchObject({ verdict: "excluded", reasons: ["headless", "allowed_on_appeal"], score: 0.8 });
    expect(after[unjudged]).toMatchObject({ verdict: "verified", reasons: ["allowed_on_appeal", "fetch_unjudged"] });
    expect(after[few]).toMatchObject({ verdict: "pending", reasons: ["allowed_on_appeal", "insufficient_heartbeats"] });
    // Still open on an ended broadcast: it ended with the broadcast, so it is covered.
    expect(after[open]).toMatchObject({ verdict: "verified", reasons: ["allowed_on_appeal"] });
    for (const id of [otherCat, later, verified, elsewhere]) expect(after[id]).toEqual(before[id]);

    const flags = await app
      .select({ subjectId: s.integrityFlags.subjectId, signal: s.integrityFlags.signal, d: s.integrityFlags.decision })
      .from(s.integrityFlags)
      .where(inArray(s.integrityFlags.subjectId, all));
    const allowed = flags.filter((f) => f.d === "allowed");
    expect(allowed.map((f) => f.subjectId).sort()).toEqual([only, moves, unjudged, few, open].sort());
    expect(new Set(allowed.map((f) => f.signal))).toEqual(new Set(["datacenter_ip"]));
    expect(flags.find((f) => f.subjectId === moves && f.signal === "headless")?.d).toBe("excluded");

    const audits = await app
      .select()
      .from(s.auditLog)
      .where(and(eq(s.auditLog.channelId, ctx.channelId), inArray(s.auditLog.subjectId, all)));
    expect(audits).toHaveLength(5);
    expect(audits.filter((a) => a.action === "integrity.session.restore")).toHaveLength(4);
    expect(audits.find((a) => a.subjectId === moves)).toMatchObject({
      action: "integrity.session.rescore",
      actorType: "system",
      reason: "allowed_on_appeal",
      details: { broadcastId: ctx.broadcastId, category: "datacenter", verdict: "excluded" },
    });

    const events = await app.select().from(s.events).where(eq(s.events.type, "integrity.sessions.rescored"));
    const mine = events.filter((e) => (e.payload as { broadcast_id: string }).broadcast_id === ctx.broadcastId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      channelId: ctx.channelId,
      payload: { broadcast_id: ctx.broadcastId, channel_id: ctx.channelId, sessions: 5 },
    });

    // A second overturn of the same group finds nothing left: no write, no event.
    const again = await app.transaction((tx) =>
      rescoreExclusionGroup(tx, { broadcastId: ctx.broadcastId, category: "datacenter", decidedAt: NOW }),
    );
    expect(again).toEqual({ rescored: 0, restored: 0 });
    expect(await verdicts(all)).toEqual(after);
    const events2 = await app.select().from(s.events).where(eq(s.events.type, "integrity.sessions.rescored"));
    expect(
      events2.filter((e) => (e.payload as { broadcast_id: string }).broadcast_id === ctx.broadcastId),
    ).toHaveLength(1);
  });

  // CI run 41305101320: the harness swarm's concurrency group (viewbots sharing a device, also
  // headless) was overturned and none of its sessions became verified. They carry another
  // category's signal, so they stay excluded and move to that group, as specified.
  test("a concurrency group whose sessions are also headless moves to automation, none verified", async () => {
    const ctx = await broadcast();
    const bots = await Promise.all(
      Array.from({ length: 6 }, () => session(ctx, ["device_concurrency", "headless", "fetch_pattern"])),
    );
    const r = await app.transaction((tx) =>
      rescoreExclusionGroup(tx, { broadcastId: ctx.broadcastId, category: "concurrency", decidedAt: NOW }),
    );
    expect(r).toEqual({ rescored: 6, restored: 0 });
    const after = await verdicts(bots);
    for (const id of bots)
      expect(after[id]).toMatchObject({
        verdict: "excluded",
        reasons: ["headless", "fetch_pattern", "allowed_on_appeal"],
        // 1 − 0.2 · 0.5: still over the 0.7 threshold.
        score: 0.9,
      });
  });

  // Batch 7 decision (g): what is left is weighed against the live scorer's threshold.
  test("an overturn moves the sessions now under the threshold and keeps those still over it", async () => {
    const ctx = await broadcast();
    const staff = await user();
    // 0.5 left: under 0.7.
    const under = await session(ctx, ["datacenter_ip", "fetch_pattern"]);
    // 1 − 0.5 · 0.55 = 0.725 left: over 0.7, now a playback-pattern exclusion.
    const over = await session(ctx, ["datacenter_ip", "fetch_pattern", "heartbeat_inconsistent"]);
    // 0.8 left: over, now an automation exclusion.
    const headless = await session(ctx, ["datacenter_ip", "headless"]);
    // Under the threshold but with too few heartbeats: pending, the signal still listed.
    const few = await session(ctx, ["datacenter_ip", "fetch_pattern"], { heartbeats: 2 });
    const r = await app.transaction((tx) =>
      rescoreExclusionGroup(tx, {
        broadcastId: ctx.broadcastId,
        category: "datacenter",
        decidedAt: NOW,
        decidedById: staff,
      }),
    );
    expect(r).toEqual({ rescored: 4, restored: 2 });
    const after = await verdicts([under, over, headless, few]);
    expect(after[under]).toMatchObject({ verdict: "verified", reasons: ["fetch_pattern", "allowed_on_appeal"] });
    expect(after[under]?.score).toBeCloseTo(0.5, 6);
    expect(after[over]).toMatchObject({
      verdict: "excluded",
      reasons: ["fetch_pattern", "heartbeat_inconsistent", "allowed_on_appeal"],
    });
    expect(after[over]?.score).toBeCloseTo(0.725, 6);
    expect(after[headless]).toMatchObject({ verdict: "excluded", reasons: ["headless", "allowed_on_appeal"] });
    expect(after[few]).toMatchObject({
      verdict: "pending",
      reasons: ["fetch_pattern", "allowed_on_appeal", "insufficient_heartbeats"],
    });

    // Only the overturned category's flags are allowed; the remainder's stay as the scorer left them.
    const flags = await app
      .select({ subjectId: s.integrityFlags.subjectId, signal: s.integrityFlags.signal, d: s.integrityFlags.decision })
      .from(s.integrityFlags)
      .where(inArray(s.integrityFlags.subjectId, [under, over, headless, few]));
    for (const f of flags) expect(f.d, `${f.signal}`).toBe(f.signal === "datacenter_ip" ? "allowed" : "excluded");

    // The audit rows record what was weighed: the remainder's score and the threshold in force.
    const audits = await app
      .select()
      .from(s.auditLog)
      .where(inArray(s.auditLog.subjectId, [under, over]));
    expect(audits.find((a) => a.subjectId === under)).toMatchObject({
      action: "integrity.session.restore",
      details: { verdict: "verified", threshold: 0.7, score: 0.5 },
    });
    expect(audits.find((a) => a.subjectId === over)).toMatchObject({
      action: "integrity.session.rescore",
      details: { verdict: "excluded", threshold: 0.7 },
    });
  });

  test("the threshold is the governance setting in force, not a constant", async () => {
    // Only a passed proposal changes the setting, so the lower threshold is an instance bootstrapped
    // with it (its own database).
    const low = await createTestDatabase({ governance: { "integrity.thresholds": { sessionExcludeScore: 0.5 } } });
    try {
      const reasons = ["device_concurrency", "datacenter_ip"];
      const seeded = await broadcast();
      const kept = await session(seeded, reasons);
      const lowCtx = await broadcast(low.app.db);
      const crossed = await session(lowCtx, reasons, {}, low.app.db);
      const rescore = (db: Database, broadcastId: string) =>
        db.transaction((tx) => rescoreExclusionGroup(tx, { broadcastId, category: "concurrency", decidedAt: NOW }));
      // 0.6 left: under the seeded 0.7, over 0.5.
      expect(await rescore(app, seeded.broadcastId)).toEqual({ rescored: 1, restored: 1 });
      expect((await verdicts([kept]))[kept]).toMatchObject({
        verdict: "verified",
        reasons: ["datacenter_ip", "allowed_on_appeal"],
      });
      expect(await rescore(low.app.db, lowCtx.broadcastId)).toEqual({ rescored: 1, restored: 0 });
      expect((await verdicts([crossed], low.app.db))[crossed]).toMatchObject({
        verdict: "excluded",
        reasons: ["datacenter_ip", "allowed_on_appeal"],
      });
    } finally {
      await low.drop();
    }
  });

  test("on a live broadcast only closed sessions are covered", async () => {
    const ctx = await broadcast();
    await app.update(s.broadcasts).set({ endedAt: null }).where(eq(s.broadcasts.id, ctx.broadcastId));
    const closed = await session(ctx, ["datacenter_ip"]);
    const open = await session(ctx, ["datacenter_ip"], { endedAt: null });
    const r = await app.transaction((tx) =>
      rescoreExclusionGroup(tx, { broadcastId: ctx.broadcastId, category: "datacenter", decidedAt: NOW }),
    );
    expect(r).toEqual({ rescored: 1, restored: 1 });
    const v = await verdicts([closed, open]);
    expect(v[closed]?.verdict).toBe("verified");
    expect(v[open]?.verdict).toBe("excluded");
  });

  test("an empty group or an unknown broadcast changes nothing", async () => {
    const ctx = await broadcast();
    const keep = await session(ctx, ["headless"]);
    const r = await app.transaction((tx) =>
      rescoreExclusionGroup(tx, { broadcastId: ctx.broadcastId, category: "datacenter", decidedAt: NOW }),
    );
    expect(r).toEqual({ rescored: 0, restored: 0 });
    expect((await verdicts([keep]))[keep]).toMatchObject({ verdict: "excluded", reasons: ["headless"] });
    const none = await app.transaction((tx) =>
      rescoreExclusionGroup(tx, {
        broadcastId: "01900000-0000-7000-8000-0000000000ff",
        category: "datacenter",
        decidedAt: NOW,
      }),
    );
    expect(none).toEqual({ rescored: 0, restored: 0 });
  });

  test("rolls back with the caller's transaction", async () => {
    const ctx = await broadcast();
    const id = await session(ctx, ["datacenter_ip"]);
    await expect(
      app.transaction(async (tx) => {
        await rescoreExclusionGroup(tx, { broadcastId: ctx.broadcastId, category: "datacenter", decidedAt: NOW });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect((await verdicts([id]))[id]).toMatchObject({ verdict: "excluded" });
    const audits = await app.select().from(s.auditLog).where(eq(s.auditLog.subjectId, id));
    expect(audits).toHaveLength(0);
  });
});
