// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Decision (z): a timed account suspension that lapsed is cleared by the `ban-expiry` sweep, which
 * writes `channel.suspension {suspended: false}` for the owner's channel, unless the channel is
 * suspended in its own right. Bans still in force, permanent bans and already-cleared ones are
 * left alone. Each clear has its `user.ban_lapsed` audit row.
 *
 * Decision (g) backstop: an unsuspension the API's sign-in hook lost (the ban cleared, the latest
 * `channel.suspension` still `true`) is written by the sweep, once, even racing a sign-in.
 */
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { schema } from "@commonair/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { WorkerContext } from "../src/context.ts";
import { job, clearLapsedBans, recoverLostUnsuspensions } from "../src/moderation/ban-expiry.ts";
import { emit } from "../src/moderation/records.ts";
import { makeUser, quietLogger } from "./fixtures.ts";
import { suspensions } from "./media-state-helpers.ts";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
}, 60_000);
afterAll(() => t?.drop());

const now = new Date();
const ctx = () => ({ db: t.app.db, now: () => now, logger: quietLogger }) as unknown as WorkerContext;

async function banned(banExpires: Date | null, channelSuspended = false) {
  const u = await makeUser(t.db);
  await t.db
    .update(schema.users)
    .set({ banned: true, banReason: "moderation", banExpires })
    .where(eq(schema.users.id, u.user.id));
  if (channelSuspended)
    await t.db
      .update(schema.channels)
      .set({ suspendedAt: now, suspendedReason: "moderation" })
      .where(eq(schema.channels.id, u.channel.id));
  return u;
}

/** `via` of each `user.ban_lapsed` audit row about `userId`, oldest first; all actor `system`. */
async function lapses(userId: string): Promise<unknown[]> {
  const rows = await t.db
    .select({ actorType: schema.auditLog.actorType, details: schema.auditLog.details })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, "user.ban_lapsed"), eq(schema.auditLog.subjectId, userId)))
    .orderBy(asc(schema.auditLog.createdAt), asc(schema.auditLog.id));
  for (const r of rows) expect(r.actorType).toBe("system");
  return rows.map((r) => r.details.via);
}

test("a lapsed ban is cleared with its unsuspension; live and permanent bans stay", async () => {
  const lapsed = await banned(new Date(now.getTime() - 60_000));
  const ownRight = await banned(new Date(now.getTime() - 60_000), true);
  const live = await banned(new Date(now.getTime() + 60_000));
  const permanent = await banned(null);

  expect(await clearLapsedBans(ctx())).toEqual({ cleared: 2 });

  const user = async (id: string) => (await t.db.select().from(schema.users).where(eq(schema.users.id, id)))[0]!;
  expect((await user(lapsed.user.id)).banned).toBe(false);
  expect((await user(lapsed.user.id)).banExpires).toBeNull();
  expect(await suspensions(t.db, lapsed.channel.id)).toEqual([false]);
  expect(await lapses(lapsed.user.id)).toEqual(["sweep"]);
  // The channel's own suspension still holds, so its state did not change; the clear is audited.
  expect((await user(ownRight.user.id)).banned).toBe(false);
  expect(await suspensions(t.db, ownRight.channel.id)).toEqual([]);
  expect(await lapses(ownRight.user.id)).toEqual(["sweep"]);
  for (const u of [live, permanent]) {
    expect((await user(u.user.id)).banned).toBe(true);
    expect(await suspensions(t.db, u.channel.id)).toEqual([]);
    expect(await lapses(u.user.id)).toEqual([]);
  }

  // A second pass finds nothing and writes nothing more.
  expect(await clearLapsedBans(ctx())).toEqual({ cleared: 0 });
  expect(await suspensions(t.db, lapsed.channel.id)).toEqual([false]);
  expect(await lapses(lapsed.user.id)).toEqual(["sweep"]);
});

