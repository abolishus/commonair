// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The live captions route through `createOrigin` with real Postgres and Valkey (no MediaMTX: the
 * route reads only the cues media keeps in Valkey): token checks, 404s, headers, the subtitle
 * playlist and a segment's cues, relay pulls, and nothing in the segment log.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { CAPTIONS_KEYS, encodeCue, SEGMENT_MS, type LiveTrack } from "@commonair/captions";
import type { PlaybackClaims } from "@commonair/contracts/tokens";
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createValkey, type ValkeyClient } from "@commonair/service";
import { generateSigningKey, randomSecret, sha256Hex, signPlaybackToken, type SigningKey } from "@commonair/tokens";
import { liveSubtitleTracks } from "../src/captions.ts";
import { createOrigin, type Origin } from "../src/origin.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6379";
const prefix = `test:${crypto.randomUUID()}:`;
const stream = `stream:segments:${crypto.randomUUID()}`;
const relayToken = randomSecret("relay_");
let t: TestDatabase;
let valkey: ValkeyClient;
let key: SigningKey;
let origin: Origin;

const ids = {
  owner: uuidv7(),
  owner2: uuidv7(),
  channel: uuidv7(),
  broadcast: uuidv7(),
  other: uuidv7(),
  relayOwner: uuidv7(),
};
const W0 = Date.parse("2026-11-01T11:59:50.000Z");
const ANCHOR = Date.parse("2026-11-01T12:00:00.000Z");
const track: LiveTrack = { language: "en", w0Ms: W0, anchorMs: ANCHOR, throughMs: ANCHOR + 3 * SEGMENT_MS + 500 };

const claims = (over: Partial<PlaybackClaims> = {}): PlaybackClaims => {
  const now = Math.floor(Date.now() / 1000);
  return { v: 1, sid: uuidv7(), cid: ids.channel, path: "live/capt", src: "origin", iat: now, exp: now + 120, ...over };
};
const token = (over: Partial<PlaybackClaims> = {}) => signPlaybackToken(key, claims(over));
const get = (path: string, init?: RequestInit) => origin.fetch(new Request(`http://origin.test${path}`, init));

beforeAll(async () => {
  t = await createTestDatabase();
  valkey = createValkey(VALKEY_URL, { keyPrefix: prefix });
  const generated = await generateSigningKey();
  key = generated.key;
  const user = (id: string, username: string) => ({ id, name: username, email: `${username}@test.invalid`, username });
  await t.db
    .insert(schema.users)
    .values([user(ids.owner, "capt"), user(ids.owner2, "capt_off"), user(ids.relayOwner, "capt_relay")]);
  await t.db.insert(schema.channels).values([
    { id: ids.channel, ownerId: ids.owner, slug: "capt", displayName: "Capt" },
    { id: ids.other, ownerId: ids.owner2, slug: "capt_off", displayName: "Off" },
  ]);
  await t.db
    .insert(schema.broadcasts)
    .values({ id: ids.broadcast, channelId: ids.channel, ingestProtocol: "rtmp", path: "live/capt" });
  await t.db.update(schema.channels).set({ liveBroadcastId: ids.broadcast }).where(eq(schema.channels.id, ids.channel));
  await t.db.insert(schema.relayNodes).values({
    ownerId: ids.relayOwner,
    name: "r1",
    publicUrl: "https://relay.test.invalid",
    declaredCapacityMbps: 100,
    publicKey: "A".repeat(43),
    tokenHash: await sha256Hex(relayToken),
    status: "active",
  });
  origin = await createOrigin({
    db: t.db,
    valkey,
    playbackSigningKey: generated.pkcs8B64,
    mediamtxHlsUrl: "http://127.0.0.1:9",
    internalSecret: randomSecret("", 32),
    mediaPassword: randomSecret("", 32),
    cacheMb: 8,
    cdn: { provider: "none" },
    segmentStream: stream,
    segmentFlushMs: 20,
  });
  origin.start();
});

afterAll(async () => {
  await origin?.stop();
  const raw = createValkey(VALKEY_URL);
  const keys = [...(await raw.keys(`${prefix}*`)), stream];
  await raw.del(...keys);
  await raw.quit();
  await valkey?.quit();
  await t?.drop();
});

