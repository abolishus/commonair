// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `analytics.*` over HTTP against rollup rows written here (the worker's rollup has its own
 * tests): owner-only access, the 24 h display delay and the harness bypass, small-group
 * suppression, delivery, cost and P&L, and share links (cost-free, expiring, revocable).
 */
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { paymentSucceeded, post } from "@commonair/ledger";
import { sha256Hex } from "@commonair/tokens";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Person = Awaited<ReturnType<typeof signUpAndSignIn>>;
const HOUR = 3_600_000;
const COST_MODEL = { currency: "usd", centsPerGb: { origin: 2 } };

let api: TestApi;
let owner: Person;
let other: Person;
let editor: Person;
let channelId: string;
const db = () => api.db.db;

beforeAll(async () => {
  api = await startApi({ env: { OPS_TEST_HOOKS: "true", INFRA_COST_MODEL: JSON.stringify(COST_MODEL) } });
  owner = await signUpAndSignIn(api);
  other = await signUpAndSignIn(api);
  editor = await signUpAndSignIn(api);
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, owner.username));
  channelId = c!.id;
  await db().insert(schema.channelRoles).values({ channelId, userId: editor.userId, role: "editor" });
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

/** A rolled-up broadcast that ended `endedHoursAgo` ago, one hour long. */
async function seed(o: {
  endedHoursAgo: number;
  title?: string;
  sessionsByCategory?: Record<string, number>;
  costCents?: number;
  purged?: boolean;
}) {
  const endedAt = new Date(Date.now() - o.endedHoursAgo * HOUR);
  const startedAt = new Date(endedAt.getTime() - HOUR);
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({
      id: uuidv7(),
      channelId,
      ingestProtocol: "rtmp",
      path: `live/${owner.username}`,
      title: o.title ?? "A broadcast",
      startedAt,
      endedAt,
    })
    .returning();
  const byCat = o.sessionsByCategory ?? { datacenter: 12 };
  const secs = Object.fromEntries(Object.entries(byCat).map(([k, n]) => [k, n * 600]));
  await db()
    .insert(schema.broadcastAudienceTotals)
    .values({
      broadcastId: b!.id,
      channelId,
      durationSeconds: 3600,
      sessions: 20,
      peakVerifiedConcurrent: 4,
      verifiedViewerSeconds: 7200,
      unverifiedViewerSeconds: 300,
      excludedViewerSeconds: Object.values(secs).reduce((a, n) => a + n, 0),
      excludedSecondsByCategory: secs,
      excludedSessionsByCategory: byCat,
      bytesBySource: { origin: 6_000_000_000, relay: 4_000_000_000 },
      verifiedSecondsBySource: { origin: 3600, relay: 3600 },
      minutesPurgedAt: o.purged ? new Date() : null,
    });
  if (!o.purged)
    await db()
      .insert(schema.broadcastAudienceMinutes)
      .values(
        [0, 1, 2].map((i) => ({
          broadcastId: b!.id,
          minute: new Date(startedAt.getTime() + i * 60_000),
          verified: 2,
          unverified: 1,
          excluded: i,
        })),
      );
  await db()
    .insert(schema.broadcastCosts)
    .values({ broadcastId: b!.id, currency: "usd", costCents: o.costCents ?? 12, model: COST_MODEL });
  return b!;
}

const bypass = (enabled: boolean) =>
  fetch(`${api.url}${INTERNAL_ROUTES.analyticsDisplayBypass}`, {
    method: "PUT",
    headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: api.internalSecret },
    body: JSON.stringify({ channelId, enabled }),
  });