describe("recoverLostUnsuspensions (decision (g) backstop)", () => {
  /** A suspension announced, then cleared at sign-in with the hook's event lost. */
  async function lostHook() {
    const u = await makeUser(t.db);
    await emit(
      t.db,
      "channel.suspension",
      u.channel.id,
      { channel_id: u.channel.id, suspended: true },
      new Date(now.getTime() - 120_000),
    );
    return u;
  }

  test("writes the lost event and its audit row once", async () => {
    const u = await lostHook();
    // The job clears, then recovers.
    expect(await job.handler({}, ctx(), {} as never)).toMatchObject({ recovered: 1 });
    expect(await suspensions(t.db, u.channel.id)).toEqual([true, false]);
    expect(await lapses(u.user.id)).toEqual(["recovery"]);
    expect(await recoverLostUnsuspensions(ctx())).toEqual({ recovered: 0 });
    expect(await suspensions(t.db, u.channel.id)).toEqual([true, false]);
    expect(await lapses(u.user.id)).toEqual(["recovery"]);
  });

  test("the recovered event sorts after the one it answers, even one stamped ahead of our clock", async () => {
    const u = await makeUser(t.db);
    // The API's clock ran 2 s ahead of the worker's when it announced the suspension.
    const ahead = new Date(now.getTime() + 2_000);
    await emit(t.db, "channel.suspension", u.channel.id, { channel_id: u.channel.id, suspended: true }, ahead);
    expect(await recoverLostUnsuspensions(ctx())).toEqual({ recovered: 1 });
    const [last] = await t.db
      .select({ occurredAt: schema.events.occurredAt })
      .from(schema.events)
      .where(and(eq(schema.events.channelId, u.channel.id), eq(schema.events.type, "channel.suspension")))
      .orderBy(desc(schema.events.occurredAt), desc(schema.events.id))
      .limit(1);
    expect(last!.occurredAt.getTime()).toBeGreaterThan(ahead.getTime());
    expect(await suspensions(t.db, u.channel.id)).toEqual([true, false]);
    // Settled: the next run owes nothing.
    expect(await recoverLostUnsuspensions(ctx())).toEqual({ recovered: 0 });
    expect(await lapses(u.user.id)).toEqual(["recovery"]);
  });

  test("leaves suspensions still in force, uncleared lapsed bans and settled channels alone", async () => {
    const own = await lostHook();
    await t.db.update(schema.channels).set({ suspendedAt: now }).where(eq(schema.channels.id, own.channel.id));
    const live = await lostHook();
    await t.db
      .update(schema.users)
      .set({ banned: true, banExpires: new Date(now.getTime() + 60_000) })
      .where(eq(schema.users.id, live.user.id));
    // Lapsed but not yet cleared: `clearLapsedBans` announces it, so recovery must not as well.
    const uncleared = await lostHook();
    await t.db
      .update(schema.users)
      .set({ banned: true, banExpires: new Date(now.getTime() - 60_000) })
      .where(eq(schema.users.id, uncleared.user.id));
    const settled = await lostHook();
    await emit(
      t.db,
      "channel.suspension",
      settled.channel.id,
      { channel_id: settled.channel.id, suspended: false },
      now,
    );
    const never = await makeUser(t.db);

    const before = await recoverLostUnsuspensions(ctx());
    for (const u of [own, live, uncleared]) expect(await suspensions(t.db, u.channel.id)).toEqual([true]);
    expect(await suspensions(t.db, settled.channel.id)).toEqual([true, false]);
    expect(await suspensions(t.db, never.channel.id)).toEqual([]);
    for (const u of [own, live, uncleared, settled, never]) expect(await lapses(u.user.id)).toEqual([]);
    expect(before).toEqual({ recovered: 0 });

    // The whole job on the uncleared one: one event, from the clear, not two.
    await job.handler({}, ctx(), {} as never);
    expect(await suspensions(t.db, uncleared.channel.id)).toEqual([true, false]);
    expect(await lapses(uncleared.user.id)).toEqual(["sweep"]);
  });

  test("two sweeps and a sign-in at once: one event, one audit row", async () => {
    const u = await lostHook();
    // The API's `recordLapsedUnsuspension` (services/api/src/auth/index.ts): lock the owner's
    // channels, write only while the latest event still says suspended and nothing suspends it.
    const signInHook = () =>
      t.app.db.transaction(async (tx) => {
        await tx
          .select({ id: schema.channels.id })
          .from(schema.channels)
          .where(eq(schema.channels.ownerId, u.user.id))
          .for("update");
        const [last] = await tx
          .select({ suspended: sql<boolean | null>`(${schema.events.payload}->>'suspended')::boolean` })
          .from(schema.events)
          .where(and(eq(schema.events.channelId, u.channel.id), eq(schema.events.type, "channel.suspension")))
          .orderBy(desc(schema.events.occurredAt), desc(schema.events.id))
          .limit(1);
        if (last?.suspended !== true) return 0;
        await emit(tx, "channel.suspension", u.channel.id, { channel_id: u.channel.id, suspended: false }, now);
        await tx.insert(schema.auditLog).values({
          actorType: "system",
          action: "user.ban_lapsed",
          subjectType: "user",
          subjectId: u.user.id,
          channelId: u.channel.id,
          details: { userId: u.user.id, via: "sign_in" },
        });
        return 1;
      });
    const [a, b, c] = await Promise.all([
      recoverLostUnsuspensions(ctx()),
      recoverLostUnsuspensions(ctx()),
      signInHook(),
    ]);
    expect(a.recovered + b.recovered + c).toBe(1);
    expect(await suspensions(t.db, u.channel.id)).toEqual([true, false]);
    expect(await lapses(u.user.id)).toHaveLength(1);
  });
});

test("two sweeps at once clear a lapsed ban once: one unsuspension, one audit row", async () => {
  const u = await banned(new Date(now.getTime() - 60_000));
  const [a, b] = await Promise.all([clearLapsedBans(ctx()), clearLapsedBans(ctx())]);
  expect(a.cleared + b.cleared).toBe(1);
  expect(await suspensions(t.db, u.channel.id)).toEqual([false]);
  expect(await lapses(u.user.id)).toEqual(["sweep"]);
});

test("a lapsed ban of an owner without a channel is cleared and audited without one", async () => {
  const u = await banned(new Date(now.getTime() - 60_000));
  await t.db.delete(schema.channels).where(eq(schema.channels.id, u.channel.id));
  expect((await clearLapsedBans(ctx())).cleared).toBeGreaterThanOrEqual(1);
  const [row] = await t.db
    .select({ channelId: schema.auditLog.channelId, details: schema.auditLog.details })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, "user.ban_lapsed"), eq(schema.auditLog.subjectId, u.user.id)));
  expect(row).toEqual({ channelId: null, details: { userId: u.user.id, via: "sweep" } });
});

test("the batch size bounds one pass; the next pass takes the rest, oldest expiry first", async () => {
  const older = await banned(new Date(now.getTime() - 3_600_000 * 24 * 365 * 5));
  const newer = await banned(new Date(now.getTime() - 1_000));
  expect(await clearLapsedBans(ctx(), 1)).toEqual({ cleared: 1 });
  expect(await lapses(older.user.id)).toEqual(["sweep"]);
  expect(await lapses(newer.user.id)).toEqual([]);
  expect(await clearLapsedBans(ctx(), 1)).toEqual({ cleared: 1 });
  expect(await lapses(newer.user.id)).toEqual(["sweep"]);
});
