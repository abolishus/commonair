// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Chat replay (`vods.chat`, `clips.chat`; ADR 0012 amendment 1 decisions 5 to 7): media-time
 * order with a keyset cursor, the clip window, every exclusion, playability per audience, and
 * `retained`. Chat rows, moderation records and blocks are seeded directly.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { encodeReplayCursor } from "../src/chat-replay/cursor.ts";
import { client, signUpAndSignIn, startApi, uniqueName, type Client, type TestApi } from "./harness.ts";

let api: TestApi;
type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
let owner: User;
let stranger: User;
let sub: User;
let channelId: string;

const db = () => api.db.db;
const MIN = 60_000;
const DAY = 86_400_000;

beforeAll(async () => {
  api = await startApi();
  [owner, stranger, sub] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api), signUpAndSignIn(api)]);
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, owner.username));
  channelId = c!.id;
  await db().insert(schema.subscriptions).values({
    subscriberId: sub.userId,
    channelId,
    tier: 1,
    status: "active",
    provider: "manual",
    priceCents: 500,
    currency: "usd",
  });
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

interface Item {
  id: string;
  body: string;
  user: { id: string };
  at: string;
  createdAt: string;
  mediaTs: string | null;
  catchingUp: boolean;
  replyTo: { id: string; body: string } | null;
}
interface Page {
  items: Item[];
  nextCursor: string | null;
  retained: boolean;
}

/** An author without a session (chat rows only need the user row). */
async function author(over: Partial<typeof schema.users.$inferInsert> = {}) {
  const username = uniqueName("a");
  const id = uuidv7();
  await db()
    .insert(schema.users)
    .values({ id, name: username, email: `${username}@test.invalid`, username, ...over });
  return id;
}

async function broadcast(
  startedAt: Date,
  endedAt: Date | null,
  over: Partial<typeof schema.broadcasts.$inferInsert> = {},
) {
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({ channelId, ingestProtocol: "rtmp", path: `live/${uuidv7()}`, startedAt, endedAt, ...over })
    .returning();
  return b!;
}

async function vod(broadcastId: string, over: Partial<typeof schema.vods.$inferInsert> = {}) {
  const id = uuidv7();
  await db()
    .insert(schema.vods)
    .values({
      id,
      channelId,
      broadcastId,
      title: "v",
      storagePrefix: `vods/${id}/`,
      status: "ready",
      durationSeconds: 3600,
      ...over,
    });
  return id;
}

async function say(
  broadcastId: string | null,
  userId: string,
  createdAt: Date,
  mediaTs: Date | null,
  over: Partial<typeof schema.chatMessages.$inferInsert> = {},
) {
  const id = over.id ?? uuidv7();
  await db()
    .insert(schema.chatMessages)
    .values({ id, channelId, broadcastId, userId, body: over.body ?? `m-${id}`, createdAt, mediaTs, ...over });
  return id;
}

const call = (who: Client | null, path: string) => (who ?? client(api)).call<Page>("GET", path);

