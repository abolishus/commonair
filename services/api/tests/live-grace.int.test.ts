// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The live reconnect grace (overhaul decision 2, F6; `media/live-grace.ts`): an encoder that drops
 * and returns within `LIVE_RULES.reconnectGraceSeconds` continues the same broadcast (one row, one
 * `stream.online`, no `stream.offline`); past it the broadcast ends at the moment it dropped.
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BUS } from "@commonair/contracts/events";
import { LIVE_RULES } from "@commonair/contracts/enums";
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER, KEYS, mediaPath } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import {
  finalizeLiveGrace,
  liveGraceSettings,
  readLiveGrace,
  setLiveGraceSettings,
  startLiveGraceSweeper,
  sweepLiveGraces,
} from "../src/media/live-grace.ts";
import { endLiveInTx } from "../src/moderation/live.ts";
import { signUpAndSignIn, startApi, subscriber, type TestApi } from "./harness.ts";

let api: TestApi;
let clock = Date.now();
const scheduled: number[] = [];
beforeAll(async () => {
  api = await startApi();
  api.deps.now = () => new Date(clock);
  // The test finalizes by hand; the scheduler only records the delay.
  setLiveGraceSettings(api.deps, { schedule: (ms) => void scheduled.push(ms) });
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const GRACE_MS = LIVE_RULES.reconnectGraceSeconds * 1000;
const db = () => api.db.db;
const channelOf = async (slug: string) => {
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, slug));
  if (!c) throw new Error(`no channel ${slug}`);
  return c;
};
const broadcastsOf = (channelId: string) =>
  db().select().from(schema.broadcasts).where(eq(schema.broadcasts.channelId, channelId));
const streamEvents = async (channelId: string) =>
  (
    await db()
      .select({ type: schema.events.type })
      .from(schema.events)
      .where(
        and(eq(schema.events.channelId, channelId), inArray(schema.events.type, ["stream.online", "stream.offline"])),
      )
  )
    .map((e) => e.type)
    .sort();

