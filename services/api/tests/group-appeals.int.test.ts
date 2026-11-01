// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Group exclusion appeals over HTTP (`appeals.create` / `appeals.resolve` with subject
 * `exclusion_group`, batch 6 decision (m)) against rollup rows and sessions written here:
 * ownership, the hidden group, the display delay, the per-broadcast and per-channel limits
 * (concurrent creates included), and what an overturn and a rejection change.
 */
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { assertSafeDetails } from "../src/events/audit.ts";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Person = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface AppealDto {
  id: string;
  kind: string;
  subjectType: string;
  subjectId: string;
  exclusionCategory: string | null;
  status: string;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BODY = "These viewers are a school network watching together.";

let api: TestApi;
let mod: Person;
const db = () => api.db.db;

beforeAll(async () => {
  api = await startApi({ env: { OPS_TEST_HOOKS: "true" } });
  mod = await signUpAndSignIn(api);
  await db().update(schema.users).set({ role: "moderator" }).where(eq(schema.users.id, mod.userId));
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

async function owner() {
  const p = await signUpAndSignIn(api);
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.ownerId, p.userId));
  return { ...p, channelId: c!.id };
}
type Owner = Awaited<ReturnType<typeof owner>>;

/**
 * A broadcast of `o`'s channel that ended `endedHoursAgo` ago, with excluded sessions per reason
 * list and the matching rollup row (unless `rollup: false`).
 */
async function seed(
  o: Owner,
  opts: {
    endedHoursAgo?: number;
    live?: boolean;
    kind?: "live" | "rehearsal";
    rollup?: boolean;
    sessions?: { reasons: string[]; n: number; verdict?: "excluded" | "verified" }[];
  } = {},
) {
  const endedAt = new Date(Date.now() - (opts.endedHoursAgo ?? 30) * HOUR);
  const startedAt = new Date(endedAt.getTime() - HOUR);
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({
      id: uuidv7(),
      channelId: o.channelId,
      ingestProtocol: "rtmp",
      path: `live/${o.username}`,
      kind: opts.kind ?? "live",
      startedAt,
      endedAt: opts.live ? null : endedAt,
    })
    .returning();
  const groups = opts.sessions ?? [{ reasons: ["datacenter_ip"], n: 6 }];
  const ids: Record<string, string[]> = {};
  for (const g of groups) {
    const key = `${g.verdict ?? "excluded"}:${g.reasons.join(",")}`;
    ids[key] = [];
    for (let i = 0; i < g.n; i++) {
      const [p] = await db()
        .insert(schema.playbackSessions)
        .values({
          channelId: o.channelId,
          broadcastId: b!.id,
          deviceHash: `dev-${crypto.randomUUID()}`,
          ipHash: `ip-${crypto.randomUUID()}`,
          startedAt: new Date(startedAt.getTime() + 60_000),
          endedAt: new Date(endedAt.getTime() - 60_000),
          heartbeats: 20,
          verdict: g.verdict ?? "excluded",
          verdictReasons: g.reasons,
          score: 0.8,
          scoredAt: endedAt,
        })
        .returning({ id: schema.playbackSessions.id });
      ids[key]!.push(p!.id);
      const signal = g.reasons[0];
      if (signal && (g.verdict ?? "excluded") === "excluded")
        await db().insert(schema.integrityFlags).values({
          subjectType: "session",
          subjectId: p!.id,
          channelId: o.channelId,
          signal,
          score: 0.8,
          decision: "excluded",
        });
    }
  }
  // The rollup's attribution: a session's category is its first reason's.
  const CAT: Record<string, string> = { datacenter_ip: "datacenter", headless: "automation" };
  const byCat: Record<string, number> = {};
  for (const g of groups) {
    if ((g.verdict ?? "excluded") !== "excluded") continue;
    const c = CAT[g.reasons[0] ?? ""] ?? "other";
    byCat[c] = (byCat[c] ?? 0) + g.n;
  }
  if (opts.rollup !== false)
    await db()
      .insert(schema.broadcastAudienceTotals)
      .values({
        broadcastId: b!.id,
        channelId: o.channelId,
        durationSeconds: 3600,
        sessions: groups.reduce((a, g) => a + g.n, 0),
        peakVerifiedConcurrent: 1,
        verifiedViewerSeconds: 0,
        unverifiedViewerSeconds: 0,
        excludedViewerSeconds: 0,
        excludedSecondsByCategory: Object.fromEntries(Object.entries(byCat).map(([k, n]) => [k, n * 60])),
        excludedSessionsByCategory: byCat,
      });
  return { broadcastId: b!.id, ids };
}

const create = (who: Person, broadcastId: string, category = "datacenter") =>
  who.client.call<AppealDto & { code?: string; data?: { retryAfterSeconds?: number; requirement?: string } }>(
    "POST",
    "/api/appeals",
    { kind: "integrity", subjectType: "exclusion_group", subjectId: broadcastId, category, body: BODY },
  );

const resolve = (id: string, status: "upheld" | "overturned") =>
  mod.client.call<AppealDto>("POST", `/api/admin/appeals/${id}`, { status, resolution: "Reviewed the group." });

/** A group appeal on `o`'s channel created `daysAgo` days ago (inserted directly: the clock is real). */
async function pastAppeal(o: Owner, daysAgo: number) {
  const { broadcastId } = await seed(o);
  await db()
    .insert(schema.appeals)
    .values({
      appellantId: o.userId,
      kind: "integrity",
      subjectType: "exclusion_group",
      subjectId: broadcastId,
      exclusionCategory: "datacenter",
      body: BODY,
      status: "upheld",
      createdAt: new Date(Date.now() - daysAgo * DAY),
    });
}

const sessionVerdicts = async (ids: string[]) =>
  (
    await db()
      .select({ id: schema.playbackSessions.id, verdict: schema.playbackSessions.verdict })
      .from(schema.playbackSessions)
      .where(inArray(schema.playbackSessions.id, ids))
  ).map((r) => r.verdict);

describe("create", () => {
  test("the owner appeals a shown group; the row holds the category", async () => {
    const o = await owner();
    const { broadcastId } = await seed(o);
    const r = await create(o, broadcastId);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      kind: "integrity",
      subjectType: "exclusion_group",
      subjectId: broadcastId,
      exclusionCategory: "datacenter",
      status: "open",
    });
    const [row] = await db().select().from(schema.appeals).where(eq(schema.appeals.id, r.body.id));
    expect(row).toMatchObject({ exclusionCategory: "datacenter", ruleRef: null, appellantId: o.userId });
  });

  test("another user's broadcast, a rehearsal and an unknown id are NOT_FOUND alike; signed out is 401", async () => {
    const o = await owner();
    const stranger = await owner();
    const { broadcastId } = await seed(o);
    expect((await create(stranger, broadcastId)).status).toBe(404);
    expect((await create(o, uuidv7())).status).toBe(404);
    // A rehearsal never gets a rollup row (a trigger refuses it), so only the kind can refuse it here.
    const rehearsal = await seed(o, { kind: "rehearsal", rollup: false });
    expect((await create(o, rehearsal.broadcastId)).status).toBe(404);
    const anon = await client(api).call("POST", "/api/appeals", {
      kind: "integrity",
      subjectType: "exclusion_group",
      subjectId: broadcastId,
      category: "datacenter",
      body: BODY,
    });
    expect(anon.status).toBe(401);
  });

  test("a hidden group (4 sessions) and an empty category are NOT_FOUND", async () => {
    const o = await owner();
    const { broadcastId } = await seed(o, {
      sessions: [
        { reasons: ["datacenter_ip"], n: 4 },
        { reasons: ["headless"], n: 5 },
      ],
    });
    expect((await create(o, broadcastId, "datacenter")).status).toBe(404);
    expect((await create(o, broadcastId, "privacy_relay")).status).toBe(404);
    // The refusals did not use the broadcast's one appeal.
    expect((await create(o, broadcastId, "automation")).status).toBe(200);
  });

  test("before the 24 h delay, live, or not rolled up: analytics_pending; the harness bypass lifts the delay", async () => {
    const o = await owner();
    const recent = await seed(o, { endedHoursAgo: 3 });
    const r = await create(o, recent.broadcastId);
    expect(r.status).toBe(412);
    expect(r.body.data?.requirement).toBe("analytics_pending");
    const live = await seed(o, { live: true });
    expect((await create(o, live.broadcastId)).status).toBe(412);
    const unrolled = await seed(o, { rollup: false });
    expect((await create(o, unrolled.broadcastId)).status).toBe(412);
    const on = await fetch(`${api.url}${INTERNAL_ROUTES.analyticsDisplayBypass}`, {
      method: "PUT",
      headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: api.internalSecret },
      body: JSON.stringify({ channelId: o.channelId, enabled: true }),
    });
    expect(on.status).toBeLessThan(300);
    expect((await create(o, recent.broadcastId)).status).toBe(200);
  });

  test("a second appeal on one broadcast is refused, any category and status", async () => {
    const o = await owner();
    const { broadcastId } = await seed(o, {
      sessions: [
        { reasons: ["datacenter_ip"], n: 5 },
        { reasons: ["headless"], n: 5 },
      ],
    });
    const first = await create(o, broadcastId, "datacenter");
    expect(first.status).toBe(200);
    const again = await create(o, broadcastId, "automation");
    expect(again.status).toBe(429);
    expect(again.body.data?.retryAfterSeconds).toBeGreaterThan(0);
    expect(again.res.headers.get("retry-after")).not.toBeNull();
    expect((await resolve(first.body.id, "upheld")).status).toBe(200);
    // Rejected: it still counts.
    expect((await create(o, broadcastId, "automation")).status).toBe(429);
  });

  test("three per channel in 7 days: the fourth is refused, one at the 7-day edge has left the window", async () => {
    const o = await owner();
    await pastAppeal(o, 6);
    await pastAppeal(o, 2);
    await pastAppeal(o, 1);
    const fourth = await seed(o);
    const refused = await create(o, fourth.broadcastId);
    expect(refused.status).toBe(429);
    // The 6-day-old one leaves the window in about a day.
    expect(refused.body.data?.retryAfterSeconds).toBeGreaterThan(DAY / 1000 - 120);
    expect(refused.body.data?.retryAfterSeconds).toBeLessThanOrEqual(DAY / 1000);

    const edge = await owner();
    // Just past the window (7 days and a minute, so the request's clock is past the edge too).
    await pastAppeal(edge, 7 + 1 / 1440);
    await pastAppeal(edge, 2);
    await pastAppeal(edge, 1);
    const ok = await seed(edge);
    expect((await create(edge, ok.broadcastId)).status).toBe(200);
  });

  test("concurrent creates: only one passes", async () => {
    // Two different broadcasts with one slot left on the channel.
    const o = await owner();
    await pastAppeal(o, 2);
    await pastAppeal(o, 1);
    const a = await seed(o);
    const b = await seed(o);
    const results = await Promise.all([create(o, a.broadcastId), create(o, b.broadcastId)]);
    expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([200, 429]);

    // The same broadcast twice at once.
    const p = await owner();
    const c = await seed(p);
    const same = await Promise.all([create(p, c.broadcastId), create(p, c.broadcastId), create(p, c.broadcastId)]);
    expect(same.map((r) => r.status).sort((x, y) => x - y)).toEqual([200, 429, 429]);
    const rows = await db()
      .select()
      .from(schema.appeals)
      .where(and(eq(schema.appeals.subjectType, "exclusion_group"), eq(schema.appeals.subjectId, c.broadcastId)));
    expect(rows).toHaveLength(1);
  });
});

