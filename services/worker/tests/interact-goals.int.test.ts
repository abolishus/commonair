// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Goal progress in the outbox relay transaction (ADR 0026 decision 5, Amendment 1), through
 * `relayOutboxBatch` against a real database and Valkey: each follow, subscribe row and tip counts
 * once, from the goal's start; the target ends the goal with `is_achieved`; a rolled-back batch
 * counts nothing and the retry counts once.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { relayOutboxBatch } from "../src/outbox.ts";
import { broadcasterFields, makeUser, setup, type TestEnv } from "./fixtures.ts";

let env: TestEnv;
beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false });
});
afterAll(async () => {
  await env.close();
});

const db = () => env.t.db;
type Owner = Awaited<ReturnType<typeof makeUser>>;
let s: Owner;
let fan: Owner;

beforeEach(async () => {
  s = await makeUser(db());
  fan = await makeUser(db());
});

const userFields = (u: Owner["user"]) => ({ user_id: u.id, user_login: u.username, user_name: u.name });

async function event(
  type: string,
  payload: Record<string, unknown>,
  occurredAt = new Date(),
  channelId = s.channel.id,
) {
  const [e] = await db()
    .insert(schema.events)
    .values({
      id: uuidv7(occurredAt.getTime()),
      type,
      channelId,
      payload: { ...broadcasterFields(s.user), ...payload },
      occurredAt,
    })
    .returning();
  return e!;
}
const follow = (at?: Date) =>
  event("channel.follow", { ...userFields(fan.user), followed_at: new Date().toISOString() }, at);
const subscribe = (isGift: boolean) =>
  event("channel.subscribe", { ...userFields(fan.user), tier: "1000", is_gift: isGift });
const gift = (total: number) =>
  event("channel.subscription.gift", { ...userFields(fan.user), total, tier: "1000", is_anonymous: false });
const tip = (value: number) =>
  event("channel.tip", {
    ...userFields(fan.user),
    is_anonymous: false,
    amount: { value, decimal_places: 2, currency: "usd" },
    message: "",
  });

async function goal(
  type: "followers" | "subscriptions" | "tips",
  target: number,
  startedAt = new Date(Date.now() - 60_000),
) {
  const [g] = await db()
    .insert(schema.goals)
    .values({ channelId: s.channel.id, type, title: `${type} goal`, target, startedAt })
    .returning();
  return g!;
}

const goalRow = async (id: string) => (await db().select().from(schema.goals).where(eq(schema.goals.id, id)))[0]!;
const goalEvents = (id: string) =>
  db()
    .select()
    .from(schema.events)
    .where(
      and(
        eq(schema.events.channelId, s.channel.id),
        inArray(schema.events.type, ["channel.goal.progress", "channel.goal.end"]),
      ),
    )
    .orderBy(asc(schema.events.occurredAt), asc(schema.events.id))
    .then((rows) => rows.filter((r) => (r.payload as { id?: string }).id === id));

/** Relay until the outbox is empty (the hook's own events are relayed in a later batch). */
async function drain() {
  while ((await relayOutboxBatch(env.worker.ctx, 200)) > 0);
}

describe("goal progress in the relay", () => {
  test("follows advance the followers goal once per event; one progress event per batch", async () => {
    const g = await goal("followers", 5);
    await follow();
    await follow();
    await drain();
    expect((await goalRow(g.id)).current).toBe(2);
    const evs = await goalEvents(g.id);
    expect(evs.map((e) => e.type)).toEqual(["channel.goal.progress"]);
    expect(evs[0]?.payload).toMatchObject({ current_amount: 2, target_amount: 5, description: "followers goal" });
    // Relaying the progress event itself (and again) counts nothing more.
    await drain();
    expect((await goalRow(g.id)).current).toBe(2);
  });

  test("reaching the target ends the goal (is_achieved) in the same transaction; later follows do nothing", async () => {
    const g = await goal("followers", 2);
    await follow();
    await drain();
    await follow();
    await follow();
    await drain();
    const row = await goalRow(g.id);
    expect(row.current).toBe(3);
    expect(row.endedAt).toBeInstanceOf(Date);
    const evs = await goalEvents(g.id);
    expect(evs.map((e) => e.type)).toEqual(["channel.goal.progress", "channel.goal.progress", "channel.goal.end"]);
    expect(evs[2]?.payload).toMatchObject({
      is_achieved: true,
      current_amount: 3,
      ended_at: row.endedAt!.toISOString(),
    });
    await follow();
    await drain();
    expect((await goalRow(g.id)).current).toBe(3);
    expect(await goalEvents(g.id)).toHaveLength(3);
  });

  test("exactly at the target ends it", async () => {
    const g = await goal("followers", 1);
    await follow();
    await drain();
    const row = await goalRow(g.id);
    expect(row).toMatchObject({ current: 1 });
    expect(row.endedAt).not.toBeNull();
  });

  test("events from before the goal started do not count", async () => {
    const g = await goal("followers", 5, new Date());
    await follow(new Date(Date.now() - 10_000));
    await follow();
    await drain();
    expect((await goalRow(g.id)).current).toBe(1);
  });

  test("subscriptions: every row counts, gifted ones included; the gift summary never does", async () => {
    const g = await goal("subscriptions", 10);
    await subscribe(false);
    await gift(2);
    await subscribe(true);
    await subscribe(true);
    await drain();
    expect((await goalRow(g.id)).current).toBe(3);
  });

  test("tips add their minor units; other channels and other types do not move the goal", async () => {
    const g = await goal("tips", 10_000);
    const followers = await goal("followers", 10);
    await tip(1250);
    await tip(50);
    const other = await makeUser(db());
    await event(
      "channel.tip",
      {
        ...userFields(fan.user),
        is_anonymous: true,
        amount: { value: 999, decimal_places: 2, currency: "usd" },
        message: "",
      },
      new Date(),
      other.channel.id,
    );
    await drain();
    expect((await goalRow(g.id)).current).toBe(1300);
    expect((await goalRow(followers.id)).current).toBe(0);
    expect(await goalEvents(followers.id)).toHaveLength(0);
  });

  test("a batch that rolls back counts nothing; the retry counts once", async () => {
    const g = await goal("followers", 10);
    await follow();
    const hung = { ...env.worker.ctx, enqueueBulk: () => new Promise<void>(() => {}) };
    await expect(relayOutboxBatch(hung, 200, 200)).rejects.toThrow(/timed out/);
    expect((await goalRow(g.id)).current).toBe(0);
    expect(await goalEvents(g.id)).toHaveLength(0);
    await drain();
    expect((await goalRow(g.id)).current).toBe(1);
    expect(await goalEvents(g.id)).toHaveLength(1);
  });

  test("an ended goal is not advanced, and a new goal of the type starts from 0", async () => {
    const old = await goal("followers", 10);
    await db().update(schema.goals).set({ endedAt: new Date() }).where(eq(schema.goals.id, old.id));
    const fresh = await goal("followers", 10, new Date());
    await follow();
    await drain();
    expect((await goalRow(old.id)).current).toBe(0);
    expect((await goalRow(fresh.id)).current).toBe(1);
  });
});
