// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The rollup against Postgres: figures equal the stored verdicts, rehearsals write nothing, a
 * re-run replaces rows and emits again, an early run waits, and retention keeps totals (and
 * everything under a legal hold).
 */
import { AUDIENCE_SETTLE_SECONDS, GATE_ELIGIBLE } from "@commonair/integrity";
import { ANALYTICS_JOBS, QUEUES } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import type { WorkerContext } from "../src/context.ts";
import { purgeExpiredMinutes, rollupBroadcast } from "../src/jobs/broadcast-rollup.ts";
import { makeUser, setup, type TestEnv } from "./fixtures.ts";

let env: TestEnv;
beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false });
});
afterAll(async () => {
  await env.close();
});

const GB = 1_000_000_000;
const model = { currency: "usd", centsPerGb: { origin: 2, relay: 0.5 } };
const HOUR = 3_600_000;

type Enqueued = { queue: string; name: string; data: unknown; delayMs: number | undefined };
function ctxAt(now: Date, enqueued: Enqueued[] = []): WorkerContext {
  return {
    ...env.worker.ctx,
    now: () => now,
    enqueue: async (queue, name, data, opts) => {
      enqueued.push({ queue, name, data, delayMs: opts?.delayMs });
    },
  };
}

async function broadcastFor(channelId: string, startedAt: Date, endedAt: Date, kind: "live" | "rehearsal" = "live") {
  const [b] = await env.t.db
    .insert(schema.broadcasts)
    .values({ id: uuidv7(), channelId, ingestProtocol: "rtmp", path: `live/${channelId}`, startedAt, endedAt, kind })
    .returning();
  return b!;
}

type Verdict = "pending" | "verified" | "excluded";
async function addSession(
  channelId: string,
  broadcastId: string,
  o: {
    start: Date;
    end: Date | null;
    verdict: Verdict;
    reasons?: string[];
    scored?: boolean;
    source?: "origin" | "relay" | "p2p" | "cdn";
  },
) {
  const [s] = await env.t.db
    .insert(schema.playbackSessions)
    .values({
      id: uuidv7(),
      channelId,
      broadcastId,
      deviceHash: crypto.randomUUID(),
      ipHash: crypto.randomUUID(),
      assignedSource: o.source ?? "origin",
      startedAt: o.start,
      endedAt: o.end,
      verdict: o.verdict,
      verdictReasons: o.reasons ?? [],
      scoredAt: o.scored === false ? null : o.start,
    })
    .returning();
  return s!;
}

async function totalsOf(broadcastId: string) {
  const [t] = await env.t.db
    .select()
    .from(schema.broadcastAudienceTotals)
    .where(eq(schema.broadcastAudienceTotals.broadcastId, broadcastId));
  return t;
}
const minutesOf = (broadcastId: string) =>
  env.t.db
    .select()
    .from(schema.broadcastAudienceMinutes)
    .where(eq(schema.broadcastAudienceMinutes.broadcastId, broadcastId))
    .orderBy(asc(schema.broadcastAudienceMinutes.minute));
const readyEvents = (broadcastId: string) =>
  env.t.db
    .select()
    .from(schema.events)
    .where(
      and(
        eq(schema.events.type, "analytics.rollup.ready"),
        sql`${schema.events.payload}->>'broadcast_id' = ${broadcastId}`,
      ),
    );

