// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-schedule's writes against a real database: the rows land, the 0060 triggers accept them,
 * a rerun replaces rather than duplicates, and streamer1's skip falls exactly on its slot's
 * occurrence in the channel's time zone.
 */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createRng } from "../../src/seed/prng.ts";
import { planSchedules } from "../../src/seed/schedule/plan.ts";
import { writeSchedules } from "../../src/seed/schedule/write.ts";

let t: TestDatabase;
const channels: { id: string; ownerHandle: string }[] = [];
let categoryId = "";

beforeAll(async () => {
  t = await createTestDatabase();
  for (const handle of ["streamer1", "streamer3", "s0001", "s0002"]) {
    const username = `${handle}${uuidv7().slice(-6)}`;
    const [u] = await t.db
      .insert(schema.users)
      .values({ name: handle, email: `${username}@example.test`, username })
      .returning({ id: schema.users.id });
    const [c] = await t.db
      .insert(schema.channels)
      .values({ ownerId: u?.id ?? "", slug: username, displayName: handle })
      .returning({ id: schema.channels.id });
    channels.push({ id: c?.id ?? "", ownerHandle: handle });
  }
  const [cat] = await t.db
    .insert(schema.categories)
    .values({ slug: `sched${uuidv7().slice(-6)}`, name: "Strategy" })
    .returning({ id: schema.categories.id });
  categoryId = cat?.id ?? "";
}, 60_000);
afterAll(async () => {
  await t?.drop();
});

describe("writeSchedules", () => {
  test("writes, replaces on a rerun, and skips a real occurrence", async () => {
    const now = new Date("2026-11-11T15:20:00Z");
    const plans = planSchedules(createRng(1).fork("schedule"), channels, [categoryId], now);
    // As the services' role, so the 0060 triggers apply.
    await writeSchedules(t.app, plans, now);
    await writeSchedules(t.app, plans, now);

    const schedules = await t.db.select().from(schema.channelSchedules);
    expect(schedules).toHaveLength(plans.length);
    const slots = await t.db.select().from(schema.channelScheduleSlots);
    expect(slots).toHaveLength(plans.reduce((n, p) => n + p.slots.length, 0));
    const oneOffs = await t.db.select().from(schema.channelScheduleOneOffs);
    // One one-off each, plus streamer1's skip.
    expect(oneOffs).toHaveLength(plans.length + 1);

    const s1 = plans.find((p) => p.ownerHandle === "streamer1");
    const s1Slot = s1?.slots[0];
    if (!s1 || !s1Slot) throw new Error("no streamer1 plan");
    const [skip] = oneOffs.filter((r) => r.channelId === s1.channelId && r.cancelsSlotId !== null);
    if (!skip) throw new Error("no skip");
    // The skip's local wall time and weekday in Toronto are the slot's, one to two weeks out.
    const [local] = await t.sql<{ dow: number; hhmm: string }[]>`
      select extract(isodow from ${skip.startsAt.toISOString()}::timestamptz at time zone 'America/Toronto')::int as dow,
             to_char(${skip.startsAt.toISOString()}::timestamptz at time zone 'America/Toronto', 'HH24:MI') as hhmm`;
    expect(local).toEqual({ dow: s1Slot.weekday, hhmm: s1Slot.startLocal });
    const ahead = skip.startsAt.getTime() - now.getTime();
    expect(ahead).toBeGreaterThan(6 * 86_400_000);
    expect(ahead).toBeLessThan(15 * 86_400_000);
    const slot = slots.find((s) => s.id === skip.cancelsSlotId);
    expect(slot?.channelId).toBe(s1.channelId);
  });
});
