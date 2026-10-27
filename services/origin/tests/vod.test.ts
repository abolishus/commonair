// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ADR 0009 amendment 1 at the origin (docs/testing/w0-selectors.md "VOD states"): the state check
 * on `/media/vods/…` for every row of the state table, the token-checked `/vod/` route, and the
 * 5 s per-VOD state cache.
 */
import { describe, expect, test } from "vite-plus/test";
import { vodTokenPath, type VodPlacementState } from "@commonair/contracts/storage";
import type { PlaybackClaims } from "@commonair/contracts/tokens";
import { S3Error, type GetOptions } from "@commonair/storage";
import { generateSigningKey, signPlaybackToken } from "@commonair/tokens";
import { authorizeViewer } from "../src/auth.ts";
import { createMediaHandler } from "../src/media.ts";
import { parseMediaPath, type MediaRequest } from "../src/paths.ts";
import { createVodHandler, parseVodPath, VodStateCache, type VodState } from "../src/vod.ts";

const VOD = "0192f3a4-5b6c-7d8e-9f01-00000000aa01";
const OTHER_VOD = "0192f3a4-5b6c-7d8e-9f01-00000000aa02";
const CHANNEL = "0192f3a4-5b6c-7d8e-9f01-00000000cc01";
const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;

const PLAYLIST = [
  "#EXTM3U",
  "#EXT-X-VERSION:7",
  "#EXT-X-TARGETDURATION:4",
  "#EXT-X-PLAYLIST-TYPE:EVENT",
  '#EXT-X-MAP:URI="init_r1.mp4"',
  "#EXTINF:4.000000,",
  "#EXT-X-PROGRAM-DATE-TIME:2026-10-27T12:00:00.000Z",
  "r1_000000.m4s",
  "#EXTINF:4.000000,",
  "r1_000001.m4s",
  "#EXT-X-ENDLIST",
  "",
].join("\n");

const READY_PUBLIC: VodPlacementState = {
  status: "ready",
  visibility: "public",
  removedReason: null,
  broadcastRestricted: false,
  channelSuspended: false,
  nciiHidden: false,
  dmcaHidden: false,
};

/** The selectors' VOD state table: state, where the objects are, `/media` and `/vod` answers. */
const TABLE: [string, Partial<VodPlacementState>, "vods" | "recordings", 200 | 404, 200 | 404][] = [
  ["recording", { status: "recording" }, "recordings", 404, 404],
  ["processing", { status: "processing" }, "recordings", 404, 404],
  ["ready, public", {}, "vods", 200, 200],
  ["ready, subscribers", { visibility: "subscribers" }, "recordings", 404, 200],
  ["ready, private", { visibility: "private" }, "recordings", 404, 200],
  ["owner-removed", { removedReason: "owner" }, "recordings", 404, 404],
  ["broadcast T1-restricted", { broadcastRestricted: true }, "recordings", 404, 404],
  ["channel suspended", { channelSuspended: true }, "recordings", 404, 404],
  ["NCII hidden", { status: "deleted", removedReason: "ncii", nciiHidden: true }, "vods", 404, 404],
  ["DMCA hidden", { removedReason: "dmca", dmcaHidden: true }, "vods", 404, 404],
  ["deleted", { status: "deleted", removedReason: "retention" }, "vods", 404, 404],
];

function fakeStorage(objects: Record<string, string>) {
  const calls: { key: string; opts?: GetOptions }[] = [];
  return {
    calls,
    objects,
    async get(_bucket: string, key: string, opts?: GetOptions): Promise<Response | null> {
      calls.push({ key, opts });
      if (key.endsWith("broken.m4s")) throw new S3Error(500, "InternalError", "get");
      const body = objects[key];
      if (body === undefined) return null;
      const type = key.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4";
      if (opts?.range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(opts.range);
        if (!m) throw new S3Error(416, "InvalidRange", "get");
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : body.length - 1;
        return new Response(body.slice(start, end + 1), {
          status: 206,
          headers: { "content-type": type, "content-range": `bytes ${start}-${end}/${body.length}`, etag: '"e"' },
        });
      }
      return new Response(body, {
        headers: { "content-type": type, etag: '"e"', "content-length": String(body.length) },
      });
    },
  };
}