/** Every page of a replay, following the cursor. */
async function all(who: Client | null, kind: "vods" | "clips", id: string, limit = 500): Promise<Item[]> {
  const out: Item[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const q: string = `/api/${kind}/${id}/chat?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await call(who, q);
    expect(r.status).toBe(200);
    out.push(...r.body.items);
    cursor = r.body.nextCursor;
    if (!cursor) return out;
  }
  throw new Error("too many pages");
}

describe("order and paging", () => {
  test("media-time order; a catching-up line sits at its receive time, flagged", async () => {
    const start = new Date(Date.now() - 60 * MIN);
    const b = await broadcast(start, new Date(Date.now() - 5 * MIN));
    const id = await vod(b.id);
    const a = await author();
    const t = (min: number) => new Date(start.getTime() + min * MIN);
    // Received late (behind the live edge), placed earlier by its media time.
    const late = await say(b.id, a, t(10), t(9.5));
    const dvr = await say(b.id, a, t(9.75), null);
    const early = await say(b.id, a, t(9.4), t(9));
    const r = await call(null, `/api/vods/${id}/chat`);
    expect(r.status).toBe(200);
    expect(r.res.headers.get("cache-control")).toBe("no-store");
    expect(r.body.retained).toBe(true);
    expect(r.body.nextCursor).toBeNull();
    expect(r.body.items.map((i) => i.id)).toEqual([early, late, dvr]);
    const byId = new Map(r.body.items.map((i) => [i.id, i]));
    expect(byId.get(late)).toMatchObject({
      at: t(9.5).toISOString(),
      mediaTs: t(9.5).toISOString(),
      catchingUp: false,
    });
    expect(byId.get(dvr)).toMatchObject({ at: t(9.75).toISOString(), mediaTs: null, catchingUp: true });
    expect(byId.get(dvr)?.createdAt).toBe(t(9.75).toISOString());
  });

  test("the cursor pages across equal timestamps without gaps or repeats", async () => {
    const start = new Date(Date.now() - 30 * MIN);
    const b = await broadcast(start, new Date(Date.now() - MIN));
    const id = await vod(b.id);
    const a = await author();
    const same = new Date(start.getTime() + 5 * MIN);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await say(b.id, a, new Date(same.getTime() + i), same));
    // One more at the same instant via receive time only (no media time), and sub-millisecond
    // apart in the database, which the millisecond Date cannot express.
    const micro = (us: string) => sql`${same.toISOString().replace("Z", us)}::timestamptz`;
    await db().execute(sql`
      insert into chat_messages (id, channel_id, broadcast_id, user_id, body, created_at, media_ts)
      values (${uuidv7()}, ${channelId}, ${b.id}, ${a}, 'micro-1', ${micro("100Z")}, null),
             (${uuidv7()}, ${channelId}, ${b.id}, ${a}, 'micro-2', ${micro("200Z")}, null)`);
    const pages: Page[] = [];
    let cursor: string | null = null;
    do {
      const q: string = `/api/vods/${id}/chat?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const r = await call(null, q);
      expect(r.status).toBe(200);
      pages.push(r.body);
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(pages.map((p) => p.items.length)).toEqual([2, 2, 2, 1]);
    const seen = pages.flatMap((p) => p.items.map((i) => i.id));
    expect(new Set(seen).size).toBe(7);
    // Equal media times order by id; the two sub-millisecond rows come after the five (µs later).
    expect(seen.slice(0, 5)).toEqual([...ids].sort());
    expect(pages.flatMap((p) => p.items.map((i) => i.body)).slice(5)).toEqual(["micro-1", "micro-2"]);
    expect(await all(null, "vods", id, 3)).toHaveLength(7);
  });

  test("a malformed cursor is a client error", async () => {
    const b = await broadcast(new Date(Date.now() - 10 * MIN), new Date());
    const id = await vod(b.id);
    for (const bad of ["nope", encodeReplayCursor({ t: new Date().toISOString(), id: uuidv7() })]) {
      const r = await call(null, `/api/vods/${id}/chat?cursor=${encodeURIComponent(bad)}`);
      expect(r.status).toBe(400);
    }
    expect((await call(null, `/api/vods/${id}/chat?limit=501`)).status).toBe(400);
  });
});

