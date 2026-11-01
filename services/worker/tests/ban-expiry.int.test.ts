// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Decision (z): a timed account suspension that lapsed is cleared by the `ban-expiry` sweep, which
 * writes `channel.suspension {suspended: false}` for the owner's channel, unless the channel is
 * suspended in its own right. Bans still in force, permanent bans and already-cleared ones are
 * left alone.
 */
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { schema } from "@commonair/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import type { WorkerContext } from "../src/context.ts";
import { clearLapsedBans } from "../src/moderation/ban-expiry.ts";
import { makeUser } from "./fixtures.ts";
import { suspensions } from "./media-state-helpers.ts";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
}, 60_000);
afterAll(() => t?.drop());

const now = new Date();
const ctx = () => ({ db: t.app.db, now: () => now }) as unknown as WorkerContext;

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
  // The channel's own suspension still holds, so its state did not change.
  expect((await user(ownRight.user.id)).banned).toBe(false);
  expect(await suspensions(t.db, ownRight.channel.id)).toEqual([]);
  for (const u of [live, permanent]) {
    expect((await user(u.user.id)).banned).toBe(true);
    expect(await suspensions(t.db, u.channel.id)).toEqual([]);
  }

  // A second pass finds nothing and writes nothing more.
  expect(await clearLapsedBans(ctx())).toEqual({ cleared: 0 });
  expect(await suspensions(t.db, lapsed.channel.id)).toEqual([false]);
});