const hook = (route: string, slug: string, sourceId: string) =>
  fetch(`${api.url}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: api.internalSecret },
    body: JSON.stringify({ path: mediaPath(slug), sourceType: "rtmpConn", sourceId }),
  });
const ready = async (slug: string, sourceId = crypto.randomUUID()) => {
  expect((await hook(INTERNAL_ROUTES.mediaReady, slug, sourceId)).status).toBe(204);
  return sourceId;
};
const notReady = async (slug: string, sourceId: string) =>
  expect((await hook(INTERNAL_ROUTES.mediaNotReady, slug, sourceId)).status).toBe(204);

async function streamer() {
  const s = await signUpAndSignIn(api);
  const c = await channelOf(s.username);
  return { ...s, channelId: c.id };
}

/** Live bus events for one channel, collected while `fn` runs. */
async function busDuring(channelId: string, fn: () => Promise<void>): Promise<string[]> {
  const sub = subscriber();
  const seen: { channelId?: string; type?: string }[] = [];
  await sub.subscribe(BUS.live);
  sub.on("message", (_ch, msg) => seen.push(JSON.parse(msg) as { channelId?: string; type?: string }));
  try {
    await fn();
    await Bun.sleep(200);
  } finally {
    sub.disconnect();
  }
  return seen.filter((e) => e.channelId === channelId).map((e) => e.type ?? "");
}

async function addSession(
  st: { channelId: string },
  broadcastId: string,
  over: Partial<typeof schema.playbackSessions.$inferInsert> = {},
) {
  const [row] = await db()
    .insert(schema.playbackSessions)
    .values({
      channelId: st.channelId,
      broadcastId,
      deviceHash: crypto.randomUUID(),
      ipHash: crypto.randomUUID(),
      startedAt: new Date(clock - 60_000),
      lastHeartbeatAt: new Date(clock - 5_000),
      verdict: "verified",
      ...over,
    })
    .returning();
  if (!row) throw new Error("no session");
  return row;
}

describe("live reconnect grace", () => {
  test("the default grace is 30 s, and a drop schedules its finalize just past it", async () => {
    expect(LIVE_RULES.reconnectGraceSeconds).toBe(30);
    expect(api.deps.env.LIVE_RECONNECT_GRACE_SECONDS).toBe(30);
    expect(liveGraceSettings(api.deps).seconds).toBe(30);
    const st = await streamer();
    const source = await ready(st.username);
    scheduled.length = 0;
    await notReady(st.username, source);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toBeGreaterThan(GRACE_MS);
    expect(scheduled[0]).toBeLessThan(GRACE_MS + 1000);
  });

  test("a drop and return inside the grace continue the same broadcast", async () => {
    const st = await streamer();
    const events = await busDuring(st.channelId, async () => {
      const first = await ready(st.username);
      const [b] = await broadcastsOf(st.channelId);
      const session = await addSession(st, b!.id);
      clock += 60_000;
      await notReady(st.username, first);
      await notReady(st.username, first); // duplicate
      // Still live through the grace: the directory, the channel page and the viewers keep it.
      const during = await channelOf(st.username);
      expect(during.liveBroadcastId).toBe(b!.id);
      expect((await broadcastsOf(st.channelId))[0]?.endedAt).toBeNull();
      expect((await readLiveGrace(api.deps, st.channelId))?.broadcastId).toBe(b!.id);

      clock += GRACE_MS - 1000;
      await ready(st.username); // the encoder is back, a new source
      const all = await broadcastsOf(st.channelId);
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ id: b!.id, endedAt: null });
      expect((await channelOf(st.username)).liveBroadcastId).toBe(b!.id);
      expect(await readLiveGrace(api.deps, st.channelId)).toBeNull();
      const [s] = await db().select().from(schema.playbackSessions).where(eq(schema.playbackSessions.id, session.id));
      expect(s?.endedAt).toBeNull();

      // Nothing is left to finalize, however late the sweep runs.
      clock += 10 * GRACE_MS;
      expect(await finalizeLiveGrace(api.deps, st.channelId)).toBeNull();
      expect(await sweepLiveGraces(api.deps)).toBe(0);
      expect((await broadcastsOf(st.channelId))[0]?.endedAt).toBeNull();
    });
    // One go-live, no offline; media heard the resume as an `online` for the same broadcast.
    expect(await streamEvents(st.channelId)).toEqual(["stream.online"]);
    expect(events).toEqual(["online", "online"]);
  });

  test("a return after the grace starts a new broadcast; the old one ends when it dropped", async () => {
    const st = await streamer();
    const first = await ready(st.username);
    const [b] = await broadcastsOf(st.channelId);
    clock += 120_000;
    const droppedAt = clock;
    await notReady(st.username, first);
    clock += GRACE_MS + 1000;
    await ready(st.username);
    const all = (await broadcastsOf(st.channelId)).sort((x, y) => x.startedAt.getTime() - y.startedAt.getTime());
    expect(all).toHaveLength(2);
    expect(all[0]?.id).toBe(b!.id);
    expect(all[0]?.endedAt?.getTime()).toBe(droppedAt);
    expect(all[1]?.endedAt).toBeNull();
    expect((await channelOf(st.username)).liveBroadcastId).toBe(all[1]?.id);
    expect(await streamEvents(st.channelId)).toEqual(["stream.offline", "stream.online", "stream.online"]);
    expect(await readLiveGrace(api.deps, st.channelId)).toBeNull();
  });

  test("a grace that runs out with no reconnect ends the broadcast at the drop", async () => {
    const st = await streamer();
    const events = await busDuring(st.channelId, async () => {
      const first = await ready(st.username);
      const [b] = await broadcastsOf(st.channelId);
      const early = await addSession(st, b!.id);
      clock += 60_000;
      const droppedAt = clock;
      await notReady(st.username, first);
      // A viewer who joined during the grace ends no earlier than they started.
      clock += 5_000;
      const late = await addSession(st, b!.id, { startedAt: new Date(clock), lastHeartbeatAt: new Date(clock) });
      await api.deps.valkey.set(KEYS.viewerCount(st.channelId), "2", "EX", 60);

      clock += GRACE_MS - 10_000;
      expect(await sweepLiveGraces(api.deps)).toBe(0); // not due yet
      expect((await broadcastsOf(st.channelId))[0]?.endedAt).toBeNull();

      clock += 10_000;
      expect(await sweepLiveGraces(api.deps)).toBe(1);
      const [ended] = await broadcastsOf(st.channelId);
      expect(ended?.endedAt?.getTime()).toBe(droppedAt);
      expect((await channelOf(st.username)).liveBroadcastId).toBeNull();
      const sessions = await db()
        .select()
        .from(schema.playbackSessions)
        .where(inArray(schema.playbackSessions.id, [early.id, late.id]));
      const endOf = (id: string) => sessions.find((s) => s.id === id)?.endedAt?.getTime();
      expect(endOf(early.id)).toBe(droppedAt);
      expect(endOf(late.id)).toBe(late.startedAt.getTime());
      expect(await api.deps.valkey.exists(KEYS.viewerCount(st.channelId))).toBe(0);
      expect(await readLiveGrace(api.deps, st.channelId)).toBeNull();
      // Idempotent: a second sweep or a late timer finds nothing.
      expect(await sweepLiveGraces(api.deps)).toBe(0);
      expect(await finalizeLiveGrace(api.deps, st.channelId)).toBeNull();
    });
    expect(await streamEvents(st.channelId)).toEqual(["stream.offline", "stream.online"]);
    expect(events).toEqual(["online", "offline"]);
  });

  test("the sweeper ends a grace whose timer was lost, with no further hook", async () => {
    // The scheduler records but never runs: the same as an API restart dropping the timer.
    const st = await streamer();
    const first = await ready(st.username);
    const droppedAt = clock;
    await notReady(st.username, first);
    clock += GRACE_MS + 1000;
    const stop = startLiveGraceSweeper(api.deps, 50);
    try {
      const deadline = Date.now() + 5000;
      while (!(await broadcastsOf(st.channelId))[0]?.endedAt && Date.now() < deadline) await Bun.sleep(25);
    } finally {
      stop();
    }
    expect((await broadcastsOf(st.channelId))[0]?.endedAt?.getTime()).toBe(droppedAt);
    expect((await channelOf(st.username)).liveBroadcastId).toBeNull();
    expect(await readLiveGrace(api.deps, st.channelId)).toBeNull();
    expect(await streamEvents(st.channelId)).toEqual(["stream.offline", "stream.online"]);
  });

  test("a late not-ready of the source a reconnect replaced is ignored", async () => {
    const st = await streamer();
    const first = await ready(st.username);
    await notReady(st.username, first);
    clock += 1000;
    await ready(st.username); // resumed
    await notReady(st.username, first); // stale, delivered late
    expect(await readLiveGrace(api.deps, st.channelId)).toBeNull();
    clock += 10 * GRACE_MS;
    expect(await sweepLiveGraces(api.deps)).toBe(0);
    expect((await broadcastsOf(st.channelId))[0]?.endedAt).toBeNull();
  });

  test("a duplicate not-ready keeps the first drop time", async () => {
    const st = await streamer();
    const first = await ready(st.username);
    const droppedAt = clock;
    await notReady(st.username, first);
    clock += 20_000;
    await notReady(st.username, first);
    expect((await readLiveGrace(api.deps, st.channelId))?.droppedAt).toBe(new Date(droppedAt).toISOString());
    clock += 11_000; // 31 s after the first drop
    expect(await finalizeLiveGrace(api.deps, st.channelId)).not.toBeNull();
  });

  test("a broadcast ended another way during the grace is not ended twice", async () => {
    const st = await streamer();
    const first = await ready(st.username);
    await notReady(st.username, first);
    await db().transaction((tx) => endLiveInTx(tx, st.channelId, new Date(clock)));
    clock += GRACE_MS + 1000;
    expect(await finalizeLiveGrace(api.deps, st.channelId)).toBeNull();
    expect(await readLiveGrace(api.deps, st.channelId)).toBeNull();
    expect(await streamEvents(st.channelId)).toEqual(["stream.offline", "stream.online"]);
  });

  test("a zero grace ends the broadcast at once", async () => {
    const st = await streamer();
    const first = await ready(st.username);
    setLiveGraceSettings(api.deps, { seconds: 0 });
    try {
      await notReady(st.username, first);
    } finally {
      setLiveGraceSettings(api.deps, { seconds: LIVE_RULES.reconnectGraceSeconds });
    }
    expect((await broadcastsOf(st.channelId))[0]?.endedAt?.getTime()).toBe(clock);
    expect(await streamEvents(st.channelId)).toEqual(["stream.offline", "stream.online"]);
  });
});

describe("dashboard health numbers", () => {
  test("health reads the public live count, the same filter, and the running peak", async () => {
    const st = await streamer();
    await ready(st.username);
    const [b] = await broadcastsOf(st.channelId);
    const id = b!.id;
    await addSession(st, id);
    await addSession(st, id);
    await addSession(st, id, { playbackMode: "dvr" }); // catching up, not watching live
    await addSession(st, id, { verdict: "pending" });
    await addSession(st, id, { verdict: "excluded" });
    await addSession(st, id, { verdict: "pending", playbackMode: "dvr" });
    await addSession(st, id, { lastHeartbeatAt: new Date(clock - 60_000) }); // gone quiet
    await addSession(st, id, { endedAt: new Date(clock - 1000) }); // left
    await db().update(schema.broadcasts).set({ peakVerifiedViewers: 7 }).where(eq(schema.broadcasts.id, id));
    await api.deps.valkey.del(KEYS.viewerCount(st.channelId));
    await api.deps.valkey.set(KEYS.catchingUpCount(st.channelId), "1", "EX", 60);

    type Health = {
      live: boolean;
      viewers: { verified: number; pending: number; excluded: number; catchingUp?: number };
      peakSoFar?: number;
    };
    const health = await st.client.call<Health>("GET", `/api/channels/${st.username}/health`);
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      live: true,
      viewers: { verified: 2, pending: 1, excluded: 1, catchingUp: 1 },
      peakSoFar: 7,
    });
    // The public count is the same number.
    const pub = await st.client.call<{ live: { viewerCount: number } | null }>("GET", `/api/channels/${st.username}`);
    expect(pub.body.live?.viewerCount).toBe(2);

    // The worker's cached count wins on both surfaces, and the peak is never below it.
    await api.deps.valkey.set(KEYS.viewerCount(st.channelId), "9", "EX", 60);
    const cached = await st.client.call<Health>("GET", `/api/channels/${st.username}/health`);
    expect(cached.body.viewers.verified).toBe(9);
    expect(cached.body.peakSoFar).toBe(9);
    const pub2 = await st.client.call<{ live: { viewerCount: number } | null }>("GET", `/api/channels/${st.username}`);
    expect(pub2.body.live?.viewerCount).toBe(9);
  });

  test("offline health has no peak", async () => {
    const st = await streamer();
    const health = await st.client.call<{ live: boolean; peakSoFar?: number }>(
      "GET",
      `/api/channels/${st.username}/health`,
    );
    expect(health.body).toMatchObject({ live: false, peakSoFar: 0 });
  });
});

describe("analytics live entry", () => {
  test("the range carries the live broadcast with its running peak", async () => {
    const st = await streamer();
    const range = (from: number, to: number) =>
      st.client.call<{ live?: { broadcastId: string; title: string; startedAt: string; peakSoFar: number } | null }>(
        "GET",
        `/api/channels/${st.username}/analytics?from=${encodeURIComponent(new Date(from).toISOString())}&to=${encodeURIComponent(new Date(to).toISOString())}`,
      );
    expect((await range(clock - 86_400_000, clock + 1000)).body.live).toBeNull();

    const startedAt = clock;
    const source = await ready(st.username);
    const [b] = await broadcastsOf(st.channelId);
    await db().update(schema.broadcasts).set({ peakVerifiedViewers: 4 }).where(eq(schema.broadcasts.id, b!.id));
    const live = await range(clock - 86_400_000, clock + 1000);
    expect(live.status).toBe(200);
    expect(live.body.live).toMatchObject({
      broadcastId: b!.id,
      startedAt: new Date(startedAt).toISOString(),
      peakSoFar: 4,
    });
    // A period that ended before the stream started does not show it.
    expect((await range(clock - 86_400_000, clock - 1000)).body.live).toBeNull();

    // Past the grace it has ended, and the entry goes.
    await notReady(st.username, source);
    clock += GRACE_MS + 1000;
    await sweepLiveGraces(api.deps);
    expect((await range(clock - 86_400_000, clock + 1000)).body.live).toBeNull();
  });
});
