// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `me.moderates` (overhaul wave 3, J5-a): the channels the caller holds a moderator or editor role
 * on. Never their own channel, never a VIP role, never a revoked role or a suspended channel; live
 * channels first; one row per channel even with both roles.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { ModeratedChannel } from "@commonair/contracts/dto";
import { schema, uuidv7 } from "@commonair/db";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type User = Awaited<ReturnType<typeof signUpAndSignIn>>;

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;
const people = async (n: number): Promise<User[]> => Promise.all(Array.from({ length: n }, () => signUpAndSignIn(api)));

async function channelOf(owner: User) {
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.ownerId, owner.userId));
  if (!c) throw new Error("no channel");
  return c;
}

async function grant(owner: User, to: User, role: "moderator" | "editor" | "vip") {
  const res = await owner.client.call("PUT", `/api/channels/${owner.username}/roles/${to.username}`, { role });
  expect(res.status).toBe(200);
}

async function goLive(owner: User) {
  const c = await channelOf(owner);
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({ channelId: c.id, ingestProtocol: "rtmp", path: `live/${uuidv7()}`, startedAt: new Date() })
    .returning();
  if (!b) throw new Error("no broadcast");
  await db().update(schema.channels).set({ liveBroadcastId: b.id }).where(eq(schema.channels.id, c.id));
}

const moderates = async (u: User) => {
  const res = await u.client.call<ModeratedChannel[]>("GET", "/api/me/moderates");
  expect(res.status).toBe(200);
  return res.body;
};

describe("me.moderates", () => {
  test("signed out is refused", async () => {
    const res = await client(api).call("GET", "/api/me/moderates");
    expect(res.status).toBe(401);
  });

  test("empty for a member with no roles; their own channel never counts", async () => {
    const [me] = await people(1);
    if (!me) throw new Error("signup");
    expect(await moderates(me)).toEqual([]);
    // An owner holding a role row on their own channel (seeded directly) is still left out.
    const own = await channelOf(me);
    await db().insert(schema.channelRoles).values({ channelId: own.id, userId: me.userId, role: "moderator" });
    expect(await moderates(me)).toEqual([]);
  });

  test("moderator and editor roles, VIP left out, live first, card fields filled", async () => {
    const [mod, a, b, c] = await people(4);
    if (!mod || !a || !b || !c) throw new Error("signup");
    await grant(a, mod, "moderator");
    await grant(b, mod, "editor");
    await grant(c, mod, "vip");
    await goLive(b);
    const list = await moderates(mod);
    expect(list.map((m) => [m.channel.slug, m.role, m.live])).toEqual([
      [b.username, "editor", true],
      [a.username, "moderator", false],
    ]);
    const ca = await channelOf(a);
    expect(list[1]?.channel).toMatchObject({
      id: ca.id,
      slug: ca.slug,
      displayName: ca.displayName,
      avatarUrl: null,
    });
  });

  test("both roles on one channel make one row that says editor", async () => {
    const [mod, a] = await people(2);
    if (!mod || !a) throw new Error("signup");
    await grant(a, mod, "moderator");
    await grant(a, mod, "editor");
    expect((await moderates(mod)).map((m) => [m.channel.slug, m.role])).toEqual([[a.username, "editor"]]);
  });

  test("a revoked role is gone at once", async () => {
    const [mod, a, b] = await people(3);
    if (!mod || !a || !b) throw new Error("signup");
    await grant(a, mod, "moderator");
    await grant(b, mod, "moderator");
    const res = await a.client.call("DELETE", `/api/channels/${a.username}/roles/${mod.username}`, {
      role: "moderator",
    });
    expect(res.status).toBe(200);
    expect((await moderates(mod)).map((m) => m.channel.slug)).toEqual([b.username]);
  });

  test("a suspended channel is left out", async () => {
    const [mod, a, b] = await people(3);
    if (!mod || !a || !b) throw new Error("signup");
    await grant(a, mod, "moderator");
    await grant(b, mod, "moderator");
    const ca = await channelOf(a);
    await db()
      .update(schema.channels)
      .set({ suspendedAt: new Date(), suspendedReason: "test" })
      .where(eq(schema.channels.id, ca.id));
    expect((await moderates(mod)).map((m) => m.channel.slug)).toEqual([b.username]);
  });

  test("offline channels sort by display name", async () => {
    const [mod, a, b] = await people(3);
    if (!mod || !a || !b) throw new Error("signup");
    await grant(a, mod, "moderator");
    await grant(b, mod, "moderator");
    await db().update(schema.channels).set({ displayName: "zeta" }).where(eq(schema.channels.ownerId, a.userId));
    await db().update(schema.channels).set({ displayName: "Alpha" }).where(eq(schema.channels.ownerId, b.userId));
    expect((await moderates(mod)).map((m) => m.channel.displayName)).toEqual(["Alpha", "zeta"]);
  });
});
