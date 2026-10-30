// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * N1 schema (0039, 0040; ADR 0028): the go-live governance setting is range-checked, one default
 * and one override per channel per medium (nulls not distinct), go-live notifications dedupe per
 * user, and deleting a channel cascades its notification working state.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import type { Database } from "../src/client.ts";
import { uuidv7 } from "../src/ids.ts";
import * as s from "../src/schema/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let app: Database;
let owner: Database;

beforeAll(async () => {
  t = await createTestDatabase();
  app = t.app.db;
  owner = t.db;
});
afterAll(async () => {
  await t?.drop();
});

async function expectPgError(p: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  const err = await Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, "expected the database to reject").toBeInstanceOf(Error);
  const e = err as Error & { cause?: Error };
  expect(e.cause?.message ?? e.message).toMatch(pattern);
}

async function newUser(): Promise<string> {
  const name = `n1_${uuidv7().replace(/-/g, "").slice(-12)}`;
  const [u] = await owner
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: s.users.id });
  return u!.id;
}

async function newChannel(): Promise<string> {
  const ownerId = await newUser();
  const [c] = await owner
    .insert(s.channels)
    .values({ ownerId, slug: `c${ownerId.slice(-10)}`, displayName: "N1" })
    .returning({ id: s.channels.id });
  return c!.id;
}

describe("notifications.goLive", () => {
  const valid = { cooldownHours: 4, emailDigestMinutes: 5 };
  const insert = (value: unknown) =>
    owner
      .insert(s.governanceSettings)
      .values({ key: "notifications.goLive", description: "x", protected: false, value });

  test("the seeded default is present and readable by the app role", async () => {
    const [row] = await app
      .select()
      .from(s.governanceSettings)
      .where(eq(s.governanceSettings.key, "notifications.goLive"));
    expect(row?.value).toEqual(valid);
    expect(row?.protected).toBe(false);
  });

  test("accepts the default (the insert reaches the unique key, past the check)", async () => {
    await expectPgError(insert(valid), /duplicate key/);
  });

  // Updates only happen through applied proposals (0001's settings guard); the check is BEFORE
  // INSERT OR UPDATE, so inserts exercise it.
  test.each([
    ["{1, 0}", { cooldownHours: 1, emailDigestMinutes: 0 }],
    ["{48, 60}", { cooldownHours: 48, emailDigestMinutes: 60 }],
  ])("accepts the bound %s", async (_name, v) => {
    await expectPgError(insert(v), /duplicate key/);
  });

  test.each([
    ["missing emailDigestMinutes", { cooldownHours: 4 }],
    ["missing cooldownHours", { emailDigestMinutes: 5 }],
    ["cooldownHours 0", { ...valid, cooldownHours: 0 }],
    ["cooldownHours 49", { ...valid, cooldownHours: 49 }],
    ["emailDigestMinutes 61", { ...valid, emailDigestMinutes: 61 }],
    ["emailDigestMinutes 1.5", { ...valid, emailDigestMinutes: 1.5 }],
    ["string value", { ...valid, cooldownHours: "4" }],
  ])("refuses %s", async (_name, v) => {
    await expectPgError(insert(v), /notifications\.goLive (needs|values)/);
  });
});

describe("notification_preferences", () => {
  test("one default per (user, type, medium): nulls are not distinct", async () => {
    const u = await newUser();
    const row = { userId: u, type: "go_live" as const, medium: "email" as const, channelId: null, enabled: true };
    await app.insert(s.notificationPreferences).values(row);
    await expectPgError(app.insert(s.notificationPreferences).values(row), /notification_prefs_uq/);
    // Another medium is its own default.
    await app.insert(s.notificationPreferences).values({ ...row, medium: "push" });
  });

  test("overrides for two channels coexist, the same channel twice does not", async () => {
    const [u, c1, c2] = [await newUser(), await newChannel(), await newChannel()];
    const row = { userId: u, type: "go_live" as const, medium: "in_app" as const, enabled: false };
    await app.insert(s.notificationPreferences).values({ ...row, channelId: c1 });
    await app.insert(s.notificationPreferences).values({ ...row, channelId: c2 });
    await app.insert(s.notificationPreferences).values({ ...row, channelId: null });
    await expectPgError(
      app.insert(s.notificationPreferences).values({ ...row, channelId: c1 }),
      /notification_prefs_uq/,
    );
  });

  test("an upsert can target the constraint for a default row", async () => {
    const u = await newUser();
    const row = { userId: u, type: "go_live" as const, medium: "email" as const, channelId: null, enabled: true };
    for (const enabled of [true, false]) {
      await app
        .insert(s.notificationPreferences)
        .values({ ...row, enabled })
        .onConflictDoUpdate({
          target: [
            s.notificationPreferences.userId,
            s.notificationPreferences.type,
            s.notificationPreferences.medium,
            s.notificationPreferences.channelId,
          ],
          set: { enabled },
        });
    }
    const rows = await app.select().from(s.notificationPreferences).where(eq(s.notificationPreferences.userId, u));
    expect(rows.map((r) => r.enabled)).toEqual([false]);
  });
});