describe("resolve", () => {
  test("an overturn changes exactly the covered sessions' verdicts and writes the re-run event in one go", async () => {
    const o = await owner();
    const { broadcastId, ids } = await seed(o, {
      sessions: [
        { reasons: ["datacenter_ip"], n: 5 },
        { reasons: ["datacenter_ip", "headless"], n: 1 },
        { reasons: ["headless", "datacenter_ip"], n: 5 },
        { reasons: [], n: 2, verdict: "verified" },
      ],
    });
    const covered = ids["excluded:datacenter_ip"]!;
    const moves = ids["excluded:datacenter_ip,headless"]!;
    const other = ids["excluded:headless,datacenter_ip"]!;
    const verified = ids["verified:"]!;
    const a = await create(o, broadcastId);
    expect(a.status).toBe(200);
    const r = await resolve(a.body.id, "overturned");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("overturned");

    expect(await sessionVerdicts(covered)).toEqual(Array(5).fill("verified"));
    expect(await sessionVerdicts(moves)).toEqual(["excluded"]);
    expect(await sessionVerdicts(other)).toEqual(Array(5).fill("excluded"));
    expect(await sessionVerdicts(verified)).toEqual(["verified", "verified"]);
    const [moved] = await db()
      .select({ reasons: schema.playbackSessions.verdictReasons })
      .from(schema.playbackSessions)
      .where(eq(schema.playbackSessions.id, moves[0]!));
    expect(moved!.reasons).toEqual(["headless", "allowed_on_appeal"]);

    const events = (
      await db().select().from(schema.events).where(eq(schema.events.type, "integrity.sessions.rescored"))
    )
      .map((e) => e.payload as { broadcast_id: string; sessions: number })
      .filter((p) => p.broadcast_id === broadcastId);
    expect(events).toEqual([{ broadcast_id: broadcastId, channel_id: o.channelId, sessions: 6 }]);

    const [resolveAudit] = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "appeal.resolve"), eq(schema.auditLog.subjectId, a.body.id)));
    expect(resolveAudit).toMatchObject({
      actorId: mod.userId,
      details: {
        appealSubjectType: "exclusion_group",
        appealSubjectId: broadcastId,
        exclusionCategory: "datacenter",
        status: "overturned",
        rescored: 6,
        restored: 5,
      },
    });
    const sessionAudits = await db()
      .select()
      .from(schema.auditLog)
      .where(inArray(schema.auditLog.subjectId, [...covered, ...moves, ...other, ...verified]));
    expect(sessionAudits).toHaveLength(6);
    // Ids and enums only: never the appeal body, the resolution or an email.
    for (const row of [resolveAudit!, ...sessionAudits]) {
      expect(() => assertSafeDetails(row.details)).not.toThrow();
      const text = JSON.stringify(row.details) + row.reason;
      expect(text).not.toContain(BODY);
      expect(text).not.toContain("Reviewed the group.");
      expect(text).not.toContain(o.email);
      expect(text).not.toContain(o.username);
    }
  });

  test("a rejection changes nothing", async () => {
    const o = await owner();
    const { broadcastId, ids } = await seed(o);
    const covered = ids["excluded:datacenter_ip"]!;
    const a = await create(o, broadcastId);
    const before = await db()
      .select()
      .from(schema.playbackSessions)
      .where(inArray(schema.playbackSessions.id, covered));
    expect((await resolve(a.body.id, "upheld")).status).toBe(200);
    const after = await db().select().from(schema.playbackSessions).where(inArray(schema.playbackSessions.id, covered));
    expect(after).toEqual(before);
    const flags = await db()
      .select({ d: schema.integrityFlags.decision })
      .from(schema.integrityFlags)
      .where(inArray(schema.integrityFlags.subjectId, covered));
    expect(flags.every((f) => f.d === "excluded")).toBe(true);
    const events = (
      await db().select().from(schema.events).where(eq(schema.events.type, "integrity.sessions.rescored"))
    )
      .map((e) => e.payload as { broadcast_id: string })
      .filter((p) => p.broadcast_id === broadcastId);
    expect(events).toHaveLength(0);
    const [audit] = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "appeal.resolve"), eq(schema.auditLog.subjectId, a.body.id)));
    expect(audit!.details).toMatchObject({ status: "upheld", exclusionCategory: "datacenter" });
  });

  test("the appellant cannot resolve their own group appeal", async () => {
    const o = await owner();
    await db().update(schema.users).set({ role: "moderator" }).where(eq(schema.users.id, o.userId));
    const { broadcastId, ids } = await seed(o);
    const a = await create(o, broadcastId);
    const r = await o.client.call("POST", `/api/admin/appeals/${a.body.id}`, {
      status: "overturned",
      resolution: "Mine.",
    });
    expect(r.status).toBe(403);
    expect(await sessionVerdicts(ids["excluded:datacenter_ip"]!)).toEqual(Array(6).fill("excluded"));
  });
});
