// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/dvr/` against real Postgres (the VOD state lookup and the channel window), Valkey (the segment
 * log) and object storage (Garage, the media bucket): ADR 0016 decisions 2–5.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { dvrTokenPath, vodPrefix } from "@commonair/contracts/storage";
import type { PlaybackClaims } from "@commonair/contracts/tokens";
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createValkey, type ValkeyClient } from "@commonair/service";
import { createS3Storage, type ObjectStorage } from "@commonair/storage";
import { generateSigningKey, randomSecret, sha256Hex, signPlaybackToken, type SigningKey } from "@commonair/tokens";
import { eq } from "drizzle-orm";
import { createOrigin, type Origin } from "../src/origin.ts";
import { VOD_STATE_TTL_MS } from "../src/vod.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6379";
const BUCKET = process.env.S3_BUCKET_MEDIA ?? "commonair-media";
const prefix = `test:${crypto.randomUUID()}:`;
const stream = `stream:segments:${crypto.randomUUID()}`;
let t: TestDatabase;
let valkey: ValkeyClient;
let storage: ObjectStorage;
let key: SigningKey;
let origin: Origin;
const written: string[] = [];

const SEGMENTS = 30;
const T0 = Date.now() - SEGMENTS * 4000;

function recorderPlaylist(n: number): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:4", "#EXT-X-MEDIA-SEQUENCE:0"];
  lines.push("#EXT-X-PLAYLIST-TYPE:EVENT", "#EXT-X-INDEPENDENT-SEGMENTS", '#EXT-X-MAP:URI="r1_init.mp4"');
  for (let i = 0; i < n; i++)
    lines.push(
      `#EXT-X-PROGRAM-DATE-TIME:${new Date(T0 + i * 4000).toISOString()}`,
      "#EXTINF:4.000000,",
      `r1_${String(i).padStart(6, "0")}.m4s`,
    );
  return `${lines.join("\n")}\n`;
}

async function put(k: string, body: string) {
  await storage.put(BUCKET, k, body);
  written.push(k);
}

interface Recording {
  channel: string;
  broadcast: string;
  vod: string;
}

/** A channel (own row, so suspension and DVR settings stay per test) live with a recording VOD and its objects. */
async function recording(
  over: {
    channel?: Partial<typeof schema.channels.$inferInsert>;
    broadcast?: Partial<typeof schema.broadcasts.$inferInsert>;
    vod?: Partial<typeof schema.vods.$inferInsert>;
  } = {},
): Promise<Recording> {
  const channel = uuidv7();
  const broadcast = uuidv7();
  const vod = uuidv7();
  const slug = `dvr${channel.slice(-8)}`;
  const owner = uuidv7();
  await t.db.insert(schema.users).values({ id: owner, name: slug, email: `${slug}@test.invalid`, username: slug });
  await t.db.insert(schema.channels).values({
    id: channel,
    ownerId: owner,
    slug,
    displayName: slug,
    vodEnabled: true,
    dvrWindowSeconds: 60,
    ...over.channel,
  });
  await t.db.insert(schema.broadcasts).values({
    id: broadcast,
    channelId: channel,
    ingestProtocol: "rtmp",
    path: `live/${slug}`,
    ...over.broadcast,
  });
  await t.db.insert(schema.vods).values({
    id: vod,
    channelId: channel,
    broadcastId: broadcast,
    title: "rec",
    storagePrefix: vodPrefix(vod, "private"),
    ...over.vod,
  });
  const p = vodPrefix(vod, "private");
  await put(`${p}index.m3u8`, recorderPlaylist(SEGMENTS));
  await put(`${p}r1_init.mp4`, "init");
  for (let i = 0; i < SEGMENTS; i++) await put(`${p}r1_${String(i).padStart(6, "0")}.m4s`, `segment-${i}`);
  // A decoy under the public prefix: the route must never read it.
  await put(`${vodPrefix(vod, "public")}index.m3u8`, "#EXTM3U\n#EXTINF:4,\ndecoy.m4s\n");
  return { channel, broadcast, vod };
}

