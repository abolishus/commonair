// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `eligibleHoursForUsers` (the membership view's per-user read) against `eligibleHoursByUser` (the
 * sync's every-owner read): the same numbers for the same users, the same daily cap and window
 * boundaries, and a plan that range-scans `stream_hours_channel_idx` instead of every owner's hours.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema as s, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import {
  contributionInputs,
  eligibleHoursByUser,
  eligibleHoursForUsers,
  eligibleHoursForUsersSql,
} from "../src/inputs.ts";

let t: TestDatabase;
let app: Database;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Midnight UTC, so day boundaries are easy to reason about. */
const T0 = new Date("2026-06-01T00:00:00Z");
const at = (days: number, hours = 0) => new Date(T0.getTime() + days * DAY + hours * HOUR);
const CAP = 8;

beforeAll(async () => {
  t = await createTestDatabase();
  app = t.app.db;
});
afterAll(async () => {
  await t?.drop();
});

let seq = 0;
async function owner() {
  const name = `hoursuser${++seq}`;
  const [u] = await app
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: s.users.id });
  const [ch] = await app
    .insert(s.channels)
    .values({ ownerId: u!.id, slug: `hours${seq}`, displayName: `Hours ${seq}` })
    .returning({ id: s.channels.id });
  const [b] = await app
    .insert(s.broadcasts)
    .values({ channelId: ch!.id, ingestProtocol: "rtmp", path: `live/hours${seq}`, startedAt: at(-1) })
    .returning({ id: s.broadcasts.id });
  return { userId: u!.id, channelId: ch!.id, broadcastId: b!.id };
}

/** `hours` consecutive clock hours from `start`, each `liveSeconds` long. */
async function hours(
  o: { channelId: string; broadcastId: string },
  start: Date,
  n: number,
  { eligible = true, liveSeconds = 3600 } = {},
) {
  await app.insert(s.streamHours).values(
    Array.from({ length: n }, (_, i) => ({
      broadcastId: o.broadcastId,
      channelId: o.channelId,
      hourStart: new Date(start.getTime() + i * HOUR),
      liveSeconds,
      eligible,
      verifiedOtherViewers: eligible ? 1 : 0,
    })),
  );
}

let a: Awaited<ReturnType<typeof owner>>;
let b: Awaited<ReturnType<typeof owner>>;
let c: Awaited<ReturnType<typeof owner>>;
let none: Awaited<ReturnType<typeof owner>>;

describe("eligibleHoursForUsers", () => {
  beforeAll(async () => {
    [a, b, c, none] = [await owner(), await owner(), await owner(), await owner()];
    // A: 3 h on day 0, 12 h on day 1 (capped to 8), 2 ineligible hours on day 2.
    await hours(a, at(0, 2), 3);
    await hours(a, at(1), 12);
    await hours(a, at(2), 2, { eligible: false });
    // B: half hours across a UTC midnight (22:00–02:00): 1 h on day 3, 1 h on day 4.
    await hours(b, at(3, 22), 4, { liveSeconds: 1800 });
    // C: one hour exactly at the window end (excluded) and one just inside the start.
    await hours(c, at(5), 1);
    await hours(c, at(0), 1);
  });

  const window = { from: at(0), to: at(5) };

  test("equals eligibleHoursByUser for the same users, with the daily cap", async () => {
    const all = await eligibleHoursByUser(app, window.from, window.to, CAP);
    const ids = [a.userId, b.userId, c.userId, none.userId];
    const some = await eligibleHoursForUsers(app, ids, window.from, window.to, CAP);
    for (const id of ids) expect(some.get(id), id).toBe(all.get(id));
    expect(some.get(a.userId)).toBe(3 + CAP);
    expect(some.get(b.userId)).toBe(2);
    expect(some.get(c.userId)).toBe(1);
    // An owner with no eligible hours is absent, as in the sync's read.
    expect(some.has(none.userId)).toBe(false);
    expect(all.has(none.userId)).toBe(false);
  });

  test("returns only the users asked for", async () => {
    const one = await eligibleHoursForUsers(app, [b.userId], window.from, window.to, CAP);
    expect([...one.keys()]).toEqual([b.userId]);
  });

  test("window boundaries: from is inclusive, to is exclusive", async () => {
    const ids = [c.userId];
    expect((await eligibleHoursForUsers(app, ids, at(0), at(0, 1), CAP)).get(c.userId)).toBe(1);
    expect((await eligibleHoursForUsers(app, ids, at(0, 1), at(5), CAP)).has(c.userId)).toBe(false);
    expect((await eligibleHoursForUsers(app, ids, at(0, 1), at(5, 1), CAP)).get(c.userId)).toBe(1);
  });

  test("the cap applies per UTC day, and a lower cap matches the old read too", async () => {
    for (const cap of [0, 0.5, 1, 8, 24]) {
      const all = await eligibleHoursByUser(app, window.from, window.to, cap);
      const some = await eligibleHoursForUsers(app, [a.userId, b.userId], window.from, window.to, cap);
      expect(some.get(a.userId) ?? 0, `cap ${cap}`).toBe(all.get(a.userId) ?? 0);
      expect(some.get(b.userId) ?? 0, `cap ${cap}`).toBe(all.get(b.userId) ?? 0);
    }
    // Half an hour on each side of midnight: capped to 0.5 per day, so 1 in total.
    expect((await eligibleHoursForUsers(app, [b.userId], window.from, window.to, 0.5)).get(b.userId)).toBe(1);
  });

  test("an empty user list answers an empty map without a query", async () => {
    expect((await eligibleHoursForUsers(app, [], window.from, window.to, CAP)).size).toBe(0);
  });

  test("the plan range-scans stream_hours_channel_idx", async () => {
    // The table is tiny here, so the planner would rightly prefer a sequential scan; with that
    // switched off for the transaction, the only index that serves the query shape must be chosen.
    const plan = await t.db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const q = eligibleHoursForUsersSql([a.userId], window.from, window.to, CAP);
      const rows = (await tx.execute(sql`explain ${q}`)) as unknown as Record<string, string>[];
      return rows.map((r) => Object.values(r)[0]).join("\n");
    });
    expect(plan).toContain("stream_hours_channel_idx");
  });
});

describe("contributionInputs viewer hours", () => {
  test("count gate-eligible verified sessions only: never-scored and fetch-unjudged ones earn nothing", async () => {
    const o = await owner();
    const session = (watchSeconds: number, extra: { scoredAt?: Date | null; verdictReasons?: string[] }) =>
      app.insert(s.playbackSessions).values({
        channelId: o.channelId,
        deviceHash: `d${++seq}`,
        ipHash: `i${seq}`,
        watchSeconds,
        verdict: "verified",
        startedAt: at(1, 1),
        scoredAt: at(1, 2),
        ...extra,
      });
    await session(3600, {});
    await session(7200, { scoredAt: null });
    await session(10_800, { verdictReasons: ["fetch_unjudged"] });
    const inputs = await contributionInputs(app, at(0), at(5), CAP);
    expect(inputs.get(o.userId)?.viewerHours).toBe(1);
  });
});