describe("captions route", () => {
  test("404 while no track is active; the multivariant helper advertises nothing", async () => {
    const res = await get(`/hls/live/capt/captions/en/index.m3u8?t=${await token()}`);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await liveSubtitleTracks(valkey)(ids.broadcast)).toEqual([]);
  });

  test("with a track: the playlist, a segment, headers", async () => {
    await valkey.set(CAPTIONS_KEYS.live(ids.broadcast), JSON.stringify(track));
    await valkey.zadd(
      CAPTIONS_KEYS.cues(ids.broadcast, "en"),
      String(ANCHOR + 500),
      encodeCue(0, { startMs: ANCHOR + 500, endMs: ANCHOR + 2000, text: "hello <there> [***]" }),
      String(ANCHOR + 3500),
      encodeCue(1, { startMs: ANCHOR + 3500, endMs: ANCHOR + 4000, text: "second" }),
    );
    expect(await liveSubtitleTracks(valkey)(ids.broadcast)).toEqual([{ language: "en" }]);
    const tok = await token();
    const pl = await get(`/hls/live/capt/captions/en/index.m3u8?t=${tok}`);
    expect(pl.status).toBe(200);
    expect(pl.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
    expect(pl.headers.get("cache-control")).toBe("private, max-age=1");
    expect(pl.headers.get("access-control-allow-origin")).toBe("*");
    const body = await pl.text();
    expect(body).toContain("#EXT-X-PROGRAM-DATE-TIME:2026-11-01T12:00:00.000Z");
    expect(body).toContain(`0.vtt?t=${encodeURIComponent(tok)}`);
    expect(body).toContain("2.vtt");
    expect(body).not.toContain("3.vtt"); // not transcribed to its end yet

    const seg = await get(`/hls/live/capt/captions/en/0.vtt?t=${tok}`);
    expect(seg.status).toBe(200);
    expect(seg.headers.get("content-type")).toBe("text/vtt; charset=utf-8");
    expect(seg.headers.get("cache-control")).toBe("private, max-age=30");
    expect(await seg.text()).toBe(
      "WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n00:00:10.500 --> 00:00:12.000\nhello &lt;there&gt; [***]\n\n",
    );
    const seg1 = await (await get(`/hls/live/capt/captions/en/1.vtt?t=${tok}`)).text();
    expect(seg1).toContain("second");
    expect(seg1).not.toContain("hello");
    // HEAD: headers, no body.
    const head = await get(`/hls/live/capt/captions/en/0.vtt?t=${tok}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("segments that are not complete yet, and other languages, are 404", async () => {
    const tok = await token();
    expect((await get(`/hls/live/capt/captions/en/3.vtt?t=${tok}`)).status).toBe(404);
    expect((await get(`/hls/live/capt/captions/en/seg.vtt?t=${tok}`)).status).toBe(404);
    expect((await get(`/hls/live/capt/captions/es/index.m3u8?t=${tok}`)).status).toBe(404);
  });

  test("token checks: missing, other path, other channel, rehearsal invitee", async () => {
    expect((await get("/hls/live/capt/captions/en/index.m3u8")).status).toBe(403);
    expect((await get(`/hls/live/capt/captions/en/index.m3u8?t=${await token({ path: "live/zzz" })}`)).status).toBe(
      403,
    );
    expect((await get(`/hls/live/capt/captions/en/index.m3u8?t=${await token({ cid: ids.other })}`)).status).toBe(403);
    expect((await get(`/hls/live/capt/captions/en/index.m3u8?t=${await token({ rb: ids.broadcast })}`)).status).toBe(
      404,
    );
    // Offline channel.
    const off = await token({ path: "live/capt_off", cid: ids.other });
    expect((await get(`/hls/live/capt_off/captions/en/index.m3u8?t=${off}`)).status).toBe(404);
  });

  test("relay pulls take a relay token and get public, tokenless playlists; CDN pulls are not served", async () => {
    expect((await get("/relay-pull/live/capt/captions/en/index.m3u8")).status).toBe(401);
    const res = await get("/relay-pull/live/capt/captions/en/index.m3u8", {
      headers: { authorization: `Bearer ${relayToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=1");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const body = await res.text();
    expect(body).toContain("\n0.vtt\n");
    expect((await get("/cdn/live/capt/captions/en/index.m3u8")).status).toBe(404);
  });

  test("method and preflight", async () => {
    expect((await get(`/hls/live/capt/captions/en/index.m3u8`, { method: "OPTIONS" })).status).toBe(204);
    const post = await get(`/hls/live/capt/captions/en/index.m3u8?t=${await token()}`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });

  test("captions are not media: nothing reaches the segment log", async () => {
    await get(`/hls/live/capt/captions/en/0.vtt?t=${await token()}`);
    await Bun.sleep(100);
    const raw = createValkey(VALKEY_URL);
    expect(await raw.exists(stream)).toBe(0);
    await raw.quit();
  });
});