describe("what replay hides", () => {
  test("deleted, held, cleared, banned, timed out, permanently banned, suspended and blocked", async () => {
    // Days back, so its channel-wide clear cannot fall into another test's broadcast window.
    const start = new Date(Date.now() - 5 * DAY);
    const end = new Date(start.getTime() + 110 * MIN);
    const b = await broadcast(start, end);
    const id = await vod(b.id);
    const t = (min: number) => new Date(start.getTime() + min * MIN);

    const plain = await author();
    const banned = await author();
    const timedOut = await author();
    const permanent = await author();
    const suspended = await author({ banned: true, banExpires: new Date(Date.now() + DAY) });
    const suspensionOver = await author({ banned: true, banExpires: new Date(Date.now() - DAY) });
    const suspendedForever = await author({ banned: true });
    const blocked = await author();
    const laterTimeout = await author();

    const shown: string[] = [];
    const hidden: string[] = [];
    shown.push(await say(b.id, plain, t(1), t(1)));
    hidden.push(await say(b.id, plain, t(2), t(2), { deletedAt: t(3), deletedBy: owner.userId }));
    hidden.push(await say(b.id, plain, t(4), t(4), { heldAt: t(4) }));
    // An approved hold (held_at cleared) is shown.
    shown.push(await say(b.id, plain, t(5), t(5), { heldAt: null }));

    // `/clear` at minute 0.5 hides everything received before it in this broadcast, whatever its
    // media time.
    hidden.push(await say(b.id, plain, t(0.2), t(0.2)));
    hidden.push(await say(b.id, plain, t(0.4), t(0.1)));
    await db()
      .insert(schema.modActions)
      .values({
        scope: "channel",
        channelId,
        moderatorId: owner.userId,
        action: "clear_chat",
        createdAt: t(0.5),
      });
    shown.push(await say(b.id, plain, t(21), t(21)));
    // A clear after the broadcast ended (before the next one) does not reach back into it.
    await db()
      .insert(schema.modActions)
      .values({ scope: "channel", channelId, action: "clear_chat", createdAt: new Date(end.getTime() + MIN) });

    // Banned at minute 40 (later lifted): earlier lines hidden, later ones shown.
    hidden.push(await say(b.id, banned, t(30), t(30)));
    await db()
      .insert(schema.chatBans)
      .values({
        channelId,
        userId: banned,
        moderatorId: owner.userId,
        createdAt: t(40),
        liftedAt: t(45),
        liftedBy: owner.userId,
      });
    shown.push(await say(b.id, banned, t(50), t(50)));

    // Timed out at minute 60 for 5 minutes.
    hidden.push(await say(b.id, timedOut, t(55), t(55)));
    await db()
      .insert(schema.chatBans)
      .values({ channelId, userId: timedOut, moderatorId: owner.userId, createdAt: t(60), expiresAt: t(65) });
    shown.push(await say(b.id, timedOut, t(70), t(70)));

    // A timeout after the broadcast ended hides nothing of it.
    shown.push(await say(b.id, laterTimeout, t(6), t(6)));
    await db()
      .insert(schema.chatBans)
      .values({
        channelId,
        userId: laterTimeout,
        createdAt: new Date(end.getTime() + 2 * MIN),
        expiresAt: new Date(end.getTime() + 3 * MIN),
      });

    // A permanent channel ban (placed after the broadcast) hides the author on every replay.
    hidden.push(await say(b.id, permanent, t(71), t(71)));
    await db().insert(schema.chatBans).values({ channelId, userId: permanent, createdAt: new Date() });

    hidden.push(await say(b.id, suspended, t(72), t(72)));
    hidden.push(await say(b.id, suspendedForever, t(73), t(73)));
    shown.push(await say(b.id, suspensionOver, t(74), t(74)));

    // Blocked by the stranger only. A reply quoting the blocked line shows a blank quote to them.
    const blockedLine = await say(b.id, blocked, t(80), t(80), { body: "blocked words" });
    const reply = await say(b.id, plain, t(81), t(81), { replyToId: blockedLine });
    shown.push(reply);
    await db().insert(schema.userBlocks).values({ userId: stranger.userId, blockedUserId: blocked });

    const anon = (await all(null, "vods", id)).map((i) => i.id);
    expect(new Set(anon)).toEqual(new Set([...shown, blockedLine]));
    for (const h of hidden) expect(anon).not.toContain(h);

    const forStranger = await all(stranger.client, "vods", id);
    expect(new Set(forStranger.map((i) => i.id))).toEqual(new Set(shown));
    expect(forStranger.find((i) => i.id === reply)?.replyTo).toEqual({
      id: blockedLine,
      username: expect.any(String),
      body: "",
    });
    // Others still see the quote.
    expect((await all(null, "vods", id)).find((i) => i.id === reply)?.replyTo?.body).toBe("blocked words");

    // The permanent ban reaches another replay of the channel too.
    const b2 = await broadcast(new Date(Date.now() - 300 * MIN), new Date(Date.now() - 250 * MIN));
    const id2 = await vod(b2.id);
    const older = await say(b2.id, permanent, new Date(b2.startedAt.getTime() + MIN), null);
    const otherOld = await say(b2.id, plain, new Date(b2.startedAt.getTime() + 2 * MIN), null);
    expect((await all(null, "vods", id2)).map((i) => i.id)).toEqual([otherOld]);
    expect(older).toBeTruthy();
  });

  test("a message from another broadcast or outside the window is not replayed", async () => {
    const start = new Date(Date.now() - 30 * MIN);
    const b = await broadcast(start, new Date(Date.now() - 20 * MIN));
    const other = await broadcast(new Date(Date.now() - 15 * MIN), null);
    const id = await vod(b.id);
    const a = await author();
    const inside = await say(b.id, a, new Date(start.getTime() + MIN), null);
    await say(other.id, a, new Date(Date.now() - 14 * MIN), null);
    await say(null, a, new Date(start.getTime() + 2 * MIN), null);
    expect((await all(null, "vods", id)).map((i) => i.id)).toEqual([inside]);
  });
});