function objectsAt(prefix: string, id = VOD): Record<string, string> {
  const p = `${prefix}/${id}/`;
  return {
    [`${p}index.m3u8`]: PLAYLIST,
    [`${p}init_r1.mp4`]: "init",
    [`${p}r1_000000.m4s`]: "0123456789",
    [`${p}thumbnail.webp`]: "thumb",
  };
}

const { key } = await generateSigningKey();
const { key: otherKey } = await generateSigningKey();
const claims = (over: Partial<PlaybackClaims> = {}): PlaybackClaims => ({
  v: 1,
  sid: "0192f3a4-5b6c-7d8e-9f01-00000000dd01",
  cid: CHANNEL,
  path: vodTokenPath(VOD),
  src: "origin",
  iat: NOW - 10,
  exp: NOW + 3600,
  ...over,
});
const token = (over: Partial<PlaybackClaims> = {}, k = key) => signPlaybackToken(k, claims(over));

function setup(state: Partial<VodPlacementState> | null, at: "vods" | "recordings", objects = objectsAt(at)) {
  let current: VodState | null =
    state === null
      ? null
      : { channelId: CHANNEL, storagePrefix: `${at}/${VOD}/`, state: { ...READY_PUBLIC, ...state } };
  let lookups = 0;
  let fail = false;
  let clock = NOW_MS;
  const states = new VodStateCache(
    async () => {
      lookups++;
      if (fail) throw new Error("db down");
      return current;
    },
    { now: () => clock },
  );
  const storage = fakeStorage(objects);
  const media = createMediaHandler({ storage, bucket: "media", vodStates: states });
  const vod = createVodHandler({ storage, bucket: "media", publicKey: key.publicKey, states, now: () => clock });
  return {
    storage,
    media: (path: string, init?: RequestInit) =>
      media(new Request(`http://origin.test${path}`, init), path.split("?")[0]!),
    vod: (path: string, init?: RequestInit) => vod(new Request(`http://origin.test${path}`, init), path.split("?")[0]!),
    set: (s: VodState | null) => (current = s),
    state: () => current,
    lookups: () => lookups,
    failLookups: (f: boolean) => (fail = f),
    advance: (ms: number) => (clock += ms),
  };
}

describe("/media/vods/ state check", () => {
  test.each(TABLE)("%s: /media answers %i", async (_name, state, at, mediaStatus) => {
    const o = setup(state, at);
    // Objects exist wherever the row says they are, and under vods/ too for the matrix's sake.
    Object.assign(o.storage.objects, objectsAt("vods"));
    for (const file of ["index.m3u8", "r1_000000.m4s", "thumbnail.webp"]) {
      const res = await o.media(`/media/vods/${VOD}/${file}`);
      expect(res.status, file).toBe(mediaStatus);
      // A refusal is the same no-store 404 as a missing object.
      expect(res.headers.get("cache-control")).toBe(mediaStatus === 404 ? "no-store" : "public, max-age=300");
    }
    // A refused VOD never reaches storage.
    expect(o.storage.calls.length === 0).toBe(mediaStatus === 404);
  });

  test("an unknown VOD, a malformed id and a failed lookup are the same 404, storage untouched", async () => {
    const o = setup(null, "vods");
    expect((await o.media(`/media/vods/${VOD}/index.m3u8`)).status).toBe(404);
    expect((await o.media(`/media/vods/not-a-uuid/index.m3u8`)).status).toBe(404);
    const f = setup({}, "vods");
    f.failLookups(true);
    expect((await f.media(`/media/vods/${VOD}/index.m3u8`)).status).toBe(404);
    expect(o.storage.calls).toEqual([]);
    expect(f.storage.calls).toEqual([]);
    // Failures are not cached: the next request after recovery is served.
    f.failLookups(false);
    expect((await f.media(`/media/vods/${VOD}/index.m3u8`)).status).toBe(200);
  });

  test("without a state cache every vods/ key is refused; other prefixes are unaffected", async () => {
    const storage = fakeStorage({ ...objectsAt("vods"), "clips/c.mp4": "c" });
    const handle = createMediaHandler({ storage, bucket: "media" });
    expect((await handle(new Request("http://o/x"), `/media/vods/${VOD}/index.m3u8`)).status).toBe(404);
    expect((await handle(new Request("http://o/x"), "/media/clips/c.mp4")).status).toBe(200);
  });

  test("recordings/ is never served by /media, whatever the state", async () => {
    const o = setup({ visibility: "subscribers" }, "recordings");
    expect((await o.media(`/media/recordings/${VOD}/index.m3u8`)).status).toBe(404);
    expect(o.storage.calls).toEqual([]);
  });

  test("the state is cached per VOD for 5 s: a change shows after the TTL, not before", async () => {
    const o = setup({}, "vods");
    expect((await o.media(`/media/vods/${VOD}/index.m3u8`)).status).toBe(200);
    o.set({ ...o.state()!, state: { ...o.state()!.state, removedReason: "owner" } });
    o.advance(4_999);
    expect((await o.media(`/media/vods/${VOD}/index.m3u8`)).status).toBe(200);
    expect(o.lookups()).toBe(1);
    o.advance(1);
    expect((await o.media(`/media/vods/${VOD}/index.m3u8`)).status).toBe(404);
    expect(o.lookups()).toBe(2);
    // Negative results are cached too.
    o.set(null);
    await o.media(`/media/vods/${VOD}/index.m3u8`);
    expect(o.lookups()).toBe(2);
  });
});

