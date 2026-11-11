// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The nightly growth job (overhaul wave 2, D2.8) against real Postgres and Valkey: each metric's
 * rule on a fixture day (and the rows it must leave out), the settle and backfill windows, upserts
 * on rerun, the app role's grants, and the run lock. Fixtures are written as the owner; the job
 * runs as the least-privilege app role, as in production.
 */
import { GROWTH_METRICS, type GrowthMetric } from "@commonair/contracts/enums";
import { schema, uuidv7, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createValkey } from "@commonair/service";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BACKFILL_DAYS, SETTLE_DAYS, computeDay, daysToCompute, runGrowthDaily, utcDay } from "../src/growth/daily.ts";
import { GROWTH_DAILY_LOCK_KEY, job } from "../src/growth/job.ts";
import type { WorkerContext } from "../src/context.ts";
import { makeBroadcast, makeUser, quietLogger, VALKEY_URL } from "./fixtures.ts";

const DAY = "2026-06-10";
const at = (time: string, day = DAY) => new Date(`${day}T${time}Z`);
const H = 3_600_000;
const D_MS = 24 * H;
const shift = (days: number, time = "12:00:00") => new Date(at(time).getTime() + days * D_MS);
/** A run the morning after `DAY`. */
const NOW = at("03:00:00", "2026-06-11");

let t: TestDatabase;
let owner: Database;
let values: Record<GrowthMetric, number>;

async function user(name: string, createdAt: Date, over: Partial<typeof schema.users.$inferInsert> = {}) {
  const { user: u, channel } = await makeUser(owner, name);
  await owner
    .update(schema.users)
    .set({ createdAt, ...over })
    .where(eq(schema.users.id, u.id));
  return { id: u.id, channelId: channel.id };
}

async function broadcast(channelId: string, startedAt: Date, endedAt: Date | null = null) {
  const b = await makeBroadcast(owner, channelId, startedAt);
  if (endedAt) await owner.update(schema.broadcasts).set({ endedAt }).where(eq(schema.broadcasts.id, b.id));
  return b;
}

async function payment(userId: string, kind: "tip" | "subscription" | "membership_share", succeededAt: Date | null) {
  const id = uuidv7();
  await owner.insert(schema.payments).values({
    id,
    provider: "manual",
    providerRef: `manual_${id}`,
    kind,
    status: succeededAt ? "succeeded" : "pending",
    userId,
    amountCents: 500,
    currency: "usd",
    succeededAt,
  });
}