/** A broadcast that ended `hoursAgo` ago, one hour long, with a mixed audience. */
async function scenario(hoursAgo = 3) {
  const { channel } = await makeUser(env.t.db);
  // Minute-aligned, so the hour has exactly 60 minute rows.
  const endedAt = new Date(Math.floor((Date.now() - hoursAgo * HOUR) / 60_000) * 60_000);
  const startedAt = new Date(endedAt.getTime() - HOUR);
  const b = await broadcastFor(channel.id, startedAt, endedAt);
  const m = (min: number) => new Date(startedAt.getTime() + min * 60_000);
  const sessions = [
    await addSession(channel.id, b.id, { start: m(0), end: m(30), verdict: "verified" }),
    await addSession(channel.id, b.id, { start: m(10), end: null, verdict: "verified", source: "relay" }),
    await addSession(channel.id, b.id, { start: m(5), end: m(6), verdict: "verified", scored: false }),
    await addSession(channel.id, b.id, {
      start: m(5),
      end: m(25),
      verdict: "verified",
      reasons: ["fetch_unjudged"],
      source: "cdn",
    }),
    await addSession(channel.id, b.id, { start: m(1), end: m(2), verdict: "pending", reasons: ["media_unconfirmed"] }),
  ];
  for (let i = 0; i < 6; i++)
    sessions.push(
      await addSession(channel.id, b.id, {
        start: m(20),
        end: m(50),
        verdict: "excluded",
        reasons: ["datacenter_ip", "headless", "fetch_pattern"],
      }),
    );
  sessions.push(
    await addSession(channel.id, b.id, { start: m(40), end: m(41), verdict: "excluded", reasons: ["headless"] }),
  );
  await env.t.db.insert(schema.egressSamples).values([
    { broadcastId: b.id, bucketStart: m(0), source: "origin", bytes: 3 * GB },
    { broadcastId: b.id, bucketStart: m(1), source: "origin", bytes: GB / 4 },
    { broadcastId: b.id, bucketStart: m(0), source: "relay", bytes: GB },
    { broadcastId: b.id, bucketStart: m(0), source: "cdn", bytes: 7 * GB },
  ]);
  return { channel, b, sessions, m };
}

test("totals equal the stored verdicts: verified seconds are the gate-eligible sessions' seconds", async () => {
  const { b } = await scenario();
  const out = await rollupBroadcast(ctxAt(new Date()), { broadcastId: b.id, reason: "offline" }, { costModel: model });
  expect(out).toMatchObject({ rolledUp: 1, sessions: 12 });

  // The same figures straight from playback_sessions, with open sessions clipped at the end.
  const [expected] = (await env.t.db.execute(sql`
    with s as (
      select ps.*, ${GATE_ELIGIBLE} as eligible,
             floor(extract(epoch from (least(coalesce(ps.ended_at, b.ended_at), b.ended_at)
                                        - greatest(ps.started_at, b.started_at))))::int as secs
        from playback_sessions ps join broadcasts b on b.id = ps.broadcast_id
       where ps.broadcast_id = ${b.id})
    select coalesce(sum(secs) filter (where eligible), 0)::int as verified,
           coalesce(sum(secs) filter (where verdict = 'excluded'), 0)::int as excluded,
           coalesce(sum(secs) filter (where not eligible and verdict <> 'excluded'), 0)::int as unverified
      from s`)) as unknown as { verified: number; excluded: number; unverified: number }[];
  const t = await totalsOf(b.id);
  expect(t).toMatchObject({
    sessions: 12,
    durationSeconds: 3600,
    verifiedViewerSeconds: expected!.verified,
    unverifiedViewerSeconds: expected!.unverified,
    excludedViewerSeconds: expected!.excluded,
    // 30 min origin + 50 min relay (open, clipped at the end).
    verifiedSecondsBySource: { origin: 1800, relay: 3000 },
    excludedSessionsByCategory: { datacenter: 6, automation: 1 },
    excludedSecondsByCategory: { datacenter: 6 * 1800, automation: 60 },
    bytesBySource: { origin: 3.25 * GB, relay: GB, cdn: 7 * GB },
    peakVerifiedConcurrent: 2,
    minutesPurgedAt: null,
  });
  expect(expected!.verified).toBe(4800);

  const minutes = await minutesOf(b.id);
  expect(minutes).toHaveLength(60);
  expect(minutes[20]).toMatchObject({ verified: 2, excluded: 6, excludedByCategory: { datacenter: 6 } });
  // Per minute, verified + unverified + excluded is every session active in it.
  for (const row of minutes) {
    const raw = Object.values(row.rawBySource).reduce((a, n) => a + (n ?? 0), 0);
    expect(row.verified + row.unverified + row.excluded).toBe(raw);
  }

  const [cost] = await env.t.db.select().from(schema.broadcastCosts).where(eq(schema.broadcastCosts.broadcastId, b.id));
  // 3.25 GB × 2 + 1 GB × 0.5 = 7 cents; the CDN is not in the model.
  expect(cost).toMatchObject({ currency: "usd", costCents: 7, model });
  expect(await readyEvents(b.id)).toHaveLength(1);
  // Never a user id, a signal code or a threshold in what the rollup wrote.
  const written = JSON.stringify([t, minutes, cost]);
  for (const code of ["datacenter_ip", "headless", "fetch_pattern", "fetch_unjudged", "media_unconfirmed"])
    expect(written).not.toContain(code);
});