describe("/vod/ route", () => {
  test.each(TABLE)("%s: /vod answers %i to a valid token", async (_name, state, at, _media, vodStatus) => {
    const o = setup(state, at);
    const t = await token();
    const res = await o.vod(`/vod/${VOD}/index.m3u8?t=${t}`);
    expect(res.status).toBe(vodStatus);
    expect(res.headers.get("cache-control")).toBe(vodStatus === 404 ? "no-store" : "private, no-store");
  });

  test("the playlist is rewritten so every URI (segments and #EXT-X-MAP) carries the token", async () => {
    const o = setup({ visibility: "subscribers" }, "recordings");
    const t = await token();
    const res = await o.vod(`/vod/${VOD}/index.m3u8?t=${t}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await res.text();
    expect(Number(res.headers.get("content-length"))).toBe(new TextEncoder().encode(body).byteLength);
    const q = new URLSearchParams({ t }).toString();
    expect(body).toContain(`#EXT-X-MAP:URI="init_r1.mp4?${q}"`);
    expect(body).toContain(`\nr1_000000.m4s?${q}\n`);
    expect(body).toContain(`\nr1_000001.m4s?${q}\n`);
    expect(body).toContain("#EXT-X-PROGRAM-DATE-TIME:2026-10-27T12:00:00.000Z");
    expect(o.storage.calls[0]).toEqual({ key: `recordings/${VOD}/index.m3u8`, opts: undefined });
  });

  test("segments: private cache, single Range passthrough, HEAD without a body", async () => {
    const o = setup({ visibility: "private" }, "recordings");
    const t = await token();
    const seg = await o.vod(`/vod/${VOD}/r1_000000.m4s?t=${t}`);
    expect(seg.status).toBe(200);
    expect(seg.headers.get("cache-control")).toBe("private, max-age=300");
    expect(await seg.text()).toBe("0123456789");
    const ranged = await o.vod(`/vod/${VOD}/r1_000000.m4s?t=${t}`, { headers: { range: "bytes=2-4" } });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe("234");
    expect(ranged.headers.get("content-range")).toBe("bytes 2-4/10");
    const multi = await o.vod(`/vod/${VOD}/r1_000000.m4s?t=${t}`, { headers: { range: "bytes=0-1,4-5" } });
    expect(multi.status).toBe(416);
    const head = await o.vod(`/vod/${VOD}/r1_000000.m4s?t=${t}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const headList = await o.vod(`/vod/${VOD}/index.m3u8?t=${t}`, { method: "HEAD" });
    expect(headList.status).toBe(200);
    expect(await headList.text()).toBe("");
    const thumb = await o.vod(`/vod/${VOD}/thumbnail.webp?t=${t}`);
    expect(await thumb.text()).toBe("thumb");
    expect((await o.vod(`/vod/${VOD}/missing.m4s?t=${t}`)).status).toBe(404);
    expect((await o.vod(`/vod/${VOD}/broken.m4s?t=${t}`)).status).toBe(502);
    expect((await o.vod(`/vod/${VOD}/r1_000000.m4s?t=${t}`, { method: "POST" })).status).toBe(405);
    expect((await o.vod(`/vod/${VOD}/r1_000000.m4s`, { method: "OPTIONS" })).status).toBe(204);
  });

  test("mid-move: a file missing under the row's prefix is read from the other own prefix", async () => {
    // The row still says recordings/, the move already deleted it (cached state up to 5 s old).
    const o = setup({ visibility: "subscribers" }, "recordings", objectsAt("vods"));
    const t = await token();
    const res = await o.vod(`/vod/${VOD}/r1_000000.m4s?t=${t}`);
    expect(res.status).toBe(200);
    expect(o.storage.calls.map((c) => c.key)).toEqual([`recordings/${VOD}/r1_000000.m4s`, `vods/${VOD}/r1_000000.m4s`]);
  });

  test.each([
    ["missing", async () => ""],
    ["malformed", async () => "not-a-token"],
    ["too long", async () => "a".repeat(5000)],
    ["expired", () => token({ iat: NOW - 7200, exp: NOW - 3600 })],
    ["another key", () => token({}, otherKey)],
    ["another VOD's", () => token({ path: vodTokenPath(OTHER_VOD) })],
    ["a live token", () => token({ path: "live/alice" })],
    ["a relay-source token", () => token({ src: "relay", rid: "0192f3a4-5b6c-7d8e-9f01-00000000ee01" })],
    ["another channel's", () => token({ cid: "0192f3a4-5b6c-7d8e-9f01-00000000cc02" })],
  ])("%s token: 401 without detail", async (_name, make) => {
    const o = setup({ visibility: "subscribers" }, "recordings");
    const t = await make();
    const res = await o.vod(`/vod/${VOD}/index.m3u8${t ? `?t=${encodeURIComponent(t)}` : ""}`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    // Only the channel check needs the state; storage is never read.
    expect(o.storage.calls).toEqual([]);
  });

  test("a token minted before removal is refused within 5 s", async () => {
    const o = setup({ visibility: "subscribers" }, "recordings");
    const t = await token();
    expect((await o.vod(`/vod/${VOD}/index.m3u8?t=${t}`)).status).toBe(200);
    o.set({ ...o.state()!, state: { ...o.state()!.state, removedReason: "owner" } });
    o.advance(5_000);
    expect((await o.vod(`/vod/${VOD}/index.m3u8?t=${t}`)).status).toBe(404);
  });

  test("a failed state lookup is a 404", async () => {
    const o = setup({ visibility: "subscribers" }, "recordings");
    o.failLookups(true);
    expect((await o.vod(`/vod/${VOD}/index.m3u8?t=${await token()}`)).status).toBe(404);
    expect(o.storage.calls).toEqual([]);
  });

  test("traversal, encoded slashes, control characters and other shapes are refused", async () => {
    for (const bad of [
      `/vod/${VOD}`,
      `/vod/${VOD}/`,
      `/vod/${VOD}/../vods/x`,
      `/vod/${VOD}/%2e%2e`,
      `/vod/${VOD}/a%2fb.m4s`,
      `/vod/${VOD}/a%5cb.m4s`,
      `/vod/${VOD}/a%00.m4s`,
      `/vod/${VOD}/sub/a.m4s`,
      `/vod/${VOD}/%E0%A4%A.m4s`,
      `/vod/not-a-uuid/index.m3u8`,
      `/vod/${VOD.toUpperCase()}/index.m3u8`,
      `/vod//index.m3u8`,
      `/vod/${VOD}/${"a".repeat(300)}`,
    ])
      expect(parseVodPath(bad), bad).toBeNull();
    expect(parseVodPath(`/vod/${VOD}/r1_000000.m4s`)).toEqual({ vodId: VOD, file: "r1_000000.m4s" });
    const o = setup({ visibility: "subscribers" }, "recordings");
    const res = await o.vod(`/vod/${VOD}/%2e%2e?t=${await token()}`);
    expect(res.status).toBe(404);
    expect(o.storage.calls).toEqual([]);
  });

  test("a VOD token never authorizes /hls (path mismatch)", async () => {
    const t = await token();
    const mr = parseMediaPath("/hls/live/alice/index.m3u8") as MediaRequest;
    expect(await authorizeViewer(key.publicKey, t, mr, NOW)).toEqual({ ok: false, reason: "wrong_path" });
  });
});
