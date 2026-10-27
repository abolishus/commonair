// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/p2p-digest/` through `createOrigin` with real Postgres and Valkey, against a local stand-in
 * for MediaMTX that serves the `tests/fixtures.ts` playlists and fixed segment bytes (no podman).
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { PlaybackClaims } from "@commonair/contracts/tokens";
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createValkey, type ValkeyClient } from "@commonair/service";
import { generateSigningKey, randomSecret, signPlaybackToken, type SigningKey } from "@commonair/tokens";
import { noopMetrics, type OriginMetrics } from "../src/metrics.ts";
import { createOrigin, type Origin } from "../src/origin.ts";
import { MEDIA, MULTIVARIANT, rendition720 } from "./fixtures.ts";

const VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6379";
const SEG33 = "54dd20fd99ec_video1_seg33.mp4";
const SEG34 = "54dd20fd99ec_video1_seg34.mp4";
const bytes = (seed: number, n = 8192) => new Uint8Array(Array.from({ length: n }, (_, i) => (i * seed + 11) % 256));
const UPSTREAM: Record<string, Uint8Array> = {
  [`/live/test/${SEG33}`]: bytes(3),
  [`/live/test/${SEG34}`]: bytes(5),
  [`/live/test/720p/${SEG33}`]: bytes(7, 2048),
};

const secret = randomSecret("", 32);
const stream = `stream:segments:${crypto.randomUUID()}`;
const ids = { owner: uuidv7(), channel: uuidv7(), broadcast: uuidv7(), session: uuidv7(), relay: uuidv7() };
let t: TestDatabase;
let valkey: ValkeyClient;
let key: SigningKey;
let origin: Origin;
let mediamtx: ReturnType<typeof Bun.serve>;
/** Segment requests that reached the MediaMTX stand-in, by path. */
const segmentHits: string[] = [];
const requests: [string, string, string, number][] = [];

const token = (over: Partial<PlaybackClaims> = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return signPlaybackToken(key, {
    v: 1,
    sid: ids.session,
    cid: ids.channel,
    path: "live/test",
    src: "origin",
    iat: now,
    exp: now + 120,
    ...over,
  } as PlaybackClaims);
};
const get = (path: string, init?: RequestInit) => origin.fetch(new Request(`http://origin${path}`, init));
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const flushed = async () => {
  // SegmentLog flushes every 50 ms; give it a few rounds.
  await Bun.sleep(300);
  return valkey.xlen(stream);
};