const path = (rest: string) => `/api/channels/${owner.username}/analytics${rest}`;
const range = (from: Date, to: Date) =>
  `?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;

describe("access", () => {
  test("only the owner: an editor or another user is refused, signed out is 401", async () => {
    const b = await seed({ endedHoursAgo: 30 });
    expect((await owner.client.call("GET", path(`/broadcasts/${b.id}`))).status).toBe(200);
    expect((await editor.client.call("GET", path(`/broadcasts/${b.id}`))).status).toBe(403);
    expect((await other.client.call("GET", path(`/broadcasts/${b.id}`))).status).toBe(403);
    expect((await client(api).call("GET", path(`/broadcasts/${b.id}`))).status).toBe(401);
    const r = range(new Date(Date.now() - 48 * HOUR), new Date());
    expect((await editor.client.call("GET", path(`/pnl${r}`))).status).toBe(403);
    expect((await other.client.call("GET", `/api/channels/${owner.username}/integrity`)).status).toBe(403);
  });

  test("another channel's broadcast is not found through mine", async () => {
    const [b] = await db()
      .insert(schema.broadcasts)
      .values({
        id: uuidv7(),
        channelId: (await db().select().from(schema.channels).where(eq(schema.channels.slug, other.username)))[0]!.id,
        ingestProtocol: "rtmp",
        path: "live/x",
        startedAt: new Date(Date.now() - 50 * HOUR),
        endedAt: new Date(Date.now() - 49 * HOUR),
      })
      .returning();
    expect((await owner.client.call("GET", path(`/broadcasts/${b!.id}`))).status).toBe(404);
  });
});

describe("display delay", () => {
  test("hidden until 24 h after the end, then shown; the bypass shows it early", async () => {
    const recent = await seed({ endedHoursAgo: 23 });
    const r = await owner.client.call<{ data: { requirement: string } }>("GET", path(`/broadcasts/${recent.id}`));
    expect(r.status).toBe(412);
    expect(r.body.data.requirement).toBe("analytics_pending");
    const window = range(new Date(Date.now() - 30 * HOUR), new Date());
    const before = await owner.client.call<{ broadcasts: { broadcastId: string }[] }>("GET", path(window));
    expect(before.body.broadcasts.map((x) => x.broadcastId)).not.toContain(recent.id);

    expect((await bypass(true)).status).toBe(200);
    expect((await owner.client.call("GET", path(`/broadcasts/${recent.id}`))).status).toBe(200);
    const during = await owner.client.call<{ broadcasts: { broadcastId: string }[] }>("GET", path(window));
    expect(during.body.broadcasts.map((x) => x.broadcastId)).toContain(recent.id);
    await bypass(false);
    expect((await owner.client.call("GET", path(`/broadcasts/${recent.id}`))).status).toBe(412);
  });

  test("a live broadcast and one not rolled up yet are pending", async () => {
    const [live] = await db()
      .insert(schema.broadcasts)
      .values({ id: uuidv7(), channelId, ingestProtocol: "rtmp", path: "live/y", startedAt: new Date() })
      .returning();
    const r = await owner.client.call<{ data: { requirement: string } }>("GET", path(`/broadcasts/${live!.id}`));
    expect(r.status).toBe(412);
    expect(r.body.data.requirement).toBe("analytics_pending");
    const [unrolled] = await db()
      .insert(schema.broadcasts)
      .values({
        id: uuidv7(),
        channelId,
        ingestProtocol: "rtmp",
        path: "live/z",
        startedAt: new Date(Date.now() - 40 * HOUR),
        endedAt: new Date(Date.now() - 39 * HOUR),
      })
      .returning();
    expect((await owner.client.call("GET", path(`/broadcasts/${unrolled!.id}`))).status).toBe(412);
  });
});

describe("one broadcast", () => {
  test("verified, unverified, groups at 4/5/6 sessions, delivery and cost; no signal codes", async () => {
    const b = await seed({ endedHoursAgo: 26, sessionsByCategory: { datacenter: 6, automation: 5, concurrency: 4 } });
    const r = await owner.client.call<Record<string, unknown>>("GET", path(`/broadcasts/${b.id}`));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      broadcastId: b.id,
      durationSeconds: 3600,
      totals: { verifiedViewerSeconds: 7200, unverifiedViewerSeconds: 300, sessions: 20, peakVerifiedConcurrent: 4 },
      exclusions: [
        { category: "datacenter", sessions: 6, viewerSeconds: 3600 },
        { category: "automation", sessions: 5, viewerSeconds: 3000 },
      ],
      hiddenGroups: 1,
      minutesRetained: true,
      delivery: [
        { source: "origin", bytes: 6_000_000_000, verifiedViewerSeconds: 3600 },
        { source: "relay", bytes: 4_000_000_000, verifiedViewerSeconds: 3600 },
      ],
      cost: { cents: 12, currency: "usd" },
    });
    expect(r.body.minutes).toHaveLength(3);
    const text = JSON.stringify(r.body);
    for (const leak of ["concurrency", "datacenter_ip", "headless", owner.userId]) expect(text).not.toContain(leak);
  });

  test("after retention only totals remain", async () => {
    const b = await seed({ endedHoursAgo: 24 * 95, purged: true });
    const r = await owner.client.call<{ minutes: unknown[]; minutesRetained: boolean }>(
      "GET",
      path(`/broadcasts/${b.id}`),
    );
    expect(r.body).toMatchObject({ minutes: [], minutesRetained: false });
  });
});

describe("ranges", () => {
  test("range, exclusions and P&L sum the displayable broadcasts; groups are suppressed per broadcast", async () => {
    const from = new Date(Date.now() - 24 * 20 * HOUR);
    const to = new Date(Date.now() - 24 * 10 * HOUR);
    // Two groups of 3: summed they would be 6, but each broadcast's group is hidden on its own.
    const a = await seed({
      endedHoursAgo: 24 * 15,
      sessionsByCategory: { automation: 3, datacenter: 8 },
      costCents: 7,
    });
    const b = await seed({ endedHoursAgo: 24 * 12, sessionsByCategory: { automation: 3 }, costCents: 5 });
    // Revenue during broadcast a (tip while live) and between broadcasts.
    for (const [cents, when] of [
      [1000, new Date(a.startedAt.getTime() + 10 * 60_000)],
      [500, new Date(a.endedAt!.getTime() + 24 * HOUR)],
    ] as const) {
      await post(
        db(),
        paymentSucceeded({
          paymentId: uuidv7(when.getTime()),
          paymentKind: "tip",
          provider: "manual",
          settlement: "cash",
          creatorUserId: owner.userId,
          grossCents: cents,
          taxCents: 0,
          feeCents: 0,
          currency: "usd",
          cut: { streamerShare: 0.9, coopShare: 0.1 },
          cutHistoryId: null,
          occurredAt: when,
        }),
      );
    }

    const r = await owner.client.call<Record<string, unknown>>("GET", path(range(from, to)));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      totals: { verifiedViewerSeconds: 14_400, unverifiedViewerSeconds: 600, sessions: 40, peakVerifiedConcurrent: 4 },
      cost: { cents: 12, currency: "usd" },
      delivery: [
        { source: "origin", bytes: 12_000_000_000, verifiedViewerSeconds: 7200 },
        { source: "relay", bytes: 8_000_000_000, verifiedViewerSeconds: 7200 },
      ],
    });
    expect((r.body.broadcasts as { broadcastId: string }[]).map((x) => x.broadcastId)).toEqual([b.id, a.id]);

    const ex = await owner.client.call<Record<string, unknown>>("GET", path(`/exclusions${range(from, to)}`));
    expect(ex.body).toMatchObject({
      groups: [{ broadcastId: a.id, category: "datacenter", sessions: 8, viewerSeconds: 4800 }],
      hiddenGroups: 2,
    });

    const pnl = await owner.client.call<Record<string, unknown>>("GET", path(`/pnl${range(from, to)}`));
    expect(pnl.body).toMatchObject({
      revenue: { cents: 1350, currency: "usd" },
      cost: { cents: 12, currency: "usd" },
      net: { cents: 1338, currency: "usd" },
    });
    expect(pnl.body.byBroadcast).toEqual([
      { broadcastId: b.id, revenue: { cents: 0, currency: "usd" }, cost: { cents: 5, currency: "usd" } },
      { broadcastId: a.id, revenue: { cents: 900, currency: "usd" }, cost: { cents: 7, currency: "usd" } },
    ]);
  });

  test("a reversed or too long range is refused", async () => {
    const now = new Date();
    expect((await owner.client.call("GET", path(range(now, new Date(now.getTime() - HOUR))))).status).toBe(400);
    expect((await owner.client.call("GET", path(range(new Date(now.getTime() - 500 * 24 * HOUR), now)))).status).toBe(
      400,
    );
  });
});

describe("share links", () => {
  test("create shows the link once; the shared view has no cost; revoke ends it", async () => {
    const b = await seed({ endedHoursAgo: 28 });
    const created = await owner.client.call<{ id: string; url: string; expiresAt: string }>(
      "POST",
      path("/share-links"),
      { broadcastId: b.id, expiresInDays: 7 },
    );
    expect(created.status).toBe(200);
    const token = created.body.url.split("/").at(-1)!;
    expect(created.body.url).toContain("/api/analytics/shared/");
    expect(Date.parse(created.body.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 24 * HOUR);
    const [row] = await db()
      .select()
      .from(schema.analyticsShareLinks)
      .where(eq(schema.analyticsShareLinks.id, created.body.id));
    expect(row!.tokenHash).toBe(await sha256Hex(token));
    expect(JSON.stringify(row)).not.toContain(token);

    const shared = await client(api).call<{ broadcastId: string; cost: unknown }>(
      "GET",
      `/api/analytics/shared/${token}`,
    );
    expect(shared.status).toBe(200);
    expect(shared.body).toMatchObject({ broadcastId: b.id, cost: null });

    const list = await owner.client.call<{ items: { id: string; url: string | null }[] }>("GET", path("/share-links"));
    expect(list.body.items.find((l) => l.id === created.body.id)).toMatchObject({ url: null });
    expect((await other.client.call("DELETE", path(`/share-links/${created.body.id}`))).status).toBe(403);

    expect((await owner.client.call("DELETE", path(`/share-links/${created.body.id}`))).status).toBe(200);
    expect((await client(api).call("GET", `/api/analytics/shared/${token}`)).status).toBe(404);
    // Revoking again is a no-op.
    expect((await owner.client.call("DELETE", path(`/share-links/${created.body.id}`))).status).toBe(200);
  });

  test("an expired link and an unknown token are not found; a live broadcast cannot be shared", async () => {
    const b = await seed({ endedHoursAgo: 28 });
    const token = "a".repeat(48);
    await db()
      .insert(schema.analyticsShareLinks)
      .values({
        channelId,
        broadcastId: b.id,
        tokenHash: await sha256Hex(token),
        createdAt: new Date(Date.now() - 3 * HOUR),
        expiresAt: new Date(Date.now() - HOUR),
      });
    expect((await client(api).call("GET", `/api/analytics/shared/${token}`)).status).toBe(404);
    expect((await client(api).call("GET", `/api/analytics/shared/${"b".repeat(48)}`)).status).toBe(404);
    const [live] = await db()
      .insert(schema.broadcasts)
      .values({ id: uuidv7(), channelId, ingestProtocol: "rtmp", path: "live/l", startedAt: new Date() })
      .returning();
    expect(
      (await owner.client.call("POST", path("/share-links"), { broadcastId: live!.id, expiresInDays: 1 })).status,
    ).toBe(400);
  });

  test("a share link to a broadcast inside the delay is pending until it shows", async () => {
    const b = await seed({ endedHoursAgo: 2 });
    const created = await owner.client.call<{ url: string }>("POST", path("/share-links"), {
      broadcastId: b.id,
      expiresInDays: 1,
    });
    const token = created.body.url.split("/").at(-1)!;
    expect((await client(api).call("GET", `/api/analytics/shared/${token}`)).status).toBe(412);
  });
});