describe("notifications.dedupe_key", () => {
  test("refuses the same (user, dedupe_key) twice and allows many nulls", async () => {
    const [u, v] = [await newUser(), await newUser()];
    const key = `go-live-${uuidv7()}`;
    await app.insert(s.notifications).values({ userId: u, type: "go_live", dedupeKey: key });
    await expectPgError(
      app.insert(s.notifications).values({ userId: u, type: "go_live", dedupeKey: key }),
      /notifications_dedupe_uq/,
    );
    // The same key for another member is fine; a skipped duplicate is how the fan-out stays idempotent.
    await app.insert(s.notifications).values({ userId: v, type: "go_live", dedupeKey: key });
    const skipped = await app
      .insert(s.notifications)
      .values({ userId: u, type: "go_live", dedupeKey: key })
      .onConflictDoNothing()
      .returning({ id: s.notifications.id });
    expect(skipped).toEqual([]);
    await app.insert(s.notifications).values([
      { userId: u, type: "system" },
      { userId: u, type: "system" },
    ]);
    const rows = await app.select().from(s.notifications).where(eq(s.notifications.userId, u));
    expect(rows).toHaveLength(3);
  });
});

describe("channel deletion", () => {
  test("cascades preferences, sends, queue rows and the Discord webhook", async () => {
    const [u, c] = [await newUser(), await newChannel()];
    const [b] = await app
      .insert(s.broadcasts)
      .values({ channelId: c, ingestProtocol: "rtmp", path: "live/n1" })
      .returning({ id: s.broadcasts.id });
    const eventId = uuidv7();
    await app
      .insert(s.notificationPreferences)
      .values({ userId: u, type: "go_live", medium: "email", channelId: c, enabled: true });
    await app.insert(s.notificationGoLiveSends).values({ userId: u, channelId: c, lastSentAt: new Date(), eventId });
    await app.insert(s.notificationEmailQueue).values({ userId: u, eventId, channelId: c, broadcastId: b!.id });
    await app.insert(s.discordWebhooks).values({ channelId: c, url: "v1.ciphertext", setBy: u });
    await app.insert(s.pushSubscriptions).values({ userId: u, endpointHash: `h${uuidv7()}`, subscription: "x" });

    await owner.delete(s.channels).where(eq(s.channels.id, c));

    expect(await app.select().from(s.notificationPreferences).where(eq(s.notificationPreferences.userId, u))).toEqual(
      [],
    );
    expect(await app.select().from(s.notificationGoLiveSends).where(eq(s.notificationGoLiveSends.userId, u))).toEqual(
      [],
    );
    expect(await app.select().from(s.notificationEmailQueue).where(eq(s.notificationEmailQueue.userId, u))).toEqual([]);
    expect(await app.select().from(s.discordWebhooks).where(eq(s.discordWebhooks.channelId, c))).toEqual([]);
    // Push subscriptions belong to the member, not the channel.
    expect(await app.select().from(s.pushSubscriptions).where(eq(s.pushSubscriptions.userId, u))).toHaveLength(1);
  });

  test("push_subscriptions.endpoint_hash is unique", async () => {
    const [u, v] = [await newUser(), await newUser()];
    const endpointHash = `h${uuidv7()}`;
    await app.insert(s.pushSubscriptions).values({ userId: u, endpointHash, subscription: "x" });
    await expectPgError(
      app.insert(s.pushSubscriptions).values({ userId: v, endpointHash, subscription: "y" }),
      /push_subscriptions_endpointHash_unique/,
    );
  });
});