beforeAll(async () => {
  t = await createTestDatabase();
  owner = t.db;
  // Accounts: two made that day by people (one verified), one by a bot, one 10 days before.
  const a = await user("growtha", at("10:00:00"), { emailVerified: true });
  const b = await user("growthb", at("11:00:00"));
  await user("growthbot", at("11:30:00"), { accountType: "bot", botOwnerId: a.id, emailVerified: true });
  const c = await user("growthc", shift(-10));
  const e = await user("growthe", shift(-40));
  const late = await user("growthlate", at("23:00:00", "2026-06-11"));

  // Follows: a's first (counted), a's second, c's first (account too old), b's first the next day.
  await owner.insert(schema.follows).values([
    { followerId: a.id, channelId: c.channelId, createdAt: at("12:00:00") },
    { followerId: a.id, channelId: e.channelId, createdAt: at("12:30:00") },
    { followerId: c.id, channelId: a.channelId, createdAt: at("12:00:00") },
    { followerId: b.id, channelId: a.channelId, createdAt: at("09:00:00", "2026-06-11") },
  ]);
  // Chat: two lines from a (one first chat); b chatted the day before (impossible but before the window).
  await owner.insert(schema.chatMessages).values([
    { id: uuidv7(), channelId: c.channelId, userId: a.id, body: "hi", createdAt: at("13:00:00") },
    { id: uuidv7(), channelId: c.channelId, userId: a.id, body: "again", createdAt: at("14:00:00") },
    { id: uuidv7(), channelId: c.channelId, userId: c.id, body: "old account", createdAt: at("14:00:00") },
  ]);
  // Support: a's first tip that day; b's member share (not support); c's pending tip.
  await payment(a.id, "tip", at("15:00:00"));
  await payment(a.id, "subscription", at("16:00:00"));
  await payment(b.id, "membership_share", at("15:00:00"));
  await payment(c.id, "tip", null);

  // Memberships: a joins that day; c joined 5 days before and is active; e lapsed the day before.
  await owner.insert(schema.memberships).values([
    { userId: a.id, class: "viewer", basis: "subscription", joinedAt: at("16:00:00") },
    { userId: c.id, class: "viewer", basis: "share", joinedAt: shift(-5) },
    {
      userId: e.id,
      class: "viewer",
      basis: "share",
      status: "lapsed",
      joinedAt: shift(-30),
      lapsedAt: shift(-1),
    },
  ]);
  // Alerts: a turned on email, b registered a browser for push, c turned one off.
  // Ids are minted at the write time, as the API's upsert does on insert.
  const t17 = at("17:00:00");
  await owner.insert(schema.notificationPreferences).values([
    { id: uuidv7(t17.getTime()), userId: a.id, type: "go_live", medium: "email", enabled: true, updatedAt: t17 },
    { id: uuidv7(t17.getTime()), userId: c.id, type: "go_live", medium: "push", enabled: false, updatedAt: t17 },
    { id: uuidv7(t17.getTime()), userId: a.id, type: "go_live", medium: "in_app", enabled: true, updatedAt: t17 },
  ]);
  await owner.insert(schema.pushSubscriptions).values({
    id: uuidv7(),
    userId: b.id,
    endpointHash: "growth-endpoint",
    subscription: "x",
    createdAt: at("18:00:00"),
  });

  // Streams: a's channel goes live for the first time (and reconnects 20 min later); c's channel
  // comes back 3 days after its first stream; e's last stream was 40 days before.
  await broadcast(a.channelId, at("16:00:00"), at("16:15:00"));
  await broadcast(a.channelId, at("16:35:00"));
  await broadcast(c.channelId, shift(-3), shift(-3, "14:00:00"));
  await broadcast(c.channelId, at("09:00:00"), at("10:00:00"));
  await broadcast(e.channelId, shift(-40), shift(-40, "13:00:00"));

  // Imports: one finished that day, one failed.
  await owner.insert(schema.portabilityImports).values([
    {
      id: uuidv7(),
      userId: c.id,
      channelId: c.channelId,
      source: "twitch",
      status: "done",
      finishedAt: at("19:00:00"),
    },
    {
      id: uuidv7(),
      userId: b.id,
      channelId: b.channelId,
      source: "twitch",
      status: "failed",
      finishedAt: at("19:00:00"),
    },
  ]);
  void late;

  values = await computeDay(t.app.sql, DAY);
}, 120_000);
afterAll(() => t?.drop());

