// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** E7-admin over HTTP: egress report, status-page incidents, integrity flags and decisions. */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema } from "@commonair/db";
import { scoreActiveSessions } from "@commonair/integrity";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Account = Awaited<ReturnType<typeof signUpAndSignIn>>;
type Bytes = { origin: number; relay: number; p2p: number; cdn: number };
type Report = {
  from: string;
  to: string;
  totals: Bytes;
  byBroadcast: { broadcastId: string; channelSlug: string; bytes: Bytes }[];
};
type Flag = {
  id: string;
  subjectType: string;
  subjectId: string;
  signal: string;
  score: number;
  details: Record<string, unknown>;
  decision: string;
  createdAt: string;
};
type Status = {
  components: { id: string; status: string }[];
  incidents: { id: string; title: string; status: string; components: string[]; resolvedAt: string | null }[];
};

let api: TestApi;
let admin: Account;
let alice: Account;
let bob: Account;

beforeAll(async () => {
  api = await startApi();
  [admin, alice, bob] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api), signUpAndSignIn(api)]);
  await db().update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, admin.userId));
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

/** Owner connection: seeds rows the API only reads (samples, flags, sessions). */
const db = () => api.db.db;

async function channelId(slug: string): Promise<string> {
  const [c] = await db().select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.slug, slug));
  if (!c) throw new Error(`no channel ${slug}`);
  return c.id;
}

async function broadcast(slug: string): Promise<string> {
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({ channelId: await channelId(slug), ingestProtocol: "rtmp", path: `live/${slug}` })
    .returning({ id: schema.broadcasts.id });
  if (!b) throw new Error("no broadcast");
  return b.id;
}

const audits = (subjectId: string) =>
  db()
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.subjectId, subjectId))
    .orderBy(schema.auditLog.createdAt);

