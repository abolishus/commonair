// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * F20: `categories.list` / `categories.get` / `search` report `liveChannels` as exactly the number
 * of channels `directory.live?category=<slug>` lists with its default `includeMature=false`, for
 * every caller. The count follows the live broadcast's category (not the channel's), applies the
 * directory's visibility rule, is mature-exclusive, and has no cache.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { mediaPath } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import { client, signUpAndSignIn, startApi, type Client, type TestApi } from "./harness.ts";

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;

interface Category {
  slug: string;
  liveChannels: number;
}
interface Card {
  channel: { slug: string };
  broadcast: { mature: boolean };
}

async function goLive(
  slug: string,
  categoryId: string,
  opts: { mature?: boolean; restricted?: boolean } = {},
): Promise<string> {
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, slug));
  if (!c) throw new Error(`no channel ${slug}`);
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({
      channelId: c.id,
      ingestProtocol: "rtmp",
      path: mediaPath(slug),
      title: `${slug} live`,
      categoryId,
      mature: opts.mature ?? false,
      startedAt: new Date(),
      restrictedAt: opts.restricted ? new Date() : null,
    })
    .returning();
  if (!b) throw new Error("broadcast insert returned no row");
  await db().update(schema.channels).set({ liveBroadcastId: b.id }).where(eq(schema.channels.id, c.id));
  return b.id;
}

async function goOffline(slug: string, broadcastId: string) {
  await db().update(schema.broadcasts).set({ endedAt: new Date() }).where(eq(schema.broadcasts.id, broadcastId));
  await db().update(schema.channels).set({ liveBroadcastId: null }).where(eq(schema.channels.slug, slug));
}

const live = async (who: Client, slug: string, includeMature: boolean) => {
  const r = await who.call<{ items: Card[]; nextCursor: string | null }>(
    "GET",
    `/api/directory/live?category=${slug}&includeMature=${includeMature}&limit=100`,
  );
  expect(r.status).toBe(200);
  expect(r.body.nextCursor).toBeNull();
  return r.body.items;
};
const listed = async (who: Client) => {
  const r = await who.call<{ items: Category[] }>("GET", "/api/categories?limit=100");
  expect(r.status).toBe(200);
  return new Map(r.body.items.map((c) => [c.slug, c.liveChannels]));
};
const one = async (who: Client, slug: string) => {
  const r = await who.call<Category>("GET", `/api/categories/${slug}`);
  expect(r.status).toBe(200);
  return r.body.liveChannels;
};

describe("category live counts match the live directory (F20)", () => {
  const art = "d1-art";
  const music = "d1-music";
  const night = "d1-after-dark";
  let painter: string;
  let sculptor: string;
  let pianist: string;
  let pianistBroadcast: string;
  let adult: Client;

  beforeAll(async () => {
    const cats = await db()
      .insert(schema.categories)
      .values([
        { slug: art, name: "D1 Art" },
        { slug: music, name: "D1 Music" },
        { slug: night, name: "D1 After Dark", mature: true },
      ])
      .returning();
    const id = (slug: string) => cats.find((c) => c.slug === slug)?.id ?? "";
    const [p, s, m, r, n, a] = await Promise.all([
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
    ]);
    if (!p || !s || !m || !r || !n || !a) throw new Error("signup");
    painter = p.username;
    sculptor = s.username;
    pianist = m.username;
    adult = a.client;
    const confirmed = await adult.call("POST", "/api/me/mature-confirmation");
    if (confirmed.status !== 200) throw new Error(`mature confirmation: ${confirmed.status}`);
    // The pianist's channel still says Art; the live broadcast is in Music, and that is what counts.
    await db()
      .update(schema.channels)
      .set({ categoryId: id(art) })
      .where(eq(schema.channels.slug, pianist));
    await goLive(painter, id(art));
    await goLive(sculptor, id(art), { mature: true });
    pianistBroadcast = await goLive(pianist, id(music));
    // Neither a T1-restricted broadcast nor a stream in a mature category is in the default directory.
    await goLive(r.username, id(art), { restricted: true });
    await goLive(n.username, id(night));
  }, 120_000);

  test("list and get equal directory.live's default listing, for anyone", async () => {
    const anon = client(api);
    for (const who of [anon, adult]) {
      const counts = await listed(who);
      for (const slug of [art, music, night]) {
        const n = (await live(who, slug, false)).length;
        expect(counts.get(slug)).toBe(n);
        expect(await one(who, slug)).toBe(n);
      }
    }
    expect((await listed(anon)).get(art)).toBe(1);
    expect((await listed(anon)).get(music)).toBe(1);
    expect((await listed(anon)).get(night)).toBe(0);
    expect((await live(anon, art, false)).map((c) => c.channel.slug)).toEqual([painter]);
  });

  test("with includeMature the count is the listing's non-mature part (mature-exclusive)", async () => {
    const anon = client(api);
    for (const slug of [art, music, night]) {
      // Not a confirmed adult: includeMature changes nothing, so the count still equals the listing.
      expect(await one(anon, slug)).toBe((await live(anon, slug, true)).length);
      const shown = await live(adult, slug, true);
      expect(await one(adult, slug)).toBe(shown.filter((c) => !c.broadcast.mature).length);
    }
    expect((await live(adult, art, true)).map((c) => c.channel.slug).sort()).toEqual([painter, sculptor].sort());
    expect(await live(adult, night, true)).toHaveLength(1);
  });

  test("busiest first, and search reports the same counts", async () => {
    const r = await client(api).call<{ items: Category[] }>("GET", "/api/categories?q=D1&limit=100");
    expect(r.body.items.map((c) => [c.slug, c.liveChannels])).toEqual([
      [art, 1],
      [music, 1],
      [night, 0],
    ]);
    const s = await client(api).call<{ categories: Category[] }>("GET", "/api/search?q=D1");
    expect(new Map(s.body.categories.map((c) => [c.slug, c.liveChannels]))).toEqual(
      new Map([
        [art, 1],
        [music, 1],
        [night, 0],
      ]),
    );
  });

  test("a channel that goes offline drops out of the count at once (no cache)", async () => {
    const anon = client(api);
    expect(await one(anon, music)).toBe(1);
    await goOffline(pianist, pianistBroadcast);
    expect(await live(anon, music, false)).toHaveLength(0);
    expect(await one(anon, music)).toBe(0);
    expect((await listed(anon)).get(music)).toBe(0);
    // The pianist's channel category (Art) never counted, so Art is unchanged.
    expect(await one(anon, art)).toBe(1);
  });
});
