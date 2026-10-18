// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Review-round regressions: mature categories, media references, admin audit, tokens, 2FA. */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER, mediaPath } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
let alice: Awaited<ReturnType<typeof signUpAndSignIn>>;
let bob: Awaited<ReturnType<typeof signUpAndSignIn>>;

beforeAll(async () => {
  api = await startApi();
  alice = await signUpAndSignIn(api);
  bob = await signUpAndSignIn(api);
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;
const channelOf = async (slug: string) => {
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, slug));
  if (!c) throw new Error(`no channel ${slug}`);
  return c;
};
const hook = (route: string, body: Record<string, unknown>) =>
  fetch(`${api.url}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: api.internalSecret },
    body: JSON.stringify(body),
  });

describe("playback mature gate", () => {
  test("a mature category gates playback even when the channel and broadcast are unlabelled", async () => {
    const [cat] = await db()
      .insert(schema.categories)
      .values({ slug: `cat-${uuidv7()}`, name: "Late-flagged", mature: false })
      .returning();
    if (!cat) throw new Error("no category");
    const c = await channelOf(alice.username);
    await db().update(schema.channels).set({ categoryId: cat.id, mature: false }).where(eq(schema.channels.id, c.id));
    const ready = await hook(INTERNAL_ROUTES.mediaReady, {
      path: mediaPath(alice.username),
      sourceType: "rtmpConn",
      sourceId: crypto.randomUUID(),
    });
    expect(ready.status).toBe(204);
    // Staff flag the category after the stream started: rows written earlier still say "not mature".
    await db().update(schema.categories).set({ mature: true }).where(eq(schema.categories.id, cat.id));
    const live = await channelOf(alice.username);
    const [b] = await db()
      .select()
      .from(schema.broadcasts)
      .where(eq(schema.broadcasts.id, live.liveBroadcastId ?? ""));
    expect(b?.mature).toBe(false);
    expect(live.mature).toBe(false);

    const start = (c2 = client(api)) =>
      c2.call<{ requirement?: string; data?: { requirement: string } }>(
        "POST",
        `/api/channels/${alice.username}/playback`,
        { deviceId: "device-0123456789abcdef" },
      );
    const anon = await start();
    expect(anon.status).toBe(412);
    expect(anon.body.data?.requirement).toBe("mature_confirmation");
    expect((await start(bob.client)).status).toBe(412);
    expect((await bob.client.call("POST", "/api/me/mature-confirmation")).status).toBe(200);
    expect((await start(bob.client)).status).toBe(200);

    await db().update(schema.categories).set({ mature: false }).where(eq(schema.categories.id, cat.id));
    expect((await start()).status).toBe(200);
  });
});

describe("media references stay on this instance", () => {
  test("channel theme avatar/banner must be own uploads or instance URLs", async () => {
    const c = await channelOf(alice.username);
    const patch = (theme: Record<string, string>) =>
      alice.client.call("PATCH", `/api/channels/${alice.username}`, { theme });
    expect((await patch({ avatarKey: "https://tracker.invalid/pixel.gif" })).status).toBe(400);
    expect((await patch({ bannerKey: "https://tracker.invalid/banner.png" })).status).toBe(400);
    const bobs = await channelOf(bob.username);
    expect((await patch({ avatarKey: `channels/${bobs.id}/avatar/x.png` })).status).toBe(400);
    expect((await patch({ avatarKey: `channels/${c.id}/banner/x.png` })).status).toBe(400);
    expect((await patch({ avatarKey: `channels/${c.id}/avatar/../../${bobs.id}/avatar/x.png` })).status).toBe(400);
    const ok = await patch({
      avatarKey: `channels/${c.id}/avatar/01.png`,
      bannerKey: `channels/${c.id}/banner/01.webp`,
      accent: "teal",
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await patch({ avatarKey: `${api.url}/static/default.png` })).status).toBe(200);
  });

  test("profile image through update-user must be an own upload or instance URL", async () => {
    const c = await channelOf(bob.username);
    const set = (image: string | null) => bob.client.call("POST", "/api/auth/update-user", { image });
    expect((await set("https://tracker.invalid/me.png")).status).toBe(400);
    const alices = await channelOf(alice.username);
    expect((await set(`channels/${alices.id}/avatar/a.png`)).status).toBe(400);
    expect((await set(`channels/${c.id}/avatar/a.png`)).status).toBe(200);
    expect((await set(`${api.url}/static/default.png`)).status).toBe(200);
    expect((await set(null)).status).toBe(200);
    const [u] = await db().select().from(schema.users).where(eq(schema.users.id, bob.userId));
    expect(u?.image).toBeNull();
  });
});

describe("better-auth admin plugin endpoints", () => {
  test("are closed even to admins; the audited admin procedure is the only path", async () => {
    await db().update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, alice.userId));
    const calls: [string, Record<string, unknown>][] = [
      ["/api/auth/admin/set-role", { userId: bob.userId, role: "admin" }],
      ["/api/auth/admin/ban-user", { userId: bob.userId, banReason: "x" }],
      ["/api/auth/admin/impersonate-user", { userId: bob.userId }],
      ["/api/auth/admin/remove-user", { userId: bob.userId }],
      ["/api/auth/admin/set-user-password", { userId: bob.userId, newPassword: "x".repeat(20) }],
      ["/api/auth/admin/revoke-user-sessions", { userId: bob.userId }],
      ["/api/auth/admin/create-user", { email: "x@test.invalid", password: "x".repeat(20), name: "x" }],
    ];
    for (const [path, body] of calls) {
      const res = await alice.client.call("POST", path, body);
      expect(res.status, path).toBe(404);
    }
    expect((await alice.client.call("GET", "/api/auth/admin/list-users")).status).toBe(404);
    const [b] = await db().select().from(schema.users).where(eq(schema.users.id, bob.userId));
    expect(b).toMatchObject({ role: "user", banned: false });
    // Bob's session still works (no impersonation, no session revocation).
    expect((await bob.client.call("GET", "/api/me")).status).toBe(200);

    const set = await alice.client.call("PUT", `/api/admin/users/${bob.username}/role`, { role: "moderator" });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const logs = await db().select().from(schema.auditLog).where(eq(schema.auditLog.subjectId, bob.userId));
    expect(logs.map((l) => l.action)).toContain("user.set_role");
    await db().update(schema.users).set({ role: "user" }).where(eq(schema.users.id, bob.userId));
  });
});