describe("served exactly when the media is playable", () => {
  test("private, subscribers, removed, deleted, failed and mature VODs", async () => {
    const mk = async (
      over: Partial<typeof schema.vods.$inferInsert>,
      bOver: Partial<typeof schema.broadcasts.$inferInsert> = {},
    ) => {
      const b = await broadcast(new Date(Date.now() - 20 * MIN), new Date(Date.now() - MIN), bOver);
      await say(b.id, owner.userId, new Date(Date.now() - 10 * MIN), null);
      return vod(b.id, over);
    };
    const status = async (who: Client | null, id: string) => (await call(who, `/api/vods/${id}/chat`)).status;

    const priv = await mk({ visibility: "private" });
    expect(await status(null, priv)).toBe(404);
    expect(await status(stranger.client, priv)).toBe(404);
    expect(await status(sub.client, priv)).toBe(404);
    expect(await status(owner.client, priv)).toBe(200);

    const subs = await mk({ visibility: "subscribers" });
    expect(await status(stranger.client, subs)).toBe(404);
    expect(await status(sub.client, subs)).toBe(200);
    expect(await status(owner.client, subs)).toBe(200);

    const removed = await mk({ removedReason: "owner", expiresAt: new Date() });
    expect(await status(owner.client, removed)).toBe(404);
    const dmca = await mk({ removedReason: "dmca" });
    expect(await status(owner.client, dmca)).toBe(404);
    const deleted = await mk({ status: "deleted", removedReason: "retention" });
    expect(await status(owner.client, deleted)).toBe(404);
    const processing = await mk({ status: "processing" });
    expect(await status(stranger.client, processing)).toBe(404);
    expect(await status(owner.client, processing)).toBe(200);
    const restricted = await mk({}, { restrictedAt: new Date(), restrictedCaseId: uuidv7() });
    expect(await status(owner.client, restricted)).toBe(404);
    expect(await status(null, uuidv7())).toBe(404);

    const mature = await mk({}, { mature: true });
    const gate = await call(null, `/api/vods/${mature}/chat`);
    expect(gate.status).toBe(403);
    expect(JSON.stringify(gate.body)).toContain("mature_gate");
    expect(await status(owner.client, mature)).toBe(200);
  });

  test("a suspended channel's replay is the owner's only", async () => {
    const owner2 = await signUpAndSignIn(api);
    const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, owner2.username));
    const [b] = await db()
      .insert(schema.broadcasts)
      .values({ channelId: c!.id, ingestProtocol: "rtmp", path: `live/${uuidv7()}`, endedAt: new Date() })
      .returning();
    const id = uuidv7();
    await db()
      .insert(schema.vods)
      .values({ id, channelId: c!.id, broadcastId: b!.id, title: "v", storagePrefix: `vods/${id}/`, status: "ready" });
    await db().update(schema.channels).set({ suspendedAt: new Date() }).where(eq(schema.channels.id, c!.id));
    expect((await call(null, `/api/vods/${id}/chat`)).status).toBe(404);
    expect((await call(owner2.client, `/api/vods/${id}/chat`)).status).toBe(200);
  });
});

