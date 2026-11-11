// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `channels.*` over the real stack: the page DTO (live summary, restriction, viewer state), info
 * updates and their side effects, panels, uploads, follows, followers paging and channel roles.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { KEYS, mediaPath } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { loadUsersPublic, userByUsername } from "../src/lib/dto.ts";
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
const users = async (n: number): Promise<User[]> => Promise.all(Array.from({ length: n }, () => signUpAndSignIn(api)));
const two = async () => {
  const [a, b] = await users(2);
  if (!a || !b) throw new Error("signup");
  return [a, b] as const;
};

async function channelOf(slug: string) {
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, slug));
  if (!c) throw new Error(`no channel ${slug}`);
  return c;
}

async function category(mature = false) {
  const slug = `cov-${uuidv7().slice(-12)}`;
  const [c] = await db()
    .insert(schema.categories)
    .values({ slug, name: `Cov ${slug}`, mature })
    .returning();
  if (!c) throw new Error("no category");
  return c;
}

/** A live broadcast set as the channel's current one. */
async function goLive(slug: string, opts: { categoryId?: string; restricted?: boolean; ended?: boolean } = {}) {
  const c = await channelOf(slug);
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({
      channelId: c.id,
      ingestProtocol: "rtmp",
      path: mediaPath(slug),
      title: "live now",
      categoryId: opts.categoryId ?? null,
      startedAt: new Date(Date.now() - 60_000),
      endedAt: opts.ended ? new Date() : null,
      restrictedAt: opts.restricted ? new Date() : null,
      restrictedCaseId: opts.restricted ? uuidv7() : null,
    })
    .returning();
  if (!b) throw new Error("no broadcast");
  await db().update(schema.channels).set({ liveBroadcastId: b.id }).where(eq(schema.channels.id, c.id));
  return b;
}

const eventsOf = (channelId: string, type: string) =>
  db()
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.channelId, channelId), eq(schema.events.type, type)));

type Live = { id: string; category: { slug: string } | null; viewerCount: number; restricted?: string | null };
type ChannelDto = {
  slug: string;
  title: string;
  tags: string[];
  language: string;
  mature: boolean;
  category: { id: string; slug: string } | null;
  live: Live | null;
  vodEnabled: boolean;
  viewer: { following: boolean; portabilityGrant: boolean } | null;
  movedTo: { url: string; at: string } | null;
  suspended: boolean;
  subTiers: { tier: number; price: { cents: number; currency: string } }[];
  panels: { title: string }[];
};

describe("channels.get", () => {
  test("unknown channel is 404", async () => {
    expect((await client(api).call("GET", "/api/channels/no_such_channel_x")).status).toBe(404);
  });

  test("anonymous viewer is null; a signed-in viewer sees follow and grant state", async () => {
    const [owner, viewer] = await two();
    const anon = await client(api).call<ChannelDto>("GET", `/api/channels/${owner.username}`);
    expect(anon.status).toBe(200);
    expect(anon.body.viewer).toBeNull();
    expect(anon.body.live).toBeNull();
    expect(anon.body.category).toBeNull();
    expect(anon.body.movedTo).toBeNull();
    expect(anon.body.suspended).toBe(false);

    const before = await viewer.client.call<ChannelDto>("GET", `/api/channels/${owner.username}`);
    expect(before.body.viewer).toEqual({ following: false, portabilityGrant: false });
    await viewer.client.call("PUT", `/api/channels/${owner.username}/follow`, {});
    await viewer.client.call("PUT", `/api/channels/${owner.username}/portability-grant`, { enabled: true });
    const after = await viewer.client.call<ChannelDto>("GET", `/api/channels/${owner.username}`);
    expect(after.body.viewer).toEqual({ following: true, portabilityGrant: true });
  });

  test("live summary with category, viewer count and catching-up, restriction flagged", async () => {
    const [plain, restricted] = await two();
    const cat = await category();
    const b = await goLive(plain.username, { categoryId: cat.id });
    const c = await channelOf(plain.username);
    await api.deps.valkey.set(KEYS.viewerCount(c.id), "12", "EX", 600);
    const r = await client(api).call<ChannelDto>("GET", `/api/channels/${plain.username}`);
    expect(r.body.live).toMatchObject({ id: b.id, viewerCount: 12, restricted: null });
    expect(r.body.live?.category?.slug).toBe(cat.slug);

    await goLive(restricted.username, { restricted: true });
    const rr = await client(api).call<ChannelDto>("GET", `/api/channels/${restricted.username}`);
    expect(rr.body.live?.restricted).toBe("under_review");
  });

  test("a stale live pointer at an ended broadcast reads as offline", async () => {
    const [owner] = await users(1);
    if (!owner) throw new Error("signup");
    await goLive(owner.username, { ended: true });
    expect((await client(api).call<ChannelDto>("GET", `/api/channels/${owner.username}`)).body.live).toBeNull();
  });

  test("moved, suspended, sub tiers in order and the channel's category", async () => {
    const [owner] = await users(1);
    if (!owner) throw new Error("signup");
    const cat = await category();
    const c = await channelOf(owner.username);
    const at = new Date("2026-10-01T00:00:00.000Z");
    await db()
      .update(schema.channels)
      .set({ movedTo: "https://elsewhere.example/c", movedAt: at, suspendedAt: new Date(), categoryId: cat.id })
      .where(eq(schema.channels.id, c.id));
    await db()
      .insert(schema.channelSubTiers)
      .values([3, 1, 2].map((tier) => ({ channelId: c.id, tier, name: `T${tier}`, priceCents: tier * 500 })));
    const r = await client(api).call<ChannelDto>("GET", `/api/channels/${owner.username}`);
    expect(r.body.movedTo).toEqual({ url: "https://elsewhere.example/c", at: at.toISOString() });
    expect(r.body.suspended).toBe(true);
    expect(r.body.category?.id).toBe(cat.id);
    expect(r.body.subTiers.map((t) => t.tier)).toEqual([1, 2, 3]);
    expect(r.body.subTiers[0]?.price).toEqual({ cents: 500, currency: api.deps.env.CURRENCY });
  });
});