const sid = uuidv7();
async function token(r: Recording, over: Partial<PlaybackClaims> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signPlaybackToken(key, {
    v: 1,
    sid,
    cid: r.channel,
    path: dvrTokenPath(r.vod),
    src: "origin",
    iat: now,
    exp: now + 120,
    ...over,
  });
}

const get = async (r: Recording, file: string, tk?: string, init?: RequestInit) =>
  origin.fetch(new Request(`http://origin.test/dvr/${r.vod}/${file}?t=${tk ?? (await token(r))}`, init));

const uris = (body: string) => body.split("\n").filter((l) => l !== "" && !l.startsWith("#"));

beforeAll(async () => {
  const [db, generated] = await Promise.all([createTestDatabase(), generateSigningKey()]);
  t = db;
  key = generated.key;
  valkey = createValkey(VALKEY_URL, { keyPrefix: prefix });
  storage = createS3Storage({
    endpoint: process.env.S3_ENDPOINT ?? "http://localhost:3900",
    region: process.env.S3_REGION ?? "garage",
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
    forcePathStyle: true,
  });
  origin = await createOrigin({
    db: t.db,
    valkey,
    playbackSigningKey: generated.pkcs8B64,
    // Never contacted: /dvr/ reads object storage only.
    mediamtxHlsUrl: "http://127.0.0.1:9",
    internalSecret: "x".repeat(32),
    mediaPassword: "x".repeat(32),
    cacheMb: 8,
    cdn: { provider: "none" },
    media: { storage, bucket: BUCKET },
    dvrMaxWindowSeconds: 7200,
    segmentStream: stream,
    segmentFlushMs: 50,
  });
  origin.start();
});

afterAll(async () => {
  await origin?.stop();
  await Promise.allSettled(written.map((k) => storage.delete(BUCKET, k)));
  await valkey?.del(stream);
  await valkey?.quit();
  await t?.drop();
});