describe("admin.egress", () => {
  const base = Date.parse("2026-09-01T00:00:00.000Z");
  const minute = (n: number) => new Date(base + n * 60_000);
  let small: string;
  let big: string;

  beforeAll(async () => {
    small = await broadcast(alice.username);
    big = await broadcast(bob.username);
    await db()
      .insert(schema.egressSamples)
      .values([
        { broadcastId: small, bucketStart: minute(0), source: "origin", bytes: 100 },
        { broadcastId: small, bucketStart: minute(1), source: "origin", bytes: 50 },
        { broadcastId: small, bucketStart: minute(1), source: "p2p", bytes: 25 },
        { broadcastId: big, bucketStart: minute(0), source: "relay", bytes: 1_000 },
        { broadcastId: big, bucketStart: minute(2), source: "origin", bytes: 3_000_000_000 },
        // Outside [from, to): before and exactly at `to`.
        { broadcastId: small, bucketStart: minute(-1), source: "cdn", bytes: 7 },
        { broadcastId: big, bucketStart: minute(10), source: "cdn", bytes: 9 },
      ]);
  });

  const report = (who: Account, from: Date, to: Date) =>
    who.client.call<Report>(
      "GET",
      `/api/admin/egress?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
    );

  test("sums across minutes and sources, totals have every source, biggest broadcast first", async () => {
    const r = await report(admin, minute(0), minute(10));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.totals).toEqual({ origin: 3_000_000_150, relay: 1_000, p2p: 25, cdn: 0 });
    expect(r.body.byBroadcast).toEqual([
      { broadcastId: big, channelSlug: bob.username, bytes: { origin: 3_000_000_000, relay: 1_000, p2p: 0, cdn: 0 } },
      { broadcastId: small, channelSlug: alice.username, bytes: { origin: 150, relay: 0, p2p: 25, cdn: 0 } },
    ]);
    expect(r.body.from).toBe(minute(0).toISOString());
  });

  test("the range bounds are [from, to)", async () => {
    const r = await report(admin, minute(-1), minute(1));
    expect(r.body.totals).toEqual({ origin: 100, relay: 1_000, p2p: 0, cdn: 7 });
    const at = await report(admin, minute(10), minute(11));
    expect(at.body.totals.cdn).toBe(9);
    const empty = await report(admin, minute(100), minute(200));
    expect(empty.body).toMatchObject({ totals: { origin: 0, relay: 0, p2p: 0, cdn: 0 }, byBroadcast: [] });
  });

  test("bad ranges are BAD_REQUEST", async () => {
    expect((await report(admin, minute(5), minute(5))).status).toBe(400);
    expect((await report(admin, minute(5), minute(1))).status).toBe(400);
    expect((await report(admin, minute(0), new Date(base + 32 * 86_400_000))).status).toBe(400);
  });

  test("admins only", async () => {
    expect((await report(alice, minute(0), minute(10))).status).toBe(403);
  });
});

describe("admin.incidents", () => {
  const realNow = () => new Date();
  let skew = 0;
  /** `instance.status` caches for 10 s per deps: step its clock past the cache for each read. */
  async function status(): Promise<Status> {
    skew += 11_000;
    api.deps.now = () => new Date(realNow().getTime() + skew);
    try {
      const r = await alice.client.call<Status>("GET", "/api/status");
      expect(r.status).toBe(200);
      return r.body;
    } finally {
      api.deps.now = realNow;
    }
  }
  const write = (who: Account, body: Record<string, unknown>) =>
    who.client.call<{ id: string }>("POST", "/api/admin/incidents", {
      title: "Database slow",
      status: "investigating",
      components: ["postgres"],
      body: "We are looking into it.",
      ...body,
    });

  test("open, update, resolve, reopen; status page and audit follow", async () => {
    const before = await status();
    expect(before.components.find((c) => c.id === "postgres")?.status).toBe("operational");

    const opened = await write(admin, {});
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const id = opened.body.id;
    let s = await status();
    expect(s.incidents.find((i) => i.id === id)).toMatchObject({
      title: "Database slow",
      status: "investigating",
      components: ["postgres"],
      resolvedAt: null,
    });
    expect(s.components.find((c) => c.id === "postgres")?.status).toBe("degraded");
    expect(s.components.find((c) => c.id === "valkey")?.status).toBe("operational");

    expect((await write(admin, { id, status: "identified", title: "Database slow (disk)" })).status).toBe(200);
    expect((await write(admin, { id, status: "resolved", body: "Fixed." })).status).toBe(200);
    const [resolved] = await db().select().from(schema.incidents).where(eq(schema.incidents.id, id));
    expect(resolved?.resolvedAt).toBeInstanceOf(Date);
    s = await status();
    expect(s.incidents.find((i) => i.id === id)).toMatchObject({ status: "resolved", body: "Fixed." });
    expect(s.components.find((c) => c.id === "postgres")?.status).toBe("operational");

    // Editing a resolved incident keeps the first resolution time.
    await write(admin, { id, status: "resolved", body: "Fixed: postmortem soon." });
    const [still] = await db().select().from(schema.incidents).where(eq(schema.incidents.id, id));
    expect(still?.resolvedAt?.getTime()).toBe(resolved?.resolvedAt?.getTime());

    // Reopening clears it.
    await write(admin, { id, status: "monitoring" });
    const [reopened] = await db().select().from(schema.incidents).where(eq(schema.incidents.id, id));
    expect(reopened?.resolvedAt).toBeNull();
    expect((await status()).components.find((c) => c.id === "postgres")?.status).toBe("degraded");

    const rows = await audits(id);
    expect(rows.map((r) => r.action)).toEqual([
      "incident.open",
      "incident.update",
      "incident.resolve",
      "incident.update",
      "incident.update",
    ]);
    for (const r of rows) {
      expect(r.actorType).toBe("admin");
      expect(r.actorId).toBe(admin.userId);
      expect(r.details).toMatchObject({ id, components: ["postgres"] });
      expect(JSON.stringify(r.details)).not.toContain("Fixed");
      expect(JSON.stringify(r.details)).not.toContain("Database slow");
    }
    // Close it so later status reads in this file are not degraded.
    await write(admin, { id, status: "resolved" });
  });

  test("unknown components, unknown ids, non-admins", async () => {
    expect((await write(admin, { components: ["db"] })).status).toBe(400);
    expect((await write(admin, { id: "01900000-0000-7000-8000-000000000000" })).status).toBe(404);
    expect((await write(alice, {})).status).toBe(403);
    const none = await write(admin, { components: [], status: "resolved", title: "Planned maintenance done" });
    expect(none.status).toBe(200);
    const [row] = await db().select().from(schema.incidents).where(eq(schema.incidents.id, none.body.id));
    expect(row?.resolvedAt).toBeInstanceOf(Date);
  });
});

describe("integrity.flags and integrity.decide", () => {
  let aliceChannel: string;
  let bobChannel: string;
  const ids: string[] = [];
  const base = Date.now() - 3_600_000;

  async function seedFlag(values: Partial<typeof schema.integrityFlags.$inferInsert>): Promise<string> {
    const [f] = await db()
      .insert(schema.integrityFlags)
      .values({
        subjectType: "session",
        subjectId: crypto.randomUUID(),
        signal: "datacenter_ip",
        score: 0.6,
        details: { network: "hosting:example", asn: 64500, ip: "203.0.113.7", userAgent: "HeadlessChrome" },
        ...values,
      })
      .returning({ id: schema.integrityFlags.id });
    if (!f) throw new Error("no flag");
    return f.id;
  }

  beforeAll(async () => {
    aliceChannel = await channelId(alice.username);
    bobChannel = await channelId(bob.username);
    // Five on alice's channel, newest last; one relay flag without a channel.
    for (let i = 0; i < 5; i++)
      ids.push(
        await seedFlag({
          channelId: aliceChannel,
          createdAt: new Date(base + i * 1000),
          decision: i === 4 ? "excluded" : "pending_review",
        }),
      );
    // Same timestamp as the newest one: the id breaks the tie.
    ids.push(await seedFlag({ channelId: aliceChannel, createdAt: new Date(base + 4000), subjectType: "user" }));
    await seedFlag({ channelId: bobChannel, createdAt: new Date(base) });
    await seedFlag({ subjectType: "relay", signal: "relay_over_report", score: 1, createdAt: new Date(base) });
  });

  const list = (who: Account, q: string) =>
    who.client.call<{ items: Flag[]; nextCursor: string | null }>("GET", `/api/admin/integrity/flags?${q}`);

  test("keyset pages newest first with filters", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const r: Awaited<ReturnType<typeof list>> = await list(
        admin,
        `channel=${alice.username}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      seen.push(...r.body.items.map((f) => f.id));
      cursor = r.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    const tie = [ids[4], ids[5]].sort((a, b) => String(b).localeCompare(String(a)));
    expect(seen.slice(0, 2)).toEqual(tie);
    expect(seen.slice(2)).toEqual([ids[3], ids[2], ids[1], ids[0]]);

    const users = await list(admin, `channel=${alice.username}&subjectType=user`);
    expect(users.body.items.map((f) => f.id)).toEqual([ids[5]]);
    const excluded = await list(admin, `channel=${alice.username}&decision=excluded`);
    expect(excluded.body.items.map((f) => f.id)).toEqual([ids[4]]);
    expect((await list(admin, "subjectType=relay")).body.items).toHaveLength(1);
    expect((await list(admin, "channel=nobody_here")).body).toEqual({ items: [], nextCursor: null });
    expect((await list(admin, "cursor=garbage")).status).toBe(400);
  });

  test("keyset paging keeps microsecond ties across a page boundary", async () => {
    // The jobs insert batches sharing one `now()`, which Postgres keeps to the microsecond.
    const carol = await signUpAndSignIn(api);
    const chan = await channelId(carol.username);
    const at = (t: string) => sql`${t}::timestamptz`;
    const seeded: string[] = [];
    for (const t of [
      "2026-08-01T00:00:00.123456Z",
      "2026-08-01T00:00:00.123456Z",
      "2026-08-01T00:00:00.123456Z",
      // Between the millisecond truncation (.123) and the batch (.123456).
      "2026-08-01T00:00:00.1232Z",
      "2026-08-01T00:00:00.122Z",
    ]) {
      const [f] = await db()
        .insert(schema.integrityFlags)
        .values({
          subjectType: "session",
          subjectId: crypto.randomUUID(),
          signal: "datacenter_ip",
          score: 0.6,
          details: {},
          channelId: chan,
          createdAt: at(t),
        })
        .returning({ id: schema.integrityFlags.id });
      if (!f) throw new Error("no flag");
      seeded.push(f.id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const r: Awaited<ReturnType<typeof list>> = await list(
        admin,
        `channel=${carol.username}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      seen.push(...r.body.items.map((f) => f.id));
      cursor = r.body.nextCursor;
      if (!cursor) break;
    }
    const batch = seeded.slice(0, 3).sort((a, b) => b.localeCompare(a));
    expect(seen).toEqual([...batch, seeded[3], seeded[4]]);
  });

  test("details leave the API without personal data", async () => {
    const r = await list(admin, `channel=${bob.username}`);
    expect(r.body.items[0]?.details).toEqual({ network: "hosting:example", asn: 64500 });
  });

  test("admins only", async () => {
    expect((await list(alice, "")).status).toBe(403);
    expect(
      (
        await alice.client.call("POST", `/api/admin/integrity/flags/${ids[0]}`, {
          decision: "allowed",
          reason: "looks fine",
        })
      ).status,
    ).toBe(403);
  });

  test("decide: CAS, conflict on the same decision, audit with the reason", async () => {
    const id = ids[1] as string;
    const decide = (decision: string, reason = "Known corporate VPN range") =>
      admin.client.call<Flag>("POST", `/api/admin/integrity/flags/${id}`, { decision, reason });
    const r = await decide("allowed");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ id, decision: "allowed", signal: "datacenter_ip" });
    expect(r.body.details).not.toHaveProperty("ip");
    const [row] = await db().select().from(schema.integrityFlags).where(eq(schema.integrityFlags.id, id));
    expect(row).toMatchObject({ decision: "allowed", decidedById: admin.userId });
    expect(row?.decidedAt).toBeInstanceOf(Date);

    expect((await decide("allowed")).status).toBe(409);
    expect((await decide("excluded", "Second look: datacenter")).status).toBe(200);
    expect((await decide("pending_review")).status).toBe(400);
    expect((await decide("allowed", "")).status).toBe(400);
    expect(
      (
        await admin.client.call("POST", "/api/admin/integrity/flags/01900000-0000-7000-8000-000000000000", {
          decision: "allowed",
          reason: "x",
        })
      ).status,
    ).toBe(404);

    const rows = await audits(id);
    expect(rows.map((a) => [a.action, a.reason])).toEqual([
      ["integrity.flag.decide", "Known corporate VPN range"],
      ["integrity.flag.decide", "Second look: datacenter"],
    ]);
    expect(rows[0]).toMatchObject({
      actorType: "admin",
      actorId: admin.userId,
      subjectType: "integrity_flag",
      channelId: aliceChannel,
      details: { flagId: id, from: "pending_review", to: "allowed", signal: "datacenter_ip", subjectType: "session" },
    });
    expect(rows[1]?.details).toMatchObject({ from: "allowed", to: "excluded" });
  });

  test("an allowed session flag stops counting on the next scoring run", async () => {
    const startedAt = new Date(Date.now() - 5 * 60_000);
    const [session] = await db()
      .insert(schema.playbackSessions)
      .values({
        channelId: aliceChannel,
        userId: bob.userId,
        deviceHash: `dev-${crypto.randomUUID()}`,
        ipHash: `ip-${crypto.randomUUID()}`,
        datacenter: "hosting:example",
        asn: 64500,
        startedAt,
        lastHeartbeatAt: new Date(),
      })
      .returning({ id: schema.playbackSessions.id });
    if (!session) throw new Error("no session");
    const flag = await seedFlag({ subjectId: session.id, channelId: aliceChannel, createdAt: startedAt });

    const reasons = async () => {
      await scoreActiveSessions(api.deps.db, api.deps.valkey, new Date());
      const [p] = await db()
        .select({ reasons: schema.playbackSessions.verdictReasons })
        .from(schema.playbackSessions)
        .where(eq(schema.playbackSessions.id, session.id));
      return p?.reasons ?? [];
    };
    expect(await reasons()).toContain("datacenter_ip");

    const r = await admin.client.call<Flag>("POST", `/api/admin/integrity/flags/${flag}`, {
      decision: "allowed",
      reason: "Office network, verified with the viewer",
    });
    expect(r.status).toBe(200);
    const after = await reasons();
    expect(after).not.toContain("datacenter_ip");
    expect(after).toContain("allowed_on_appeal");
    const [audit] = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, flag), eq(schema.auditLog.action, "integrity.flag.decide")));
    expect(audit?.details).toMatchObject({ subjectType: "session", to: "allowed" });
  });
});
