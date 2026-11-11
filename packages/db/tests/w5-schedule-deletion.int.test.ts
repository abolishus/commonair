// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 5 (0059, 0060): the channel schedule's time zone and limits, and the marker a
 * scheduled deletion leaves on the subscriptions whose renewal it turned off. Run as the
 * least-privilege app role, as services do.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import * as s from "../src/schema/index.ts";
import { uuidv7 } from "../src/ids.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.drop();
});

/** Drizzle wraps the Postgres error; the trigger's message is on its cause. */
async function refused(p: Promise<unknown>, message: RegExp): Promise<void> {
  const error = await p.then(
    () => null,
    (e: unknown) => e as { message?: string; cause?: { message?: string } },
  );
  expect(error).not.toBeNull();
  expect(String(error?.cause?.message ?? error?.message)).toMatch(message);
}

async function newUser(): Promise<string> {
  const name = `w5_${uuidv7().replace(/-/g, "").slice(-12)}`;
  const [u] = await t.app.db
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: s.users.id });
  if (!u) throw new Error("no user");
  return u.id;
}

async function newChannel(): Promise<{ id: string; ownerId: string }> {
  const ownerId = await newUser();
  const [c] = await t.app.db
    .insert(s.channels)
    .values({ ownerId, slug: `c${ownerId.slice(-10)}`, displayName: "W5" })
    .returning({ id: s.channels.id });
  if (!c) throw new Error("no channel");
  return { id: c.id, ownerId };
}

const slot = (channelId: string, weekday = 1) =>
  t.app.db.insert(s.channelScheduleSlots).values({ channelId, weekday, startLocal: "19:00", durationMinutes: 120 });

describe("0060 schedule", () => {
  test("the time zone must be one Postgres knows", async () => {
    expect.hasAssertions();
    const c = await newChannel();
    await t.app.db.insert(s.channelSchedules).values({ channelId: c.id, timezone: "America/Toronto" });
    await refused(
      t.app.db
        .update(s.channelSchedules)
        .set({ timezone: "Mars/Olympus" })
        .where(eq(s.channelSchedules.channelId, c.id)),
      /known IANA time zone/,
    );
  });

  test("at most 21 weekly slots per channel; the checks bound weekday and duration", async () => {
    expect.hasAssertions();
    const c = await newChannel();
    for (let i = 0; i < 21; i++) await slot(c.id, (i % 7) + 1);
    await refused(slot(c.id), /at most 21/);
    const other = await newChannel();
    await refused(slot(other.id, 8), /channel_schedule_slots_weekday/);
    await refused(
      t.app.db
        .insert(s.channelScheduleSlots)
        .values({ channelId: other.id, weekday: 1, startLocal: "10:00", durationMinutes: 5 }),
      /channel_schedule_slots_duration/,
    );
  });

  test("a cancelled occurrence names a slot of the same channel", async () => {
    expect.hasAssertions();
    const a = await newChannel();
    const b = await newChannel();
    const [own] = await slot(a.id).returning({ id: s.channelScheduleSlots.id });
    const values = (channelId: string, cancelsSlotId: string) => ({
      channelId,
      startsAt: new Date("2030-01-07T19:00:00Z"),
      durationMinutes: 120,
      cancelsSlotId,
    });
    if (!own) throw new Error("no slot");
    await t.app.db.insert(s.channelScheduleOneOffs).values(values(a.id, own.id));
    await refused(t.app.db.insert(s.channelScheduleOneOffs).values(values(b.id, own.id)), /same channel/);
  });

  test("at most 100 one-offs per channel", async () => {
    expect.hasAssertions();
    const c = await newChannel();
    const rows = Array.from({ length: 100 }, (_, i) => ({
      channelId: c.id,
      startsAt: new Date(Date.UTC(2030, 0, 1 + i, 18)),
      durationMinutes: 60,
    }));
    await t.app.db.insert(s.channelScheduleOneOffs).values(rows);
    await refused(
      t.app.db
        .insert(s.channelScheduleOneOffs)
        .values({ channelId: c.id, startsAt: new Date("2031-01-01T00:00:00Z"), durationMinutes: 60 }),
      /at most 100/,
    );
  });
});

describe("0060 renewal stopped by a deletion", () => {
  async function setup() {
    const c = await newChannel();
    const subscriber = await newUser();
    const [sub] = await t.app.db
      .insert(s.subscriptions)
      .values({
        subscriberId: subscriber,
        channelId: c.id,
        tier: 1,
        status: "active",
        provider: "manual",
        priceCents: 499,
        currency: "usd",
      })
      .returning({ id: s.subscriptions.id });
    if (!sub) throw new Error("no subscription");
    const deletion = async (userId: string) => {
      const [d] = await t.app.db
        .insert(s.accountDeletions)
        .values({ userId, scheduledFor: new Date(Date.now() + 30 * 86_400_000) })
        .returning({ id: s.accountDeletions.id });
      if (!d) throw new Error("no deletion");
      return d.id;
    };
    return { c, subscriber, sub: sub.id, deletion };
  }
  const read = async (id: string) => {
    const [r] = await t.app.db
      .select({ marker: s.subscriptions.renewalStoppedByDeletionId, cancel: s.subscriptions.cancelAtPeriodEnd })
      .from(s.subscriptions)
      .where(eq(s.subscriptions.id, id));
    return r;
  };

  test("the subscriber's or the channel owner's deletion may stop renewal; a stranger's may not", async () => {
    const { c, subscriber, sub, deletion } = await setup();
    const mark = (id: string) =>
      t.app.db
        .update(s.subscriptions)
        .set({ cancelAtPeriodEnd: true, renewalStoppedByDeletionId: id })
        .where(eq(s.subscriptions.id, sub));
    await refused(mark(await deletion(await newUser())), /subscriber or the channel owner/);
    await mark(await deletion(subscriber));
    expect(await read(sub)).toMatchObject({ cancel: true });
    await mark(await deletion(c.ownerId));
    expect((await read(sub))?.marker).not.toBeNull();
  });

  test("turning renewal back on clears the marker", async () => {
    const { subscriber, sub, deletion } = await setup();
    const d = await deletion(subscriber);
    await t.app.db
      .update(s.subscriptions)
      .set({ cancelAtPeriodEnd: true, renewalStoppedByDeletionId: d })
      .where(eq(s.subscriptions.id, sub));
    await t.app.db
      .update(s.subscriptions)
      .set({ cancelAtPeriodEnd: false })
      .where(and(eq(s.subscriptions.id, sub), sql`true`));
    expect(await read(sub)).toEqual({ marker: null, cancel: false });
    // Without cancel_at_period_end a marker never sticks.
    await t.app.db.update(s.subscriptions).set({ renewalStoppedByDeletionId: d }).where(eq(s.subscriptions.id, sub));
    expect(await read(sub)).toEqual({ marker: null, cancel: false });
  });
});
