// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-platform's direct-insert writers against a migrated database, as the app role: the world
 * snapshot reads a minimal social fixture (written here, not with seed-social's internals), and
 * the notification, preference, go-live send, email queue, Discord and device-code rows land,
 * satisfy their constraints and point only at local hosts. The API-driven steps (apps, grants,
 * EventSub, push, federation, imports) are exercised by `seed full` live.
 */
import { NOTIFICATION_TYPES } from "@commonair/contracts/enums";
import { NOTIFY_SECRET_PURPOSES } from "@commonair/contracts/notify";
import { normalizeUserCode } from "@commonair/contracts/oauth";
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { decryptSecret, sha256Hex } from "@commonair/tokens";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { FIXED_ACCOUNTS, bulkStreamerHandle, bulkViewerHandle } from "../../src/seed/accounts.ts";
import {
  DAY_MS,
  HOUR_MS,
  type PlatformPlan,
  isLocalUrl,
  planPlatform,
  plannedDirectRows,
} from "../../src/seed/platform/plan.ts";
import {
  deliveryStates,
  emailDigestMinutes,
  insertDeviceCode,
  publicVodOf,
  queuedEmails,
  readWorld,
  tableCounts,
  writeDiscordWebhooks,
  writeEmailQueue,
  writeNotificationRows,
} from "../../src/seed/platform/write.ts";
import { createRng } from "../../src/seed/prng.ts";
import type { SeedScale } from "../../src/seed/scale.ts";
import type { SeedStore, SeededUser } from "../../src/seed/types.ts";

const SCALE: SeedScale = { streamers: 4, viewers: 8, chatLines: 0, historyDays: 45, factor: 1 };
const AUTH_SECRET = "seed-platform-int-auth-secret-0123456789";
const SINK = "http://host.containers.internal:45678";

let t: TestDatabase;
let store: SeedStore;
let plan: PlatformPlan;
let ids: Map<string, string>;
let written: Record<string, number>;
let discordRows = 0;
let queued = 0;
let deviceAppId = "";
let userCode = "";
const now = new Date();

/** The smallest social fixture the writers need: demo users, one channel each, follows, ended broadcasts. */
async function socialFixture(): Promise<SeedStore> {
  const db = t.app.db;
  const users: SeededUser[] = [];
  const handles = [
    ...FIXED_ACCOUNTS.filter((a) => !a.bot).map((a) => ({
      handle: a.handle,
      kind: "fixed" as const,
      role: a.platformRole,
    })),
    ...Array.from({ length: SCALE.streamers }, (_, i) => ({
      handle: bulkStreamerHandle(i + 1),
      kind: "bulk-streamer" as const,
      role: "user" as const,
    })),
    ...Array.from({ length: SCALE.viewers }, (_, i) => ({
      handle: bulkViewerHandle(i + 1),
      kind: "bulk-viewer" as const,
      role: "user" as const,
    })),
  ];
  const created = new Date(now.getTime() - SCALE.historyDays * DAY_MS);
  for (const h of handles) {
    const id = uuidv7();
    const username = `demo_${h.handle}`;
    const email = `${username}@demo-seed.invalid`;
    await db
      .insert(schema.users)
      .values({ id, name: h.handle, email, emailVerified: true, username, role: h.role, createdAt: created });
    users.push({ id, handle: h.handle, username, email, kind: h.kind, platformRole: h.role });
  }
  const channels: SeedStore["channels"] = [];
  for (const u of users) {
    const id = uuidv7();
    await db.insert(schema.channels).values({
      id,
      ownerId: u.id,
      slug: u.username,
      displayName: u.handle,
      createdAt: new Date(created.getTime() + DAY_MS),
    });
    if (
      u.kind === "bulk-streamer" ||
      ["streamer1", "streamer2", "streamer3", "council1", "council2"].includes(u.handle)
    )
      channels.push({ id, ownerId: u.id, ownerHandle: u.handle, slug: u.username });
  }
  const chOf = (h: string) => channels.find((c) => c.ownerHandle === h)?.id ?? "";
  const userOf = (h: string) => users.find((u) => u.handle === h)?.id ?? "";
  const followed = new Date(now.getTime() - 10 * DAY_MS);
  const follows = [
    ["viewer1", "streamer1"],
    ["viewer1", "streamer2"],
    ["viewer2", "streamer1"],
    [bulkViewerHandle(1), "streamer1"],
    [bulkViewerHandle(2), "streamer2"],
  ];
  for (const [f, c] of follows)
    await db
      .insert(schema.follows)
      .values({ followerId: userOf(f ?? ""), channelId: chOf(c ?? ""), notify: true, createdAt: followed });
  for (const h of ["streamer1", "streamer2"])
    await db.insert(schema.broadcasts).values({
      id: uuidv7(),
      channelId: chOf(h),
      ingestProtocol: "rtmp",
      path: `live/${h}`,
      title: `Recorded ${h}`,
      startedAt: new Date(now.getTime() - 2 * HOUR_MS),
      endedAt: new Date(now.getTime() - HOUR_MS),
    });
  return { users, channels, extra: {} };
}

beforeAll(async () => {
  t = await createTestDatabase();
  store = await socialFixture();
  ids = new Map(store.users.map((u) => [u.handle, u.id]));
  const world = await readWorld(t.app, store);
  plan = planPlatform(createRng(11).fork("platform"), SCALE, world, now);
  written = await writeNotificationRows(t.app, plan, ids);
  discordRows = await writeDiscordWebhooks(t.app, plan.discord, ids, { authSecret: AUTH_SECRET, sinkOrigin: SINK });
  const windowMin = await emailDigestMinutes(t.app);
  queued = await writeEmailQueue(t.app, plan.emailQueue, ids, new Date(now.getTime() - (windowMin + 1) * 60_000));
  deviceAppId = uuidv7();
  await t.app.db.insert(schema.oauthApps).values({
    id: deviceAppId,
    ownerId: ids.get("developer") ?? "",
    name: "Couch Remote",
    clientId: "seedplatformdeviceapp000000001",
    redirectUris: ["http://127.0.0.1/device/done"],
    confidential: false,
  });
  userCode = (await insertDeviceCode(t.app, { appId: deviceAppId, scopes: ["chat:read"], now, expiresInDays: 30 }))
    .userCode;
}, 120_000);

afterAll(async () => {
  await t?.drop();
});

describe("readWorld", () => {
  test("reads the fixture's users, channels, follows and ended broadcasts", async () => {
    const world = await readWorld(t.app, store);
    expect(world.users).toHaveLength(store.users.length);
    expect(world.users.map((u) => u.handle)).toEqual(store.users.map((u) => u.handle));
    expect(world.channels).toHaveLength(store.users.length);
    expect(world.follows.filter((f) => f.followerHandle === "viewer1")).toHaveLength(2);
    expect(world.broadcasts).toHaveLength(2);
    expect(world.proposalIds).toEqual([]);
    expect(world.restrictedUserIds).toEqual([]);
    const banned = store.users[0]?.id ?? "";
    const withSafety = await readWorld(t.app, { ...store, extra: { safety: { restrictedUserIds: [banned, 7] } } });
    expect(withSafety.restrictedUserIds).toEqual([banned]);
    expect(await publicVodOf(t.app, store.channels[0]?.id ?? "")).toBeNull();
  });
});

describe("direct-insert writers", () => {
  test("every planned row lands, and the reported counts are the table counts", async () => {
    const want = plannedDirectRows(plan);
    const have = await tableCounts(t.app, Object.keys(want));
    expect(written.notifications).toBe(want.notifications);
    expect(written.notification_preferences).toBe(want.notification_preferences);
    expect(written.notification_go_live_sends).toBe(want.notification_go_live_sends);
    expect(discordRows).toBe(want.discord_webhooks);
    expect(queued).toBe(want.notification_email_queue);
    expect(have).toEqual(want);
    expect(await queuedEmails(t.app, ids.get("viewer1") ?? "")).toBe(queued);
    expect(await tableCounts(t.app, ["events"])).toEqual({ events: 0 });
  });

  test("viewer1's inbox: every type, read and unread, none predating the account", async () => {
    const rows = await t.app.db.select().from(schema.notifications);
    const v1 = rows.filter((n) => n.userId === ids.get("viewer1"));
    expect(new Set(v1.map((n) => n.type)).size).toBe(NOTIFICATION_TYPES.length);
    expect(v1.some((n) => n.readAt === null)).toBe(true);
    expect(v1.some((n) => n.readAt !== null)).toBe(true);
    const users = await t.app.db.select().from(schema.users);
    const created = new Map(users.map((u) => [u.id, u.createdAt.getTime()]));
    for (const n of rows) expect(n.createdAt.getTime()).toBeGreaterThanOrEqual(created.get(n.userId) ?? Infinity);
  });

  test("nothing personal in notification payloads", async () => {
    const rows = await t.app.db.select().from(schema.notifications);
    const text = JSON.stringify(rows.map((r) => r.payload));
    for (const u of store.users) {
      expect(text.includes(u.email), u.email).toBe(false);
      expect(text.includes(`"${u.username}"`) && !store.channels.some((c) => c.slug === u.username), u.username).toBe(
        false,
      );
    }
  });

  test("Discord webhooks decrypt to the local sink only", async () => {
    const rows = await t.app.db.select().from(schema.discordWebhooks);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const url = await decryptSecret(AUTH_SECRET, NOTIFY_SECRET_PURPOSES.discordWebhook, r.url);
      expect(url.startsWith(SINK)).toBe(true);
      expect(isLocalUrl(url, ["host.containers.internal"])).toBe(true);
    }
    expect(rows.some((r) => r.lastError === "not_found" && r.failures === 2)).toBe(true);
  });

  test("the direct device code is pending, long-lived, and found by its normalized user code", async () => {
    const hash = await sha256Hex(normalizeUserCode(userCode));
    const [row] = await t.app.db.select().from(schema.oauthDeviceCodes);
    expect(row?.userCodeHash).toBe(hash);
    expect(row?.status).toBe("pending");
    expect(row?.userId).toBeNull();
    expect((row?.expiresAt.getTime() ?? 0) - now.getTime()).toBe(30 * DAY_MS);
  });

  test("delivery states read as zero with no subscriptions", async () => {
    expect(await deliveryStates(t.app, [])).toEqual({ delivered: 0, failed: 0, retrying: 0 });
    expect(await deliveryStates(t.app, [uuidv7()])).toEqual({ delivered: 0, failed: 0, retrying: 0 });
  });
});
