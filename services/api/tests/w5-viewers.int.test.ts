// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The channel owner is not their own audience (ADR 0014 amendment 2026-11-11): `viewerCounts`
 * (the public count's cache-miss path) and `viewerBreakdown` (the dashboard's health card) leave
 * the owner's sessions out, in every verdict and mode; a signed-out session and another account's
 * still count.
 */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { KEYS } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { viewerBreakdown, viewerCounts } from "../src/lib/viewers.ts";
import { startApi, uniqueName, type TestApi } from "./harness.ts";

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;

async function makeUser() {
  const name = uniqueName("w5v");
  const [user] = await db()
    .insert(schema.users)
    .values({ id: uuidv7(), name, email: `${name}@test.invalid`, username: name })
    .returning();
  return user!;
}

async function liveChannel() {
  const owner = await makeUser();
  const [channel] = await db()
    .insert(schema.channels)
    .values({ id: uuidv7(), ownerId: owner.id, slug: owner.username, displayName: owner.name })
    .returning();
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({ id: uuidv7(), channelId: channel!.id, ingestProtocol: "rtmp", path: `live/${channel!.id}` })
    .returning();
  return { owner, channelId: channel!.id, broadcastId: b!.id };
}

async function addSession(
  ch: { channelId: string; broadcastId: string },
  over: Partial<typeof schema.playbackSessions.$inferInsert> = {},
) {
  const now = api.deps.now().getTime();
  await db()
    .insert(schema.playbackSessions)
    .values({
      id: uuidv7(),
      channelId: ch.channelId,
      broadcastId: ch.broadcastId,
      deviceHash: crypto.randomUUID(),
      ipHash: crypto.randomUUID(),
      startedAt: new Date(now - 60_000),
      lastHeartbeatAt: new Date(now - 5_000),
      verdict: "verified",
      ...over,
    });
}

describe("live viewer numbers leave the owner out", () => {
  test("viewerCounts and viewerBreakdown count the signed-out viewer and the fan, never the owner", async () => {
    const ch = await liveChannel();
    const fan = await makeUser();
    await addSession(ch, { userId: ch.owner.id });
    await addSession(ch, { userId: ch.owner.id, verdict: "pending" });
    await addSession(ch, { userId: ch.owner.id, verdict: "excluded" });
    await addSession(ch, { userId: ch.owner.id, playbackMode: "dvr" });
    await addSession(ch); // signed out
    await addSession(ch, { userId: fan.id });
    await addSession(ch, { userId: fan.id, verdict: "pending" });
    await api.deps.valkey.del(KEYS.viewerCount(ch.channelId));

    expect((await viewerCounts(api.deps, [ch.channelId])).get(ch.channelId)).toBe(2);
    expect(await api.deps.valkey.get(KEYS.viewerCount(ch.channelId))).toBe("2");
    await api.deps.valkey.del(KEYS.viewerCount(ch.channelId));
    expect(await viewerBreakdown(api.deps, ch.channelId)).toMatchObject({
      verified: 2,
      pending: 1,
      excluded: 0,
      catchingUp: 0,
    });
  });

  test("a channel watched only by its owner counts zero", async () => {
    const ch = await liveChannel();
    const other = await liveChannel();
    await addSession(ch, { userId: ch.owner.id });
    await addSession(ch, { userId: ch.owner.id, verdict: "pending" });
    // The owner of one channel is an ordinary viewer of another.
    await addSession(other, { userId: ch.owner.id });
    await api.deps.valkey.del(KEYS.viewerCount(ch.channelId), KEYS.viewerCount(other.channelId));

    const counts = await viewerCounts(api.deps, [ch.channelId, other.channelId]);
    expect(counts.get(ch.channelId)).toBe(0);
    expect(counts.get(other.channelId)).toBe(1);
    await api.deps.valkey.del(KEYS.viewerCount(ch.channelId));
    expect(await viewerBreakdown(api.deps, ch.channelId)).toMatchObject({ verified: 0, pending: 0, excluded: 0 });
  });
});