test("a rehearsal writes nothing and emits nothing", async () => {
  const { channel } = await makeUser(env.t.db);
  const endedAt = new Date(Date.now() - 3 * HOUR);
  const b = await broadcastFor(channel.id, new Date(endedAt.getTime() - HOUR), endedAt, "rehearsal");
  await addSession(channel.id, b.id, { start: b.startedAt, end: endedAt, verdict: "verified" });
  expect(await rollupBroadcast(ctxAt(new Date()), { broadcastId: b.id, reason: "test" }, { costModel: model })).toEqual(
    { rehearsal: 1 },
  );
  expect(await totalsOf(b.id)).toBeUndefined();
  expect(await minutesOf(b.id)).toEqual([]);
  expect(await readyEvents(b.id)).toEqual([]);
});

test("a re-run after changed verdicts replaces the rows and emits a second event", async () => {
  const { b, sessions } = await scenario();
  const ctx = ctxAt(new Date());
  await rollupBroadcast(ctx, { broadcastId: b.id, reason: "offline" }, { costModel: model });
  const before = await totalsOf(b.id);
  // A group appeal overturned the datacenter group: those sessions are verified now.
  const swarm = sessions.filter((s) => s.verdict === "excluded" && s.verdictReasons[0] === "datacenter_ip");
  for (const s of swarm)
    await env.t.db
      .update(schema.playbackSessions)
      .set({ verdict: "verified", verdictReasons: ["allowed_on_appeal"] })
      .where(eq(schema.playbackSessions.id, s.id));
  await rollupBroadcast(ctx, { broadcastId: b.id, reason: "rescore" }, { costModel: model });
  const after = await totalsOf(b.id);
  expect(after!.verifiedViewerSeconds).toBe(before!.verifiedViewerSeconds + 6 * 1800);
  expect(after!.excludedSessionsByCategory).toEqual({ automation: 1 });
  expect(await minutesOf(b.id)).toHaveLength(60);
  const events = await readyEvents(b.id);
  expect(events.map((e) => (e.payload as { reason: string }).reason).sort()).toEqual(["offline", "rescore"]);
});

test("re-running with unchanged data writes the same rows (and emits again)", async () => {
  const { b } = await scenario();
  const ctx = ctxAt(new Date());
  await rollupBroadcast(ctx, { broadcastId: b.id, reason: "offline" }, { costModel: model });
  const strip = <T extends { rolledUpAt: Date }>(t: T | undefined) => ({ ...t, rolledUpAt: null });
  const first = { totals: strip(await totalsOf(b.id)), minutes: await minutesOf(b.id) };
  await rollupBroadcast(ctx, { broadcastId: b.id, reason: "offline" }, { costModel: model });
  expect({ totals: strip(await totalsOf(b.id)), minutes: await minutesOf(b.id) }).toEqual(first);
  expect(await readyEvents(b.id)).toHaveLength(2);
});