describe("channels.update", () => {
  test("normalizes tags and language, trims the title and emits channel.update", async () => {
    const [owner] = await users(1);
    if (!owner) throw new Error("signup");
    const r = await owner.client.call<ChannelDto>("PATCH", `/api/channels/${owner.username}`, {
      title: "  Hello there  ",
      tags: ["Speedrun", "speedrun", "Art"],
      language: "EN",
      vodEnabled: false,
      vodRetentionDays: 14,
      description: "about me",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.title).toBe("Hello there");
    expect(r.body.tags).toEqual(["speedrun", "art"]);
    expect(r.body.language).toBe("en");
    expect(r.body.vodEnabled).toBe(false);
    const c = await channelOf(owner.username);
    expect(c.vodRetentionDays).toBe(14);
    const evs = await eventsOf(c.id, "channel.update");
    expect(evs).toHaveLength(1);
    expect(evs[0]?.payload).toMatchObject({ title: "Hello there", language: "en", category_id: null, mature: false });
  });

  test("an update of unannounced fields only (theme, VOD settings) emits nothing", async () => {
    const [owner] = await users(1);
    if (!owner) throw new Error("signup");
    const r = await owner.client.call("PATCH", `/api/channels/${owner.username}`, {
      theme: { accent: "violet" },
      vodEnabled: true,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await eventsOf((await channelOf(owner.username)).id, "channel.update")).toHaveLength(0);
  });

  test("an empty patch changes nothing and emits nothing (it was a 500: drizzle refuses an empty SET)", async () => {
    const [owner] = await users(1);
    if (!owner) throw new Error("signup");
    const before = await client(api).call<ChannelDto>("GET", `/api/channels/${owner.username}`);
    const r = await owner.client.call<ChannelDto>("PATCH", `/api/channels/${owner.username}`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ ...before.body, viewer: undefined });
    expect(await eventsOf((await channelOf(owner.username)).id, "channel.update")).toHaveLength(0);
  });

  test("an unknown category is refused; a mature category forces the label; null clears it", async () => {
    const [owner] = await users(1);
    if (!owner) throw new Error("signup");
    const path = `/api/channels/${owner.username}`;
    expect((await owner.client.call("PATCH", path, { categoryId: uuidv7() })).status).toBe(400);

    const adult = await category(true);
    const forced = await owner.client.call<ChannelDto>("PATCH", path, { categoryId: adult.id, mature: false });
    expect(forced.status).toBe(200);
    expect(forced.body.mature).toBe(true);
    expect(forced.body.category?.id).toBe(adult.id);
    const evs = await eventsOf((await channelOf(owner.username)).id, "channel.update");
    expect(evs.at(-1)?.payload).toMatchObject({ category_id: adult.id, category_name: adult.name, mature: true });

    const cleared = await owner.client.call<ChannelDto>("PATCH", path, { categoryId: null, mature: false });
    expect(cleared.body.category).toBeNull();
    expect(cleared.body.mature).toBe(false);
  });

  test("while live, title, category and label follow onto the live broadcast", async () => {
    const [owner] = await users(1);
    if (!owner) throw new Error("signup");
    const b = await goLive(owner.username);
    const cat = await category();
    await owner.client.call("PATCH", `/api/channels/${owner.username}`, {
      title: "new live title",
      categoryId: cat.id,
      mature: true,
    });
    const [row] = await db().select().from(schema.broadcasts).where(eq(schema.broadcasts.id, b.id));
    expect(row).toMatchObject({ title: "new live title", categoryId: cat.id, mature: true });
    // Tags alone do not touch the broadcast row.
    await db().update(schema.broadcasts).set({ title: "kept" }).where(eq(schema.broadcasts.id, b.id));
    await owner.client.call("PATCH", `/api/channels/${owner.username}`, { tags: ["x"] });
    const [again] = await db().select().from(schema.broadcasts).where(eq(schema.broadcasts.id, b.id));
    expect(again?.title).toBe("kept");
  });

  test("a stream key pasted into the title or description is redacted", async () => {
    const [owner] = await users(1);
    if (!owner) throw new Error("signup");
    const key = `live_${"A".repeat(43)}`;
    const r = await owner.client.call<ChannelDto & { description: string }>(
      "PATCH",
      `/api/channels/${owner.username}`,
      { title: `key ${key}`, description: `my key is ${key}` },
    );
    expect(r.status).toBe(200);
    expect(r.body.title).not.toContain(key);
    expect(r.body.description).not.toContain(key);
  });

  test("theme images must be the channel's own uploads", async () => {
    const [owner, other] = await two();
    const path = `/api/channels/${owner.username}`;
    const otherId = (await channelOf(other.username)).id;
    const avatar = await owner.client.call("PATCH", path, {
      theme: { avatarKey: `channels/${otherId}/avatar/x.png` },
    });
    expect(avatar.status).toBe(400);
    const banner = await owner.client.call("PATCH", path, { theme: { bannerKey: "https://elsewhere.example/b.png" } });
    expect(banner.status).toBe(400);
  });

  test("only the owner or an editor may update", async () => {
    const [owner, stranger] = await two();
    const r = await stranger.client.call("PATCH", `/api/channels/${owner.username}`, { title: "hijack" });
    expect(r.status).toBe(403);
    expect((await client(api).call("PATCH", `/api/channels/${owner.username}`, { title: "x" })).status).toBe(401);
  });
});

describe("channels.setPanels", () => {
  test("replaces panels in order; an empty list clears them", async () => {
    const [owner] = await users(1);
    if (!owner) throw new Error("signup");
    const path = `/api/channels/${owner.username}/panels`;
    const panels = [
      { title: "One", body: "first", imageKey: null, linkUrl: "https://one.example/" },
      { title: "Two", body: "second", imageKey: null, linkUrl: null },
    ];
    const r = await owner.client.call<{ title: string; position: number; linkUrl: string | null }[]>("PUT", path, {
      panels,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.map((p) => [p.position, p.title, p.linkUrl])).toEqual([
      [0, "One", "https://one.example/"],
      [1, "Two", null],
    ]);
    const page = await client(api).call<ChannelDto>("GET", `/api/channels/${owner.username}`);
    expect(page.body.panels.map((p) => p.title)).toEqual(["One", "Two"]);
    const cleared = await owner.client.call<unknown[]>("PUT", path, { panels: [] });
    expect(cleared.body).toEqual([]);
  });

  test("foreign images, uncommitted images and non-http links are refused", async () => {
    const [owner] = await users(1);
    if (!owner) throw new Error("signup");
    const path = `/api/channels/${owner.username}/panels`;
    const one = (p: Record<string, unknown>) => ({
      panels: [{ title: "t", body: "b", imageKey: null, linkUrl: null, ...p }],
    });
    expect((await owner.client.call("PUT", path, one({ imageKey: "channels/someone-else/panel/x.png" }))).status).toBe(
      400,
    );
    expect((await owner.client.call("PUT", path, one({ linkUrl: "ftp://files.example/x" }))).status).toBe(400);
    // Its own prefix, but a path that escapes it is refused.
    const id = (await channelOf(owner.username)).id;
    expect((await owner.client.call("PUT", path, one({ imageKey: `channels/${id}/../x.png` }))).status).toBe(400);
  });
});

describe("channels.uploadUrl and commitUpload", () => {
  test("a type not allowed for the purpose is refused; an allowed one is presigned", async () => {
    const [owner] = await users(1);
    if (!owner) throw new Error("signup");
    const path = `/api/channels/${owner.username}/uploads`;
    const bad = await owner.client.call("POST", path, { purpose: "avatar", contentType: "audio/mpeg", sizeBytes: 10 });
    expect(bad.status).toBe(400);
    const ok = await owner.client.call<{
      key: string;
      uploadUrl: string;
      headers: Record<string, string>;
      expiresAt: string;
    }>("POST", path, { purpose: "avatar", contentType: "image/png", sizeBytes: 1234 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const id = (await channelOf(owner.username)).id;
    expect(ok.body.key).toContain(id);
    expect(ok.body.headers).toEqual({ "content-type": "image/png", "content-length": "1234" });
    const ttl = new Date(ok.body.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(500_000);
    expect(ttl).toBeLessThanOrEqual(600_000);
  });

  test("committing a key that is not this channel's upload is refused", async () => {
    const [owner] = await users(1);
    if (!owner) throw new Error("signup");
    const r = await owner.client.call("POST", `/api/channels/${owner.username}/uploads/commit`, {
      key: "incoming/someone-else/avatar/x.png",
    });
    expect(r.status).toBe(400);
  });
});

describe("channels.follow and unfollow", () => {
  test("unknown channel 404, own channel 400, anonymous 401", async () => {
    const [owner] = await users(1);
    if (!owner) throw new Error("signup");
    expect((await owner.client.call("PUT", "/api/channels/no_such_channel_x/follow", {})).status).toBe(404);
    expect((await owner.client.call("DELETE", "/api/channels/no_such_channel_x/follow")).status).toBe(404);
    expect((await owner.client.call("PUT", `/api/channels/${owner.username}/follow`, {})).status).toBe(400);
    expect((await client(api).call("PUT", `/api/channels/${owner.username}/follow`, {})).status).toBe(401);
  });

  test("a follow counts once and emits once; following again only changes notify; unfollow lowers", async () => {
    const [owner, fan] = await two();
    const path = `/api/channels/${owner.username}/follow`;
    const first = await fan.client.call<{ following: true; followerCount: number }>("PUT", path, { notify: true });
    expect(first.body).toMatchObject({ following: true, followerCount: 1 });
    const again = await fan.client.call<{ following: true; followerCount: number }>("PUT", path, { notify: false });
    expect(again.body).toEqual({ following: true, followerCount: 1, firstFollow: false });
    const c = await channelOf(owner.username);
    const [row] = await db()
      .select()
      .from(schema.follows)
      .where(and(eq(schema.follows.channelId, c.id), eq(schema.follows.followerId, fan.userId)));
    expect(row?.notify).toBe(false);
    const evs = await eventsOf(c.id, "channel.follow");
    expect(evs).toHaveLength(1);
    expect(evs[0]?.payload).toMatchObject({ user_login: fan.username });

    const off = await fan.client.call<{ following: false; followerCount: number }>("DELETE", path);
    expect(off.body).toEqual({ following: false, followerCount: 0 });
    // Unfollowing again is a no-op, not an error.
    expect((await fan.client.call<{ followerCount: number }>("DELETE", path)).body.followerCount).toBe(0);
  });
});

describe("channels.followers", () => {
  test("newest first, keyset pages without overlap, excluded follows flagged", async () => {
    const [owner, a, b, c] = await users(4);
    if (!owner || !a || !b || !c) throw new Error("signup");
    const ch = await channelOf(owner.username);
    // Explicit, distinct follow times: a, then b, then c.
    for (const [i, f] of [a, b, c].entries()) {
      await f.client.call("PUT", `/api/channels/${owner.username}/follow`, {});
      await db()
        .update(schema.follows)
        .set({ createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)) })
        .where(and(eq(schema.follows.channelId, ch.id), eq(schema.follows.followerId, f.userId)));
    }
    await db()
      .update(schema.follows)
      .set({ excludedAt: new Date() })
      .where(and(eq(schema.follows.channelId, ch.id), eq(schema.follows.followerId, b.userId)));
    type Page = { items: { user: { username: string }; excluded: boolean }[]; nextCursor: string | null };
    const path = `/api/channels/${owner.username}/followers`;
    const seen: string[] = [];
    const excluded: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const r: { status: number; body: Page } = await owner.client.call<Page>(
        "GET",
        `${path}?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(r.status).toBe(200);
      for (const it of r.body.items) {
        seen.push(it.user.username);
        if (it.excluded) excluded.push(it.user.username);
      }
      cursor = r.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([c.username, b.username, a.username]);
    expect(excluded).toEqual([b.username]);
    expect((await a.client.call("GET", path)).status).toBe(403);
  });

  test("a garbage cursor is refused; a channel without followers has an empty last page", async () => {
    const [owner] = await users(1);
    if (!owner) throw new Error("signup");
    const path = `/api/channels/${owner.username}/followers`;
    expect((await owner.client.call("GET", `${path}?cursor=not-a-cursor`)).status).toBe(400);
    const r = await owner.client.call<{ items: unknown[]; nextCursor: string | null }>("GET", path);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ items: [], nextCursor: null });
  });
});

describe("channels.roles", () => {
  test("owner grants and revokes; list shows the holders; editors and the owner themself are refused", async () => {
    const [owner, mod, editor, stranger] = await users(4);
    if (!owner || !mod || !editor || !stranger) throw new Error("signup");
    const base = `/api/channels/${owner.username}/roles`;
    const grant = (as: User, username: string, role: string) => as.client.call("PUT", `${base}/${username}`, { role });

    expect((await grant(owner, mod.username, "moderator")).status).toBe(200);
    expect((await grant(owner, editor.username, "editor")).status).toBe(200);
    // Granting again is harmless.
    expect((await grant(owner, mod.username, "moderator")).status).toBe(200);
    expect((await grant(owner, "no_such_user_x", "vip")).status).toBe(404);
    expect((await grant(owner, owner.username, "vip")).status).toBe(400);
    // An editor manages the channel, but not who holds authority over it.
    expect((await grant(editor, stranger.username, "moderator")).status).toBe(403);

    const list = await mod.client.call<{ user: { username: string }; role: string }[]>("GET", base);
    expect(list.status).toBe(200);
    expect(list.body.map((r) => `${r.user.username}:${r.role}`).sort()).toEqual(
      [`${mod.username}:moderator`, `${editor.username}:editor`].sort(),
    );
    expect((await stranger.client.call("GET", base)).status).toBe(403);

    const revoke = await owner.client.call("DELETE", `${base}/${mod.username}`, { role: "moderator" });
    expect(revoke.status).toBe(200);
    const after = await owner.client.call<{ user: { username: string } }[]>("GET", base);
    expect(after.body.map((r) => r.user.username)).toEqual([editor.username]);
  });
});

describe("channels.mediaSettings", () => {
  test("the owner reads and updates the settings; others may not", async () => {
    const [owner, other] = await two();
    const path = `/api/channels/${owner.username}/media-settings`;
    const r = await owner.client.call<Record<string, unknown>>("GET", path);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const up = await owner.client.call("PATCH", path, {});
    expect(up.status).toBe(200);
    expect((await other.client.call("GET", path)).status).toBe(403);
  });
});

describe("dto loaders", () => {
  test("loadUsersPublic: empty ids, duplicates, bot owners resolved", async () => {
    const [owner, bot] = await two();
    expect((await loadUsersPublic(api.deps, [])).size).toBe(0);
    await db()
      .update(schema.users)
      .set({ accountType: "bot", botOwnerId: owner.userId })
      .where(eq(schema.users.id, bot.userId));
    const got = await loadUsersPublic(api.deps, [bot.userId, bot.userId, owner.userId, uuidv7()]);
    expect(got.size).toBe(2);
    expect(got.get(bot.userId)?.botOwner).toEqual({ id: owner.userId, username: owner.username });
    expect(got.get(owner.userId)?.botOwner).toBeNull();
  });

  test("userByUsername is case-insensitive and hides deleted accounts", async () => {
    const [u] = await users(1);
    if (!u) throw new Error("signup");
    expect((await userByUsername(api.deps, u.username.toUpperCase()))?.id).toBe(u.userId);
    await db().update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, u.userId));
    expect(await userByUsername(api.deps, u.username)).toBeNull();
    expect(await userByUsername(api.deps, "no_such_user_x")).toBeNull();
  });
});
