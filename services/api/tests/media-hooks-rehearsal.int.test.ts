// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The rehearsal gate (batch 6 decision (f), `media/hooks.ts`): while a rehearsal is armed, the
 * normal key publishes a `kind = 'rehearsal'` broadcast that nothing outside it sees. No
 * `stream.online` / `stream.offline` outbox row means the N1 go-live fan-out, EventSub, webhooks,
 * Discord, raids and goals (all outbox consumers) see nothing; `stream_hours` refuses the row.
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BUS } from "@commonair/contracts/events";
import {
  INTERNAL_ROUTES,
  INTERNAL_SECRET_HEADER,
  KEYS,
  mediaPath,
  type RehearsalArm,
} from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { REHEARSAL_RULES } from "@commonair/contracts/enums";
import { afterBroadcastEnded, endLiveInTx } from "../src/moderation/live.ts";
import { client, signUpAndSignIn, startApi, subscriber, type Client, type TestApi } from "./harness.ts";

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
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
const streamEvents = (channelId: string) =>
  db()
    .select({ type: schema.events.type })
    .from(schema.events)
    .where(
      and(eq(schema.events.channelId, channelId), inArray(schema.events.type, ["stream.online", "stream.offline"])),
    );
const broadcastsOf = (channelId: string) =>
  db().select().from(schema.broadcasts).where(eq(schema.broadcasts.channelId, channelId));

const mediaAuth = (body: Record<string, unknown>) =>
  fetch(`${api.url}${INTERNAL_ROUTES.mediaAuth}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ip: "10.0.0.5", protocol: "rtmp", ...body }),
  });
const hook = (route: string, slug: string, sourceId: string) =>
  fetch(`${api.url}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: api.internalSecret },
    body: JSON.stringify({ path: mediaPath(slug), sourceType: "rtmpConn", sourceId }),
  });

async function streamer() {
  const s = await signUpAndSignIn(api);
  const r = await s.client.call<{ key: string }>("POST", `/api/channels/${s.username}/stream-keys`);
  expect(r.status).toBe(200);
  const secret = r.body.key.split("?key=")[1] ?? "";
  const c = await channelOf(s.username);
  return { ...s, secret, channelId: c.id, ownerId: c.ownerId };
}

async function arm(channelId: string, ownerId: string): Promise<RehearsalArm> {
  const value: RehearsalArm = { armId: uuidv7(), ownerId, armedAt: new Date().toISOString() };
  await api.deps.valkey.set(KEYS.rehearsalArmed(channelId), JSON.stringify(value), "EX", 600);
  return value;
}

async function publish(st: { username: string; secret: string }, sourceId = crypto.randomUUID()) {
  expect((await mediaAuth({ action: "publish", path: mediaPath(st.username), query: `key=${st.secret}` })).status).toBe(
    200,
  );
  expect((await hook(INTERNAL_ROUTES.mediaReady, st.username, sourceId)).status).toBe(204);
  return sourceId;
}

async function startPlayback(viewer: Client, slug: string) {
  return viewer.call<{ code?: string }>("POST", `/api/channels/${slug}/playback`, {
    deviceId: "device-0123456789abcdef",
  });
}

