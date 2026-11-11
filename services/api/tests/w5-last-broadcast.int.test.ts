// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * w5-studio: `stream.lastBroadcast` counts the rows of the newest ended live broadcast exactly,
 * edges of its window included, excluded follows and deleted clips left out; null before any
 * broadcast ended. The HTTP tests cover the owner gate.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { LastBroadcast } from "@commonair/contracts/dto";
import { schema, uuidv7 } from "@commonair/db";
import { readLastBroadcast } from "../src/stream/last-broadcast.ts";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
let owner: User;
let other: User;

beforeAll(async () => {
  api = await startApi();
  [owner, other] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const admin = () => api.db.db;
const app = () => api.db.app.db;

let n = 0;
async function user() {
  n += 1;
  const name = `lb${n}${crypto.randomUUID().slice(0, 6)}`;
  const [u] = await admin()
    .insert(schema.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: schema.users.id });
  if (!u) throw new Error("no user");
  return u.id;
}

async function freshChannel() {
  const ownerId = await user();
  const slug = `lbc${n}${crypto.randomUUID().slice(0, 6)}`;
  const [c] = await admin()
    .insert(schema.channels)
    .values({ ownerId, slug, displayName: slug })
    .returning({ id: schema.channels.id });
  if (!c) throw new Error("no channel");
  return c.id;
}

async function broadcast(
  channelId: string,
  startedAt: Date,
  endedAt: Date | null,
  extra: Partial<typeof schema.broadcasts.$inferInsert> = {},
) {
  const [b] = await admin()
    .insert(schema.broadcasts)
    .values({ channelId, ingestProtocol: "rtmp", path: `live/${uuidv7()}`, startedAt, endedAt, ...extra })
    .returning({ id: schema.broadcasts.id });
  if (!b) throw new Error("no broadcast");
  return b.id;
}

async function follow(channelId: string, at: Date, excluded = false) {
  await admin()
    .insert(schema.follows)
    .values({ followerId: await user(), channelId, createdAt: at, excludedAt: excluded ? new Date() : null });
}

async function chat(channelId: string, at: Date, deleted = false) {
  await admin()
    .insert(schema.chatMessages)
    .values({ channelId, userId: await user(), body: "hi", createdAt: at, deletedAt: deleted ? at : null });
}

async function clip(channelId: string, broadcastId: string | null, status: "ready" | "deleted" = "ready") {
  await admin()
    .insert(schema.clips)
    .values({ channelId, broadcastId, title: "c", startOffset: 0, durationSeconds: 10, status });
}

const ms = (x: Date, d: number) => new Date(x.getTime() + d);

describe("readLastBroadcast", () => {
  test("null for a channel that never streamed, or is live for the first time", async () => {
    const channelId = await freshChannel();
    expect(await readLastBroadcast(app(), channelId)).toBeNull();
    await broadcast(channelId, new Date(Date.now() - 60_000), null);
    expect(await readLastBroadcast(app(), channelId)).toBeNull();
  });

  test("a rehearsal is not a broadcast", async () => {
    const channelId = await freshChannel();
    await broadcast(channelId, new Date(Date.now() - 600_000), new Date(), { kind: "rehearsal" });
    expect(await readLastBroadcast(app(), channelId)).toBeNull();
  });

  test("exact counts at the window edges", async () => {
    const channelId = await freshChannel();
    const start = new Date(Date.now() - 3_600_000);
    const end = ms(start, 3_000_000);
    const older = await broadcast(channelId, ms(start, -86_400_000), ms(start, -80_000_000));
    const id = await broadcast(channelId, start, end, { title: "Harbour at dusk", peakVerifiedViewers: 11 });
    // Follows: both edges count, one millisecond outside does not, excluded never.
    await follow(channelId, start);
    await follow(channelId, end);
    await follow(channelId, ms(start, 60_000));
    await follow(channelId, ms(start, -1));
    await follow(channelId, ms(end, 1));
    await follow(channelId, ms(start, 120_000), true);
    // Chat: edges and deleted ones count.
    await chat(channelId, start);
    await chat(channelId, end);
    await chat(channelId, ms(start, 5_000), true);
    await chat(channelId, ms(start, -1));
    await chat(channelId, ms(end, 1));
    // Clips: of this broadcast only, deleted ones left out.
    await clip(channelId, id);
    await clip(channelId, id);
    await clip(channelId, id, "deleted");
    await clip(channelId, older);
    await clip(channelId, null);
    const [vod] = await admin()
      .insert(schema.vods)
      .values({ broadcastId: id, channelId, title: "v", storagePrefix: `vods/${uuidv7()}`, status: "ready" })
      .returning({ id: schema.vods.id });

    const lb = await readLastBroadcast(app(), channelId);
    expect(lb).toEqual({
      broadcastId: id,
      title: "Harbour at dusk",
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      durationSeconds: 3000,
      newFollowers: 3,
      clips: 2,
      chatMessages: 3,
      peakSoFar: 11,
      vodId: vod?.id ?? null,
    } satisfies LastBroadcast);
  });

  test("the newest ended broadcast, while the next one is live; a deleted video is no video", async () => {
    const channelId = await freshChannel();
    const t0 = Date.now() - 7_200_000;
    await broadcast(channelId, new Date(t0), new Date(t0 + 600_000));
    const second = await broadcast(channelId, new Date(t0 + 1_200_000), new Date(t0 + 1_800_000));
    await broadcast(channelId, new Date(t0 + 3_600_000), null);
    await admin()
      .insert(schema.vods)
      .values({ broadcastId: second, channelId, title: "v", storagePrefix: `vods/${uuidv7()}`, status: "deleted" });
    const lb = await readLastBroadcast(app(), channelId);
    expect(lb).toMatchObject({ broadcastId: second, durationSeconds: 600, newFollowers: 0, clips: 0, vodId: null });
  });
});

describe("the route", () => {
  test("the owner reads it; others and signed-out callers are refused", async () => {
    const path = `/api/channels/${owner.username}/last-broadcast`;
    const none = await owner.client.call<LastBroadcast | null>("GET", path);
    expect(none.status, JSON.stringify(none.body)).toBe(200);
    expect(none.body).toBeNull();

    const [c] = await admin()
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.slug, owner.username));
    if (!c) throw new Error("no channel");
    const id = await broadcast(c.id, new Date(Date.now() - 600_000), new Date(), { peakVerifiedViewers: 4 });
    const r = await owner.client.call<LastBroadcast | null>("GET", path);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ broadcastId: id, peakSoFar: 4, newFollowers: 0 });

    expect((await client(api).call("GET", path)).status).toBe(401);
    expect([403, 404]).toContain((await other.client.call("GET", path)).status);
  });
});