test("before the settle time it waits for the rest; the test override and a re-score run at once", async () => {
  const { b } = await scenario(0.5);
  const enqueued: Enqueued[] = [];
  const now = new Date();
  const ctx = ctxAt(now, enqueued);
  expect(await rollupBroadcast(ctx, { broadcastId: b.id, reason: "offline" }, { costModel: model })).toEqual({
    deferred: 1,
  });
  expect(enqueued).toHaveLength(1);
  expect(enqueued[0]).toMatchObject({ queue: QUEUES.analytics, name: ANALYTICS_JOBS.broadcastRollup });
  expect(enqueued[0]!.delayMs).toBe(b.endedAt!.getTime() + AUDIENCE_SETTLE_SECONDS * 1000 - now.getTime());
  expect(await totalsOf(b.id)).toBeUndefined();

  await rollupBroadcast(ctx, { broadcastId: b.id, reason: "test", settleSeconds: 0 }, { costModel: model });
  expect(await totalsOf(b.id)).toBeDefined();
  expect(await rollupBroadcast(ctx, { broadcastId: b.id, reason: "rescore" }, { costModel: model })).toMatchObject({
    rolledUp: 1,
  });
  expect(enqueued).toHaveLength(1);
});

test("a live broadcast, a missing one and one past retention are not rolled up", async () => {
  const { channel } = await makeUser(env.t.db);
  const [live] = await env.t.db
    .insert(schema.broadcasts)
    .values({ id: uuidv7(), channelId: channel.id, ingestProtocol: "rtmp", path: "live/x", startedAt: new Date() })
    .returning();
  const ctx = ctxAt(new Date());
  expect(await rollupBroadcast(ctx, { broadcastId: live!.id, reason: "test" }, { costModel: model })).toEqual({
    live: 1,
  });
  expect(await rollupBroadcast(ctx, { broadcastId: uuidv7(), reason: "test" }, { costModel: model })).toEqual({
    missing: 1,
  });
  const old = await broadcastFor(
    channel.id,
    new Date(Date.now() - 92 * 24 * HOUR),
    new Date(Date.now() - 91 * 24 * HOUR),
  );
  expect(await rollupBroadcast(ctx, { broadcastId: old.id, reason: "rescore" }, { costModel: model })).toEqual({
    final: 1,
  });
});

test("retention deletes old per-minute rows, keeps totals and marks them final; a legal hold keeps everything", async () => {
  const { b } = await scenario();
  const held = await scenario();
  await rollupBroadcast(ctxAt(new Date()), { broadcastId: b.id, reason: "test" }, { costModel: model });
  await rollupBroadcast(ctxAt(new Date()), { broadcastId: held.b.id, reason: "test" }, { costModel: model });
  await env.t.db.insert(schema.legalHolds).values({ id: uuidv7(), userId: held.channel.ownerId, reason: "test hold" });

  const later = new Date(b.endedAt!.getTime() + 91 * 24 * HOUR);
  expect(await purgeExpiredMinutes(env.worker.ctx, later)).toBeGreaterThanOrEqual(1);
  expect(await minutesOf(b.id)).toEqual([]);
  const t = await totalsOf(b.id);
  expect(t!.minutesPurgedAt?.getTime()).toBe(later.getTime());
  expect(t!.verifiedViewerSeconds).toBe(4800);
  expect(await minutesOf(held.b.id)).toHaveLength(60);
  expect((await totalsOf(held.b.id))!.minutesPurgedAt).toBeNull();

  // Final: a re-score no longer re-rolls it (attestations cite it), whatever the clock says.
  expect(
    await rollupBroadcast(ctxAt(new Date()), { broadcastId: b.id, reason: "rescore" }, { costModel: model }),
  ).toEqual({ final: 1 });
  expect(await rollupBroadcast(ctxAt(later), { broadcastId: b.id, reason: "rescore" }, { costModel: model })).toEqual({
    final: 1,
  });
});