describe("rehearsal gate", () => {
  test("an armed publish starts a rehearsal nothing outside it sees, and ends it quietly", async () => {
    const st = await streamer();
    const invitee = await signUpAndSignIn(api);
    const armed = await arm(st.channelId, st.ownerId);
    await db()
      .insert(schema.follows)
      .values({ followerId: invitee.userId, channelId: st.channelId })
      .onConflictDoNothing();
    await db()
      .insert(schema.rehearsalInvitees)
      .values({ armId: armed.armId, channelId: st.channelId, userId: invitee.userId });

    const sub = subscriber();
    const bus: Record<string, unknown>[] = [];
    await sub.subscribe(BUS.live);
    sub.on("message", (_ch, msg) => bus.push(JSON.parse(msg) as Record<string, unknown>));
    try {
      const sourceId = await publish(st);
      await hook(INTERNAL_ROUTES.mediaReady, st.username, sourceId); // duplicate ready
      const [b, ...more] = await broadcastsOf(st.channelId);
      expect(more).toEqual([]);
      expect(b).toMatchObject({ kind: "rehearsal", endedAt: null, path: mediaPath(st.username) });
      expect(b?.streamKeyId).not.toBeNull();
      // Never the channel's live broadcast: no directory entry, no channel `live`, no playback.
      expect((await channelOf(st.username)).liveBroadcastId).toBeNull();
      const pub = await client(api).call<{ live: unknown }>("GET", `/api/channels/${st.username}`);
      expect(pub.body.live).toBeNull();
      const dir = await client(api).call<{ items: { channel: { slug: string } }[] }>("GET", "/api/directory/live");
      expect(dir.status).toBe(200);
      expect(JSON.stringify(dir.body)).not.toContain(`"${st.username}"`);
      expect((await startPlayback(client(api), st.username)).status).toBe(412);
      // The arm's invitees carry over into the rehearsal.
      const [inv] = await db()
        .select()
        .from(schema.rehearsalInvitees)
        .where(eq(schema.rehearsalInvitees.armId, armed.armId));
      expect(inv?.broadcastId).toBe(b?.id);
      // stream_hours (eligibility, patronage) refuses a rehearsal outright.
      await expect(
        db()
          .insert(schema.streamHours)
          .values({ broadcastId: b!.id, channelId: st.channelId, hourStart: new Date(), liveSeconds: 60 }),
      ).rejects.toMatchObject({ cause: { message: "a rehearsal broadcast never reaches stream_hours" } });

      // Invitee playback sessions end with the rehearsal.
      const [ps] = await db()
        .insert(schema.playbackSessions)
        .values({ channelId: st.channelId, broadcastId: b!.id, userId: invitee.userId, deviceHash: "d", ipHash: "i" })
        .returning();
      expect((await hook(INTERNAL_ROUTES.mediaNotReady, st.username, sourceId)).status).toBe(204);
      const [ended] = await broadcastsOf(st.channelId);
      expect(ended?.endedAt).not.toBeNull();
      const [psAfter] = await db().select().from(schema.playbackSessions).where(eq(schema.playbackSessions.id, ps!.id));
      expect(psAfter?.endedAt).not.toBeNull();

      // Nothing for any outbox consumer: go-live fan-out, EventSub, webhooks, Discord, goals.
      expect(await streamEvents(st.channelId)).toEqual([]);
      // Media still ran it (online / offline on BUS.live).
      await Bun.sleep(200);
      expect(bus.filter((e) => e.channelId === st.channelId).map((e) => e.type)).toEqual(["online", "offline"]);
    } finally {
      sub.disconnect();
    }
  });

  test("the arm is taken at auth: a lapse before ready still rehearses; unarmed publishes go live", async () => {
    const st = await streamer();
    await arm(st.channelId, st.ownerId);
    expect(
      (await mediaAuth({ action: "publish", path: mediaPath(st.username), query: `key=${st.secret}` })).status,
    ).toBe(200);
    await api.deps.valkey.del(KEYS.rehearsalArmed(st.channelId));
    const first = crypto.randomUUID();
    expect((await hook(INTERNAL_ROUTES.mediaReady, st.username, first)).status).toBe(204);
    expect((await broadcastsOf(st.channelId)).map((b) => b.kind)).toEqual(["rehearsal"]);
    await hook(INTERNAL_ROUTES.mediaNotReady, st.username, first);

    // No arm and no rehearsal session at the next auth (disarm deletes both): the publish is live,
    // with stream.online and stream.offline.
    await api.deps.valkey.del(KEYS.rehearsalSession(st.channelId));
    const live = await publish(st);
    const c = await channelOf(st.username);
    expect(c.liveBroadcastId).not.toBeNull();
    const [lb] = await db().select().from(schema.broadcasts).where(eq(schema.broadcasts.id, c.liveBroadcastId!));
    expect(lb?.kind).toBe("live");
    await hook(INTERNAL_ROUTES.mediaNotReady, st.username, live);
    expect((await streamEvents(st.channelId)).map((e) => e.type).sort()).toEqual(["stream.offline", "stream.online"]);
  });

  test("an arm written for another owner, or unreadable, is ignored (live)", async () => {
    const st = await streamer();
    const other = await signUpAndSignIn(api);
    await api.deps.valkey.set(
      KEYS.rehearsalArmed(st.channelId),
      JSON.stringify({ armId: uuidv7(), ownerId: other.userId, armedAt: new Date().toISOString() }),
      "EX",
      600,
    );
    const s1 = await publish(st);
    expect((await channelOf(st.username)).liveBroadcastId).not.toBeNull();
    await hook(INTERNAL_ROUTES.mediaNotReady, st.username, s1);
    await api.deps.valkey.set(KEYS.rehearsalArmed(st.channelId), "{not json", "EX", 600);
    const s2 = await publish(st);
    expect((await channelOf(st.username)).liveBroadcastId).not.toBeNull();
    await hook(INTERNAL_ROUTES.mediaNotReady, st.username, s2);
    expect((await broadcastsOf(st.channelId)).every((b) => b.kind === "live")).toBe(true);
  });

  test("a channel that only rehearsed is never 'recently live' in the directory", async () => {
    const st = await streamer();
    await arm(st.channelId, st.ownerId);
    const sourceId = await publish(st);
    await hook(INTERNAL_ROUTES.mediaNotReady, st.username, sourceId);
    const [b] = await broadcastsOf(st.channelId);
    expect(b).toMatchObject({ kind: "rehearsal" });
    expect(b?.endedAt).not.toBeNull();
    const home = await client(api).call<{ recentlyLive: { channel: { slug: string } }[] }>("GET", "/api/directory");
    expect(home.status).toBe(200);
    expect(home.body.recentlyLive.map((c) => c.channel.slug)).not.toContain(st.username);
  });

  test("a reconnect after the arm lapsed still rehearses; after a kick it is refused", async () => {
    const st = await streamer();
    await arm(st.channelId, st.ownerId);
    const first = await publish(st);
    // The session marker outlives the arm (TTL cap + grace).
    const ttl = await api.deps.valkey.ttl(KEYS.rehearsalSession(st.channelId));
    expect(ttl).toBeGreaterThan(REHEARSAL_RULES.maxDurationSeconds);
    await hook(INTERNAL_ROUTES.mediaNotReady, st.username, first);
    // Not-ready shrinks it to the reconnect grace: a go-live much later is live, not a rehearsal.
    const graceTtl = await api.deps.valkey.ttl(KEYS.rehearsalSession(st.channelId));
    expect(graceTtl).toBeGreaterThan(0);
    expect(graceTtl).toBeLessThanOrEqual(REHEARSAL_RULES.sessionGraceSeconds);
    await api.deps.valkey.del(KEYS.rehearsalArmed(st.channelId));
    // A network drop past the arm's TTL: the encoder reconnects, and it is still a rehearsal.
    const second = await publish(st);
    expect((await channelOf(st.username)).liveBroadcastId).toBeNull();
    expect((await broadcastsOf(st.channelId)).map((b) => b.kind)).toEqual(["rehearsal", "rehearsal"]);
    // A moderation end kicks the publisher: its automatic reconnect is refused for a while.
    const ended = await db().transaction((tx) => endLiveInTx(tx, st.channelId, new Date()));
    expect(ended?.kind).toBe("rehearsal");
    await afterBroadcastEnded(api.deps, ended);
    expect(await api.deps.valkey.exists(KEYS.rehearsalKicked(st.channelId))).toBe(1);
    expect(
      (await mediaAuth({ action: "publish", path: mediaPath(st.username), query: `key=${st.secret}` })).status,
    ).toBe(401);
    await hook(INTERNAL_ROUTES.mediaNotReady, st.username, second);
    // Disarm (W2-rehearsal) clears the session too; then a publish is live.
    await api.deps.valkey.del(KEYS.rehearsalKicked(st.channelId), KEYS.rehearsalSession(st.channelId));
    const live = await publish(st);
    expect((await channelOf(st.username)).liveBroadcastId).not.toBeNull();
    await hook(INTERNAL_ROUTES.mediaNotReady, st.username, live);
    expect(await streamEvents(st.channelId)).toHaveLength(2);
  });

  test("a stale live pointer neither blocks a rehearsal nor leaves it open", async () => {
    const st = await streamer();
    // An ended live broadcast the channel still points at.
    const [stale] = await db()
      .insert(schema.broadcasts)
      .values({
        channelId: st.channelId,
        ingestProtocol: "rtmp",
        path: mediaPath(st.username),
        startedAt: new Date(Date.now() - 7_200_000),
        endedAt: new Date(Date.now() - 3_600_000),
      })
      .returning();
    await db().update(schema.channels).set({ liveBroadcastId: stale!.id }).where(eq(schema.channels.id, st.channelId));
    await arm(st.channelId, st.ownerId);
    const sourceId = await publish(st);
    expect((await channelOf(st.username)).liveBroadcastId).toBeNull();
    // Even if a pointer reappears, not-ready still ends the rehearsal.
    await db().update(schema.channels).set({ liveBroadcastId: stale!.id }).where(eq(schema.channels.id, st.channelId));
    await hook(INTERNAL_ROUTES.mediaNotReady, st.username, sourceId);
    const open = (await broadcastsOf(st.channelId)).filter((b) => b.kind === "rehearsal" && b.endedAt === null);
    expect(open).toEqual([]);
    expect((await channelOf(st.username)).liveBroadcastId).toBeNull();
    expect(await streamEvents(st.channelId)).toEqual([]);
  });

  test("a rehearsal VOD stays private and is never clipped", async () => {
    const st = await streamer();
    await arm(st.channelId, st.ownerId);
    const sourceId = await publish(st);
    await hook(INTERNAL_ROUTES.mediaNotReady, st.username, sourceId);
    const [b] = await broadcastsOf(st.channelId);
    const [vod] = await db()
      .insert(schema.vods)
      .values({
        channelId: st.channelId,
        broadcastId: b!.id,
        title: "rehearsal",
        status: "ready",
        visibility: "private",
        durationSeconds: 120,
        storagePrefix: `vods/${b!.id}/`,
      })
      .returning();
    const pub = await st.client.call<{ data?: { requirement?: string } }>("PATCH", `/api/vods/${vod!.id}`, {
      visibility: "public",
    });
    expect(pub.status).toBe(412);
    expect(pub.body.data?.requirement).toBe("rehearsal");
    expect((await st.client.call("PATCH", `/api/vods/${vod!.id}`, { title: "renamed" })).status).toBe(200);
    const clip = await st.client.call<{ data?: { requirement?: string } }>(
      "POST",
      `/api/channels/${st.username}/clips`,
      { vodId: vod!.id, startOffset: 0, durationSeconds: 30, title: "nope" },
    );
    expect(clip.status).toBe(412);
    expect(clip.body.data?.requirement).toBe("rehearsal");
  });

  test("a suspension (endLiveInTx) ends an open rehearsal without stream.offline", async () => {
    const st = await streamer();
    await arm(st.channelId, st.ownerId);
    await publish(st);
    const ended = await db().transaction((tx) => endLiveInTx(tx, st.channelId, new Date()));
    expect(ended).toMatchObject({ channelId: st.channelId, slug: st.username });
    const [b] = await broadcastsOf(st.channelId);
    expect(b).toMatchObject({ kind: "rehearsal" });
    expect(b?.endedAt).not.toBeNull();
    expect(await streamEvents(st.channelId)).toEqual([]);
    // Nothing open any more.
    expect(await db().transaction((tx) => endLiveInTx(tx, st.channelId, new Date()))).toBeNull();
  });
});
