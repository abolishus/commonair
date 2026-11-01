// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `integrity.channelSummary` from the rollup (decision (k)): integer seconds, exclusion categories
 * (never signal codes), groups under 5 sessions hidden per broadcast, excluded follows in the
 * period, owner only and under the 24 h display delay.
 */
import { schema, uuidv7 } from "@commonair/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

const HOUR = 3_600_000;
let api: TestApi;
let owner: Awaited<ReturnType<typeof signUpAndSignIn>>;
let channelId: string;
const db = () => api.db.db;

beforeAll(async () => {
  api = await startApi();
  owner = await signUpAndSignIn(api);
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, owner.username));
  channelId = c!.id;
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

async function seed(endedHoursAgo: number, byCat: Record<string, number>, verified: number) {
  const endedAt = new Date(Date.now() - endedHoursAgo * HOUR);
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({
      id: uuidv7(),
      channelId,
      ingestProtocol: "rtmp",
      path: `live/${owner.username}`,
      startedAt: new Date(endedAt.getTime() - HOUR),
      endedAt,
    })
    .returning();
  const secs = Object.fromEntries(Object.entries(byCat).map(([k, n]) => [k, n * 100]));
  await db()
    .insert(schema.broadcastAudienceTotals)
    .values({
      broadcastId: b!.id,
      channelId,
      durationSeconds: 3600,
      sessions: 30,
      peakVerifiedConcurrent: 3,
      verifiedViewerSeconds: verified,
      unverifiedViewerSeconds: 11,
      excludedViewerSeconds: Object.values(secs).reduce((a, n) => a + n, 0),
      excludedSecondsByCategory: secs,
      excludedSessionsByCategory: byCat,
    });
  return b!;
}

test("integers and categories from the rollup, small groups hidden per broadcast, excluded follows counted", async () => {
  await seed(48, { datacenter: 10, automation: 2 }, 5000);
  await seed(72, { datacenter: 5, privacy_relay: 4 }, 2500);
  // Inside the display delay: not counted yet.
  await seed(3, { datacenter: 50 }, 99_999);
  // Five excluded follows past the display delay; one inside it and one not excluded are not counted.
  const followExclusions = [30, 31, 32, 33, 34, 10].map((h) => new Date(Date.now() - h * HOUR));
  for (const excludedAt of [...followExclusions, null]) {
    const fan = await signUpAndSignIn(api);
    await db().insert(schema.follows).values({ followerId: fan.userId, channelId, excludedAt });
  }
  const r = await owner.client.call<Record<string, unknown>>("GET", `/api/channels/${owner.username}/integrity`);
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({
    channelSlug: owner.username,
    verifiedViewerSeconds: 7500,
    unverifiedViewerSeconds: 22,
    excludedViewerSeconds: 2100,
    excludedFollows: 5,
    exclusionsByCategory: [{ category: "datacenter", sessions: 15, viewerSeconds: 1500 }],
    hiddenGroups: 2,
  });
  for (const k of ["verifiedViewerSeconds", "unverifiedViewerSeconds", "excludedViewerSeconds"])
    expect(Number.isInteger(r.body[k])).toBe(true);
  expect(Date.parse(r.body.periodEnd as string) - Date.parse(r.body.periodStart as string)).toBe(30 * 24 * HOUR);
  expect(JSON.stringify(r.body)).not.toMatch(/datacenter_ip|privacy_relay|automation/);
});

test("an explicit period, and a stranger is refused", async () => {
  const from = new Date(Date.now() - 60 * HOUR).toISOString();
  const to = new Date(Date.now() - 40 * HOUR).toISOString();
  const r = await owner.client.call<Record<string, unknown>>(
    "GET",
    `/api/channels/${owner.username}/integrity?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  expect(r.body).toMatchObject({ verifiedViewerSeconds: 5000, periodStart: from, periodEnd: to, excludedFollows: 0 });
  // Four excluded follows (31-34 h ago) in this period: under the threshold, shown as 0.
  const few = new URLSearchParams({
    from: new Date(Date.now() - 40 * HOUR).toISOString(),
    to: new Date(Date.now() - 30.5 * HOUR).toISOString(),
  });
  const r4 = await owner.client.call<Record<string, unknown>>(
    "GET",
    `/api/channels/${owner.username}/integrity?${few}`,
  );
  expect(r4.body).toMatchObject({ excludedFollows: 0 });
  const stranger = await signUpAndSignIn(api);
  expect((await stranger.client.call("GET", `/api/channels/${owner.username}/integrity`)).status).toBe(403);
});