describe("clips", () => {
  test("the clip window, and the clip's own playability", async () => {
    const start = new Date(Date.now() - 60 * MIN);
    const b = await broadcast(start, new Date(Date.now() - 5 * MIN));
    const vodId = await vod(b.id);
    const a = await author();
    const s = (sec: number) => new Date(start.getTime() + sec * 1000);
    // Clip: 120 s to 150 s from the broadcast start.
    const clipId = uuidv7();
    await db().insert(schema.clips).values({
      id: clipId,
      channelId,
      broadcastId: b.id,
      vodId,
      creatorId: stranger.userId,
      title: "c",
      startOffset: 120,
      durationSeconds: 30,
      status: "ready",
    });
    await say(b.id, a, s(119), s(119));
    const first = await say(b.id, a, s(130), s(120));
    const mid = await say(b.id, a, s(135), null);
    const last = await say(b.id, a, s(152), s(150));
    await say(b.id, a, s(151), s(150.5));
    // Received inside the window but placed before it by its media time.
    await say(b.id, a, s(125), s(100));
    expect((await all(null, "clips", clipId)).map((i) => i.id)).toEqual([first, mid, last]);
    expect((await all(null, "clips", clipId, 1)).map((i) => i.id)).toEqual([first, mid, last]);

    // A clip of a VOD made private follows it.
    await db().update(schema.vods).set({ visibility: "private" }).where(eq(schema.vods.id, vodId));
    expect((await call(null, `/api/clips/${clipId}/chat`)).status).toBe(404);
    expect((await call(owner.client, `/api/clips/${clipId}/chat`)).status).toBe(200);
    await db().update(schema.clips).set({ removedReason: "creator" }).where(eq(schema.clips.id, clipId));
    expect((await call(owner.client, `/api/clips/${clipId}/chat`)).status).toBe(404);
    expect((await call(null, `/api/clips/${uuidv7()}/chat`)).status).toBe(404);
  });
});

describe("retained", () => {
  test("false once the window has aged out and nothing remains", async () => {
    // A VOD still alive keeps its chat to CHAT_REPLAY_MAX_DAYS (60).
    const old = await broadcast(new Date(Date.now() - 70 * DAY), new Date(Date.now() - 70 * DAY + 60 * MIN));
    const oldVod = await vod(old.id);
    expect((await call(null, `/api/vods/${oldVod}/chat`)).body).toEqual({
      items: [],
      nextCursor: null,
      retained: false,
    });

    const recent = await broadcast(new Date(Date.now() - 40 * DAY), new Date(Date.now() - 40 * DAY + 60 * MIN));
    const recentVod = await vod(recent.id);
    expect((await call(null, `/api/vods/${recentVod}/chat`)).body.retained).toBe(true);

    // A clip whose VOD is gone: CHAT_RETENTION_DAYS (30) applies.
    const clipId = uuidv7();
    const gone = await broadcast(new Date(Date.now() - 40 * DAY), new Date(Date.now() - 40 * DAY + 60 * MIN));
    await db().insert(schema.clips).values({
      id: clipId,
      channelId,
      broadcastId: gone.id,
      title: "c",
      startOffset: 10,
      durationSeconds: 20,
      status: "ready",
    });
    expect((await call(null, `/api/clips/${clipId}/chat`)).body).toEqual({
      items: [],
      nextCursor: null,
      retained: false,
    });

    // Rows that are still there make it retained whatever their age.
    await say(old.id, await author(), new Date(old.startedAt.getTime() + MIN), null);
    const page = (await call(null, `/api/vods/${oldVod}/chat`)).body;
    expect(page.items).toHaveLength(1);
    expect(page.retained).toBe(true);
  });
});