describe("/dvr/ with real state and storage", () => {
  test("serves the channel's window from the recording, never vods/; segments listed in it", async () => {
    const r = await recording();
    const res = await get(r, "index.m3u8");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.text();
    // dvr_window_seconds = 60: the last 15 of 30 four-second segments.
    expect(uris(body)).toHaveLength(15);
    expect(uris(body)[0]).toMatch(/^r1_000015\.m4s\?t=/);
    expect(body).toContain("#EXT-X-MEDIA-SEQUENCE:15");
    expect(body).not.toContain("decoy");
    expect(body).not.toContain("ENDLIST");

    const seg = await get(r, "r1_000029.m4s");
    expect(seg.status).toBe(200);
    expect(await seg.text()).toBe("segment-29");
    expect((await get(r, "r1_init.mp4")).status).toBe(200);
    // In storage, but outside the window.
    expect((await get(r, "r1_000000.m4s")).status).toBe(404);
    // The segment being recorded: not listed yet, whether or not its object exists.
    await put(`${vodPrefix(r.vod, "private")}r1_000030.m4s`, "partial");
    expect((await get(r, "r1_000030.m4s")).status).toBe(404);
    // HEAD answers without a body.
    const head = await get(r, "r1_000029.m4s", undefined, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("the window follows the instance cap and the channel's setting", async () => {
    const r = await recording({ channel: { dvrWindowSeconds: 7200 } });
    expect(uris(await (await get(r, "index.m3u8")).text())).toHaveLength(SEGMENTS);
  });

  test("every playlist and segment served goes to the segment log for the session", async () => {
    const r = await recording();
    await origin.segments.flush();
    await valkey.del(stream);
    const pl = await get(r, "index.m3u8");
    const plBytes = (await pl.arrayBuffer()).byteLength;
    const seg = await get(r, "r1_000020.m4s");
    await seg.arrayBuffer();
    await get(r, "r1_000021.m4s", undefined, { method: "HEAD" });
    await origin.segments.flush();
    const entries = (await valkey.xrange(stream, "-", "+")).map(([, f]) =>
      Object.fromEntries(f.flatMap((_, i, a) => (i % 2 === 0 ? [[a[i], a[i + 1]]] : []))),
    );
    expect(entries.map((e) => [e.sid, e.cid, e.src, e.kind, Number(e.bytes), e.obj])).toEqual([
      [sid, r.channel, "origin", "playlist", plBytes, undefined],
      [sid, r.channel, "origin", "segment", "segment-20".length, `dvr/${r.vod}/r1_000020.m4s`],
    ]);
    expect(entries.every((e) => e.mode === "dvr")).toBe(true);
  });

  test("token refusals: a live token, another VOD's DVR token, a relay token, a wrong channel", async () => {
    const r = await recording();
    const other = await recording();
    for (const tk of [
      await token(r, { path: `live/dvr${r.channel.slice(-8)}` }),
      await token(other),
      await token(r, { src: "relay", rid: uuidv7() }),
      await token(r, { cid: other.channel }),
    ])
      expect((await get(r, "index.m3u8", tk)).status).toBe(401);
  });

  test.each<[string, Parameters<typeof recording>[0]]>([
    ["broadcast ended", { broadcast: { endedAt: new Date() } }],
    ["a rehearsal", { broadcast: { kind: "rehearsal" } }],
    ["T1-restricted", { broadcast: { restrictedAt: new Date() } }],
    ["channel suspended", { channel: { suspendedAt: new Date() } }],
    ["DVR off", { channel: { dvrEnabled: false } }],
    ["VOD already ready", { vod: { status: "ready" } }],
    ["VOD removed", { vod: { removedReason: "owner" } }],
  ])("%s: 404", async (_name, over) => {
    const r = await recording(over);
    expect((await get(r, "index.m3u8")).status).toBe(404);
    expect((await get(r, "r1_000029.m4s")).status).toBe(404);
  });

  test("a removal or a T0 closes DVR within the 5 s state cache", async () => {
    for (const change of [{ removedReason: "owner" }, { status: "deleted" as const, removedReason: "t0" }]) {
      const r = await recording();
      expect((await get(r, "index.m3u8")).status).toBe(200);
      await t.db.update(schema.vods).set(change).where(eq(schema.vods.id, r.vod));
      const changed = Date.now();
      let status = 200;
      while (status === 200 && Date.now() - changed < VOD_STATE_TTL_MS + 3_000) {
        status = (await get(r, "r1_000029.m4s")).status;
        if (status === 200) await Bun.sleep(250);
      }
      expect(status).toBe(404);
      // Bound by the cache TTL, with slack for a loaded runner.
      expect(Date.now() - changed).toBeLessThan(VOD_STATE_TTL_MS + 3_000);
      expect((await get(r, "index.m3u8")).status).toBe(404);
    }
  });
});

// Batch 7 decision (x), ADR 0016 Amendment 1 A1.3: relays pull DVR from `/relay-pull/dvr/`.
describe("/relay-pull/dvr/ with real relay auth, state and storage", () => {
  const relayToken = randomSecret("relay_");
  let relayId: string;

  beforeAll(async () => {
    const owner = uuidv7();
    await t.db
      .insert(schema.users)
      .values({ id: owner, name: "ro", email: `ro-${owner}@test.invalid`, username: `ro${owner.slice(-8)}` });
    const [row] = await t.db
      .insert(schema.relayNodes)
      .values({
        ownerId: owner,
        name: "dvr relay",
        publicUrl: "http://relay.test.invalid",
        declaredCapacityMbps: 100,
        publicKey: "k",
        tokenHash: await sha256Hex(relayToken),
        status: "active",
      })
      .returning({ id: schema.relayNodes.id });
    relayId = row!.id;
  });

  const pull = (r: Recording, file: string, bearer: string | null = relayToken, init: RequestInit = {}) =>
    origin.fetch(
      new Request(`http://origin.test/relay-pull/dvr/${r.vod}/${file}`, {
        ...init,
        headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
      }),
      "10.1.2.3",
    );

  test("the window with bare relative URIs; listed segments only; logged as the relay's dvr fetches", async () => {
    const r = await recording();
    await origin.segments.flush();
    await valkey.del(stream);
    const pl = await pull(r, "index.m3u8");
    expect(pl.status).toBe(200);
    const body = await pl.text();
    expect(uris(body)).toHaveLength(15);
    expect(uris(body)[0]).toBe("r1_000015.m4s");
    expect(body).not.toContain("?t=");
    expect(body).not.toContain("decoy");
    const seg = await pull(r, "r1_000029.m4s");
    expect(await seg.text()).toBe("segment-29");
    expect((await pull(r, "r1_000000.m4s")).status).toBe(404);
    await origin.segments.flush();
    const entries = (await valkey.xrange(stream, "-", "+")).map(([, f]) =>
      Object.fromEntries(f.flatMap((_, i, a) => (i % 2 === 0 ? [[a[i], a[i + 1]]] : []))),
    );
    expect(entries.map((e) => [e.sid, e.cid, e.src, e.rid, e.kind, e.obj, e.mode])).toEqual([
      [relayId, r.channel, "relay", relayId, "playlist", undefined, "dvr"],
      [relayId, r.channel, "relay", relayId, "segment", `dvr/${r.vod}/r1_000029.m4s`, "dvr"],
    ]);
  });

  test("auth: no token, an unknown token, a viewer's DVR token or a suspended relay is 401", async () => {
    const r = await recording();
    expect((await pull(r, "index.m3u8", null)).status).toBe(401);
    expect((await pull(r, "index.m3u8", randomSecret("relay_"))).status).toBe(401);
    const viewer = await origin.fetch(
      new Request(`http://origin.test/relay-pull/dvr/${r.vod}/index.m3u8?t=${await token(r)}`),
      "10.9.9.9",
    );
    expect(viewer.status).toBe(401);
    const suspendedToken = randomSecret("relay_");
    const [owner] = await t.db.select({ id: schema.users.id }).from(schema.users).limit(1);
    await t.db.insert(schema.relayNodes).values({
      ownerId: owner!.id,
      name: "suspended relay",
      publicUrl: "http://relay2.test.invalid",
      declaredCapacityMbps: 100,
      publicKey: "k",
      tokenHash: await sha256Hex(suspendedToken),
      status: "suspended",
    });
    expect((await pull(r, "index.m3u8", suspendedToken)).status).toBe(401);
  });

  test.each<[string, Parameters<typeof recording>[0]]>([
    ["broadcast ended", { broadcast: { endedAt: new Date() } }],
    ["T1-restricted", { broadcast: { restrictedAt: new Date() } }],
    ["channel suspended", { channel: { suspendedAt: new Date() } }],
    ["DVR off", { channel: { dvrEnabled: false } }],
    ["VOD removed", { vod: { removedReason: "owner" } }],
  ])("%s: 404 to the relay too", async (_name, over) => {
    const r = await recording(over);
    expect((await pull(r, "index.m3u8")).status).toBe(404);
    expect((await pull(r, "r1_000029.m4s")).status).toBe(404);
  });

  test("a removal closes it within the 5 s state cache, so the relay evicts", async () => {
    const r = await recording();
    expect((await pull(r, "index.m3u8")).status).toBe(200);
    await t.db.update(schema.vods).set({ removedReason: "owner" }).where(eq(schema.vods.id, r.vod));
    const changed = Date.now();
    let status = 200;
    while (status === 200 && Date.now() - changed < VOD_STATE_TTL_MS + 3_000) {
      status = (await pull(r, "index.m3u8")).status;
      if (status === 200) await Bun.sleep(250);
    }
    expect(status).toBe(404);
  });

  test("whole segments a relay pulls are counted for issuance; HEAD and viewer fetches are not", async () => {
    const r = await recording();
    const before = Date.now();
    expect((await pull(r, "r1_000029.m4s")).status).toBe(200);
    expect((await pull(r, "r1_init.mp4")).status).toBe(200);
    expect((await pull(r, "r1_000028.m4s", relayToken, { method: "HEAD" })).status).toBe(200);
    expect((await get(r, "r1_000027.m4s")).status).toBe(200);
    expect((await pull(r, "index.m3u8")).status).toBe(200);
    await origin.dvrPulls.flush();
    const pulled = await origin.dvrPulls.servable(r.vod, before, Date.now() + 1);
    expect(pulled.sort((a, b) => a.file.localeCompare(b.file))).toEqual([
      { file: "r1_000029.m4s", bytes: "segment-29".length, durationMs: 4000 },
      { file: "r1_init.mp4", bytes: "init".length, durationMs: 0 },
    ]);
    // Pulled long before the minute (more than the window back): no longer servable in it.
    const later = before + 7200_000 + 120_000;
    expect(await origin.dvrPulls.servable(r.vod, later, later + 60_000)).toEqual([]);
  });

  test("relay issuance: a DVR-only session with no live production verifies through the relay", async () => {
    const r = await recording();
    const session = (over: Partial<typeof schema.playbackSessions.$inferInsert>) => ({
      channelId: r.channel,
      broadcastId: r.broadcast,
      deviceHash: "d",
      ipHash: "i",
      assignedSource: "relay" as const,
      relayId,
      lastHeartbeatAt: new Date(),
      ...over,
    });
    // One session rewinding on the relay, one that never left live; nobody pulls live media.
    await t.db.insert(schema.playbackSessions).values([session({ playbackMode: "dvr" }), session({})]);
    for (const f of ["r1_init.mp4", "r1_000026.m4s", "r1_000027.m4s", "r1_000028.m4s", "r1_000029.m4s"])
      expect((await pull(r, f)).status).toBe(200);
    await origin.dvrPulls.flush();
    // Alive in the minute after the pulls, so a minute boundary between them cannot split the test.
    const heartbeat = Date.now();
    await t.db
      .update(schema.playbackSessions)
      .set({ lastHeartbeatAt: new Date(heartbeat) })
      .where(eq(schema.playbackSessions.broadcastId, r.broadcast));
    const bucket = Math.floor(heartbeat / 60_000) * 60_000;
    const rows = await origin.runIssuance(bucket);
    // Four 4 s segments of "segment-2x" (10 bytes) and the 4-byte init: all of them fit the span.
    expect(rows).toEqual([{ relayId, bucketStart: new Date(bucket), sessions: 2, segmentTokens: 5, bytesIssued: 44 }]);
    const [stored] = await t.db
      .select()
      .from(schema.relayIssuance)
      .where(eq(schema.relayIssuance.bucketStart, new Date(bucket)));
    expect(stored).toMatchObject({ relayId, sessions: 2, segmentTokens: 5, bytesIssued: 44 });
    // The same session before it rewound is issued nothing: live issuance alone has no production.
    await t.db
      .update(schema.playbackSessions)
      .set({ playbackMode: "live" })
      .where(eq(schema.playbackSessions.broadcastId, r.broadcast));
    expect(await origin.runIssuance(bucket)).toEqual([
      { relayId, bucketStart: new Date(bucket), sessions: 2, segmentTokens: 0, bytesIssued: 0 },
    ]);
    // Credited DVR seconds keep it counted as rewound after it returns to live.
    await t.db
      .update(schema.playbackSessions)
      .set({ dvrSeconds: 12 })
      .where(eq(schema.playbackSessions.broadcastId, r.broadcast));
    expect((await origin.runIssuance(bucket))[0]).toMatchObject({ sessions: 2, segmentTokens: 10, bytesIssued: 88 });
    await t.db.delete(schema.playbackSessions).where(eq(schema.playbackSessions.broadcastId, r.broadcast));
  });
});