beforeAll(async () => {
  mediamtx = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/live/test/index.m3u8") return new Response(MULTIVARIANT);
      if (path === "/live/test/720p/index.m3u8") return new Response(rendition720);
      if (path.endsWith("/video1_stream.m3u8")) return new Response(MEDIA);
      const body = UPSTREAM[path];
      if (body) {
        segmentHits.push(path);
        return new Response(new Uint8Array(body), { headers: { "content-type": "video/mp4" } });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const [db, generated] = await Promise.all([createTestDatabase(), generateSigningKey()]);
  t = db;
  key = generated.key;
  valkey = createValkey(VALKEY_URL, { keyPrefix: `test:${crypto.randomUUID()}:` });
  await t.db.insert(schema.users).values({ id: ids.owner, name: "test", email: "test@test.invalid", username: "test" });
  await t.db.insert(schema.channels).values({ id: ids.channel, ownerId: ids.owner, slug: "test", displayName: "Test" });
  await t.db
    .insert(schema.broadcasts)
    .values({ id: ids.broadcast, channelId: ids.channel, ingestProtocol: "rtsp", path: "live/test" });
  await t.db.update(schema.channels).set({ liveBroadcastId: ids.broadcast }).where(eq(schema.channels.id, ids.channel));

  const metrics: OriginMetrics = {
    ...noopMetrics,
    request: (route, kind, source, status) => void requests.push([route, kind, source, status]),
  };
  origin = await createOrigin({
    db: t.db,
    valkey,
    playbackSigningKey: generated.pkcs8B64,
    mediamtxHlsUrl: `http://127.0.0.1:${mediamtx.port}`,
    internalSecret: secret,
    mediaPassword: secret,
    cacheMb: 16,
    cdn: { provider: "none" },
    segmentStream: stream,
    segmentFlushMs: 50,
    metrics,
  });
  origin.start();
});

afterAll(async () => {
  await origin?.stop();
  await mediamtx?.stop(true);
  await valkey?.del(stream);
  await valkey?.quit();
  await t?.drop();
});

describe("/p2p-digest/ through the origin", () => {
  test("the digest is the SHA-256 of exactly what /hls/ serves, with the same token", async () => {
    const tk = await token();
    const hls = await get(`/hls/live/test/${SEG33}?t=${tk}`);
    expect(hls.status).toBe(200);
    const served = new Uint8Array(await hls.arrayBuffer());
    expect(served).toEqual(UPSTREAM[`/live/test/${SEG33}`]);

    const before = origin.upstream.requests;
    const d = await get(`/p2p-digest/live/test/${SEG33}?t=${tk}`);
    expect(d.status).toBe(200);
    expect(d.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(d.headers.get("cache-control")).toBe("private, max-age=120");
    expect(await d.text()).toBe(sha256(served));
    // Served from the shared cache: no upstream request at all.
    expect(origin.upstream.requests).toBe(before);
    expect(segmentHits.filter((p) => p.endsWith(SEG33) && !p.includes("720p"))).toHaveLength(1);
  });

  test("a digest first: one upstream fetch, shared by a second digest and by /hls/", async () => {
    const tk = await token();
    const first = await get(`/p2p-digest/live/test/${SEG34}?t=${tk}`);
    expect(first.status).toBe(200);
    const digest = await first.text();
    expect(segmentHits.filter((p) => p.endsWith(SEG34))).toHaveLength(1);
    const before = origin.upstream.requests;

    const second = await get(`/p2p-digest/live/test/${SEG34}?t=${await token({ sid: uuidv7() })}`);
    expect(await second.text()).toBe(digest);
    const hls = await get(`/hls/live/test/${SEG34}?t=${tk}`);
    expect(sha256(new Uint8Array(await hls.arrayBuffer()))).toBe(digest);
    expect(origin.upstream.requests).toBe(before);
    expect(segmentHits.filter((p) => p.endsWith(SEG34))).toHaveLength(1);
  });

  test("a rendition segment, and relay- and CDN-served tokens", async () => {
    const relay = await token({ src: "relay", rid: ids.relay });
    const r = await get(`/p2p-digest/live/test/720p/${SEG33}?t=${relay}`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(sha256(UPSTREAM[`/live/test/720p/${SEG33}`] ?? new Uint8Array()));
    const cdn = await get(`/p2p-digest/live/test/720p/${SEG33}?t=${await token({ src: "cdn" })}`);
    expect(cdn.status).toBe(200);
    // /hls/ refuses the relay token (relay viewers pull from their relay), the digest does not.
    expect((await get(`/hls/live/test/720p/${SEG33}?t=${relay}`)).status).toBe(403);
  });

  test("playlists, parts and missing segments: 404; bad tokens: 403; HEAD: no body", async () => {
    const tk = await token();
    const before = origin.upstream.requests;
    for (const f of ["index.m3u8", "video1_stream.m3u8", "54dd20fd99ec_video1_part155.mp4"])
      expect((await get(`/p2p-digest/live/test/${f}?t=${tk}`)).status).toBe(404);
    expect(origin.upstream.requests).toBe(before);
    expect((await get(`/p2p-digest/live/test/54dd20fd99ec_video1_seg99.mp4?t=${tk}`)).status).toBe(404);
    expect((await get(`/p2p-digest/live/test/${SEG33}`)).status).toBe(403);
    expect((await get(`/p2p-digest/live/test/${SEG33}?t=${await token({ path: "live/other" })}`)).status).toBe(403);
    const head = await get(`/p2p-digest/live/test/${SEG33}?t=${tk}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("digest requests add nothing to the segments stream and are counted as p2p_digest", async () => {
    const n = await flushed();
    const tk = await token();
    for (let i = 0; i < 3; i++) expect((await get(`/p2p-digest/live/test/${SEG33}?t=${tk}`)).status).toBe(200);
    expect(await flushed()).toBe(n);
    // The /hls/ segment fetches above (seg33, seg34) were recorded.
    const entries = await valkey.xrange(stream, "-", "+");
    expect(entries.length).toBe(n);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(requests.filter((r) => r[0] === "p2p_digest" && r[3] === 200).length).toBeGreaterThanOrEqual(3);
    expect(requests).toContainEqual(["p2p_digest", "segment", "origin", 200]);
    expect(requests).toContainEqual(["p2p_digest", "segment", "relay", 200]);
  });
});