describe("growth metrics for one day", () => {
  test("accounts: people only, verified ones apart", () => {
    expect(values.accounts_created).toBe(2);
    expect(values.accounts_verified).toBe(1);
  });
  test("first follow and first chat: once per account, within 7 days of it, on the day it happened", () => {
    expect(values.first_follow_within_7d).toBe(1);
    expect(values.first_chat_within_7d).toBe(1);
  });
  test("first support: a sub or tip that went through, never a member share", () => {
    expect(values.first_support_within_30d).toBe(1);
  });
  test("membership: a first join that day, and members at the day's end", () => {
    expect(values.became_member).toBe(1);
    expect(values.members_total).toBe(2);
  });
  test("alerts: email or push turned on, or a browser registered for push", () => {
    expect(values.notify_optin).toBe(2);
  });
  test("alerts: a re-save or an off-and-on later counts nobody again and keeps the first day", async () => {
    const later = "2026-06-12";
    const [a] = await owner.select().from(schema.users).where(eq(schema.users.username, "growtha"));
    const [c] = await owner.select().from(schema.users).where(eq(schema.users.username, "growthc"));
    if (!a || !c) throw new Error("fixture users missing");
    const pref = (userId: string, medium: "email" | "push") =>
      and(
        eq(schema.notificationPreferences.userId, userId),
        eq(schema.notificationPreferences.type, "go_live"),
        eq(schema.notificationPreferences.medium, medium),
      );
    // a re-saves the email alert that is already on; c turns push on (a row made off on DAY).
    await owner
      .update(schema.notificationPreferences)
      .set({ enabled: true, updatedAt: at("10:00:00", later) })
      .where(pref(a.id, "email"));
    await owner
      .update(schema.notificationPreferences)
      .set({ enabled: true, updatedAt: at("11:00:00", later) })
      .where(pref(c.id, "push"));
    expect((await computeDay(t.app.sql, later)).notify_optin).toBe(0);
    // c's first opt-in dates from when it was turned on (the trigger's now(), not either test day);
    // a stays on DAY.
    expect((await computeDay(t.app.sql, DAY)).notify_optin).toBe(2);
    const [cRow] = await owner
      .select({ at: schema.users.firstNotifyOptinAt })
      .from(schema.users)
      .where(eq(schema.users.id, c.id));
    expect(cRow?.at).not.toBeNull();
    // Turning it off again never clears a first opt-in.
    await owner
      .update(schema.notificationPreferences)
      .set({ enabled: false, updatedAt: at("17:00:00") })
      .where(pref(c.id, "push"));
    const [cAfter] = await owner
      .select({ at: schema.users.firstNotifyOptinAt })
      .from(schema.users)
      .where(eq(schema.users.id, c.id));
    expect(cAfter?.at).toEqual(cRow?.at);
    expect((await computeDay(t.app.sql, DAY)).notify_optin).toBe(2);
  });
  test("streams: a first stream, a return within 14 days (a reconnect is not one), active channels", () => {
    expect(values.first_live).toBe(1);
    expect(values.second_live_within_14d).toBe(1);
    expect(values.active_streamers).toBe(2);
  });
  test("imports: finished ones only", () => {
    expect(values.imports_finished).toBe(1);
  });
  test("the next day sees b's first follow, outside the 7-day rule for c", async () => {
    const next = await computeDay(t.app.sql, "2026-06-11");
    expect(next.first_follow_within_7d).toBe(1);
    expect(next.accounts_created).toBe(1);
    expect(next.first_live).toBe(0);
  });
});

describe("runs", () => {
  test("a first run fills the whole backfill window, then only the settle window", async () => {
    expect(await daysToCompute(t.app.sql, NOW)).toHaveLength(BACKFILL_DAYS);
    expect(await runGrowthDaily(t.app.sql, NOW)).toEqual({ days: BACKFILL_DAYS });
    const rows = await owner.select().from(schema.growthDaily);
    expect(rows).toHaveLength(BACKFILL_DAYS * GROWTH_METRICS.length);
    expect(new Set(rows.map((r) => r.day)).has(utcDay(NOW))).toBe(false);
    const due = await daysToCompute(t.app.sql, NOW);
    expect(due).toHaveLength(SETTLE_DAYS);
    expect(due.at(-1)).toBe(DAY);
  });

  test("a rerun upserts the same values, and a missing old day is filled again", async () => {
    const old = "2026-05-20";
    await owner.delete(schema.growthDaily).where(eq(schema.growthDaily.day, old));
    expect(await daysToCompute(t.app.sql, NOW)).toContain(old);
    await runGrowthDaily(t.app.sql, NOW);
    const day = await owner.select().from(schema.growthDaily).where(eq(schema.growthDaily.day, DAY));
    expect(Object.fromEntries(day.map((r) => [r.metric, Number(r.value)]))).toEqual(values);
    expect(await owner.select().from(schema.growthDaily)).toHaveLength(BACKFILL_DAYS * GROWTH_METRICS.length);
  });

  test("the scheduled job runs under its lock, and a busy lock skips", async () => {
    const valkey = createValkey(VALKEY_URL, { keyPrefix: `test:growth:${crypto.randomUUID()}:` });
    try {
      const ctx = { sql: t.app.sql, valkey, logger: quietLogger, now: () => NOW } as unknown as WorkerContext;
      const meta = { id: undefined, attemptsMade: 0 };
      expect(job.schedule).toEqual({ pattern: "35 0 * * *", tz: "UTC" });
      expect(job.data.safeParse({}).success).toBe(true);
      expect(await job.handler({}, ctx, meta)).toEqual({ days: SETTLE_DAYS });
      await valkey.set(GROWTH_DAILY_LOCK_KEY, "someone", "PX", 10_000);
      expect(await job.handler({}, ctx, meta)).toEqual({ skipped: 1 });
    } finally {
      await valkey.quit();
    }
  });
});
