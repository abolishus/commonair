// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Fair predictions against the real database as the app role (batch 7 decision (v)): a lock on
 * a live channel stores the media-clock edge (the worker's late auto-lock stores `locksAt`), an
 * offline lock stores none, a settlement records its resolver, and migration 0046's trigger
 * refuses what the API refuses: a bet at or after `lock_media_ts` or without a media time after
 * the lock, a bet on a settled prediction, and the owner's, a moderator's or an editor's bet.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { lockPredictionInTx, settlePredictionInTx } from "../src/predictions.ts";

let t: TestDatabase;
let app: Database;
beforeAll(async () => {
  t = await createTestDatabase();
  app = t.app.db;
}, 120_000);
afterAll(async () => {
  await t?.drop();
});

const rand = () => uuidv7().replace(/-/g, "").slice(-10);

async function user(): Promise<string> {
  const name = `f${rand()}`;
  const [u] = await t.db
    .insert(schema.users)
    .values({ name, username: name, email: `${name}@example.test`, emailVerified: true })
    .returning({ id: schema.users.id });
  return u!.id;
}

async function channel(opts: { liveSince?: Date } = {}): Promise<{ id: string; ownerId: string }> {
  const ownerId = await user();
  const slug = `c${rand()}`;
  const [c] = await t.db
    .insert(schema.channels)
    .values({ ownerId, slug, displayName: slug })
    .returning({ id: schema.channels.id });
  if (opts.liveSince) {
    const [b] = await t.db
      .insert(schema.broadcasts)
      .values({ channelId: c!.id, ingestProtocol: "rtmp", path: `live/${slug}`, startedAt: opts.liveSince })
      .returning({ id: schema.broadcasts.id });
    await t.db.update(schema.channels).set({ liveBroadcastId: b!.id }).where(eq(schema.channels.id, c!.id));
  }
  return { id: c!.id, ownerId };
}

async function prediction(channelId: string, locksAt = new Date(Date.now() + 60_000)): Promise<string> {
  const id = uuidv7();
  await t.db.insert(schema.predictions).values({
    id,
    channelId,
    title: "Who wins?",
    outcomes: ["A", "B"].map((o) => ({ id: o, title: o, points: 0, users: 0 })),
    windowSeconds: 60,
    locksAt,
  });
  return id;
}

const row = async (id: string) =>
  (await t.db.select().from(schema.predictions).where(eq(schema.predictions.id, id)))[0]!;

/** A direct insert as the app role (no ledger row: the trigger is what is under test). */
const insertBet = (predictionId: string, userId: string, mediaTs: Date | null, outcomeId = "A") =>
  app.insert(schema.predictionBets).values({ predictionId, userId, outcomeId, points: 1, mediaTs });

/** The error and its causes, as one string (drizzle wraps the driver error). */
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const parts: string[] = [];
    for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) parts.push(String((e as Error).message));
    return parts.join(" | ");
  }
  return "accepted";
}

describe("lockPredictionInTx stores the media lock", () => {
  test("live: the edge at the lock (now)", async () => {
    const c = await channel({ liveSince: new Date(Date.now() - 600_000) });
    const p = await prediction(c.id);
    const now = new Date();
    await app.transaction((tx) => lockPredictionInTx(tx, p, now));
    expect(await row(p)).toMatchObject({ status: "locked", lockedAt: now, lockMediaTs: now });
  });

  test("the worker's late auto-lock stores locksAt, not the tick time", async () => {
    const c = await channel({ liveSince: new Date(Date.now() - 600_000) });
    const locksAt = new Date(Date.now() - 1_500);
    const p = await prediction(c.id, locksAt);
    const now = new Date();
    await app.transaction((tx) => lockPredictionInTx(tx, p, now));
    expect(await row(p)).toMatchObject({ lockedAt: now, lockMediaTs: locksAt });
  });

  test("offline: no media clock, no media lock", async () => {
    const c = await channel();
    const p = await prediction(c.id);
    await app.transaction((tx) => lockPredictionInTx(tx, p, new Date()));
    expect(await row(p)).toMatchObject({ status: "locked", lockMediaTs: null });
  });
});

describe("the 0046 bet trigger", () => {
  test("after the lock: before lock_media_ts is taken; at it, after it or without a media time is refused", async () => {
    const c = await channel({ liveSince: new Date(Date.now() - 600_000) });
    const p = await prediction(c.id);
    const early = await user();
    await insertBet(p, early, null); // before the lock a missing media time is fine
    const now = new Date();
    await app.transaction((tx) => lockPredictionInTx(tx, p, now));
    const lockMediaTs = (await row(p)).lockMediaTs!;

    expect(await refusal(insertBet(p, await user(), new Date(lockMediaTs.getTime() - 1)))).toBe("accepted");
    expect(await refusal(insertBet(p, await user(), lockMediaTs))).toMatch(/media time betting locked/);
    expect(await refusal(insertBet(p, await user(), new Date(lockMediaTs.getTime() + 5_000)))).toMatch(
      /media time betting locked/,
    );
    expect(await refusal(insertBet(p, await user(), null))).toMatch(/no media time/);
  });

  test("the owner, a moderator and an editor are refused; a VIP is not", async () => {
    const c = await channel();
    const p = await prediction(c.id);
    const [mod, editor, vip] = [await user(), await user(), await user()];
    await t.db.insert(schema.channelRoles).values([
      { channelId: c.id, userId: mod, role: "moderator" },
      { channelId: c.id, userId: editor, role: "editor" },
      { channelId: c.id, userId: vip, role: "vip" },
    ]);
    for (const team of [c.ownerId, mod, editor])
      expect(await refusal(insertBet(p, team, new Date()))).toMatch(/owner, moderators and editors cannot bet/);
    expect(await refusal(insertBet(p, vip, new Date()))).toBe("accepted");
  });

  test("a settled prediction takes no bets; the settlement records its resolver", async () => {
    const c = await channel();
    const p = await prediction(c.id);
    const resolver = await user();
    // Bets go in before the resolve (the trigger refuses them after).
    await insertBet(p, await user(), null, "A");
    await app.transaction((tx) => lockPredictionInTx(tx, p, new Date()));
    // A cancel refunds the 1-point stake (a credit, so the missing debit does not matter here).
    const settled = await app.transaction((tx) => settlePredictionInTx(tx, p, null, new Date(), resolver));
    expect(settled?.row).toMatchObject({ status: "canceled", resolvedById: resolver });
    expect(settled).toMatchObject({ pool: 1, winners: 0, payoutSum: 1 });
    expect(await refusal(insertBet(p, await user(), null))).toMatch(/is canceled and takes no bets/);
  });
});
