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
import { generateSigningKey, signPlaybackToken, type SigningKey } from "@commonair/tokens";
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
