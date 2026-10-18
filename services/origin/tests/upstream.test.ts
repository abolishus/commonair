// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * MediaUpstream and ContentStore against a fake MediaMTX that mimics 1.21's HLS
 * session protocol (cookie-check redirect, session ids, 401 for unknown sessions).
 */
import { describe, expect, test } from "vite-plus/test";
import { ContentStore } from "../src/content.ts";
import { MediaUpstream, UpstreamError } from "../src/upstream.ts";

interface FakeOptions {
  /** Delay before answering a blocking playlist request. */
  blockMs?: number;
  live?: boolean;
}

function fakeMediaMtx(opts: FakeOptions = {}) {
  const sessions = new Set<string>();
  const log: string[] = [];
  let n = 0;
  const auth = `Basic ${Buffer.from("internal:secret").toString("base64")}`;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    log.push(url.pathname + url.search);
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== auth) return new Response("no", { status: 401 });
    if (opts.live === false) return Response.json({ error: "no stream" }, { status: 404 });
    if (url.pathname.endsWith("/index.m3u8")) {
      if (url.searchParams.get("cookieCheck") !== "1")
        return new Response(null, { status: 302, headers: { location: `${url.pathname}?cookieCheck=1` } });
      const id = `s${++n}`;
      sessions.add(id);
      return new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvideo1_stream.m3u8?session=${id}\n`, {
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      });
    }
    const session = url.searchParams.get("session") ?? "";
    if (!sessions.has(session)) return Response.json({ error: "session not found" }, { status: 401 });
    if (url.searchParams.has("_HLS_msn")) await Bun.sleep(opts.blockMs ?? 0);
    return new Response(`body:${url.pathname}`, { headers: { "content-type": "video/mp4" } });
  }) as typeof fetch;
  return { fetch: fetchFn, log, sessions };
}

const mk = (f: ReturnType<typeof fakeMediaMtx>, now?: () => number) =>
  new MediaUpstream({ baseUrl: "http://mtx:8888/", user: "internal", password: "secret", fetch: f.fetch, now });

describe("MediaUpstream", () => {
  test("follows the cookie-check redirect and adopts the session for later requests", async () => {
    const f = fakeMediaMtx();
    const up = mk(f);
    const mv = await up.get("live/alice", "index.m3u8");
    expect(mv.status).toBe(200);
    const seg = await up.get("live/alice", "x_seg1.mp4");
    expect(seg.status).toBe(200);
    expect(new TextDecoder().decode(seg.body)).toBe("body:/live/alice/x_seg1.mp4");
    expect(f.log).toEqual(["/live/alice/index.m3u8?cookieCheck=1", "/live/alice/x_seg1.mp4?session=s1"]);
  });

  test("obtains a session on demand, once, for concurrent first requests", async () => {
    const f = fakeMediaMtx();
    const up = mk(f);
    await Promise.all([up.get("live/a", "s1.mp4"), up.get("live/a", "s2.mp4"), up.get("live/a", "s3.mp4")]);
    expect(f.log.filter((l) => l.includes("index.m3u8"))).toHaveLength(1);
  });

  test("renews an expired session once and retries", async () => {
    const f = fakeMediaMtx();
    const up = mk(f);
    await up.get("live/a", "s1.mp4");
    f.sessions.clear(); // MediaMTX dropped every session
    const res = await up.get("live/a", "s2.mp4");
    expect(res.status).toBe(200);
    expect(f.log.slice(-3)).toEqual([
      "/live/a/s2.mp4?session=s1",
      "/live/a/index.m3u8?cookieCheck=1",
      "/live/a/s2.mp4?session=s2",
    ]);
  });

  test("renews proactively after the idle threshold", async () => {
    let now = 0;
    const f = fakeMediaMtx();
    const up = mk(f, () => now);
    await up.get("live/a", "s1.mp4");
    now = 25_000;
    await up.get("live/a", "s2.mp4");
    expect(f.log.at(-1)).toBe("/live/a/s2.mp4?session=s2");
  });

  test("passes LL-HLS directives after the session id", async () => {
    const f = fakeMediaMtx();
    const up = mk(f);
    await up.get("live/a", "video1_stream.m3u8", "_HLS_msn=5&_HLS_part=1", { blockingTimeoutMs: 1000 });
    expect(f.log.at(-1)).toBe("/live/a/video1_stream.m3u8?session=s1&_HLS_msn=5&_HLS_part=1");
  });

  test("offline paths surface MediaMTX's 404 without looping", async () => {
    const f = fakeMediaMtx({ live: false });
    const up = mk(f);
    expect((await up.get("live/a", "s1.mp4")).status).toBe(404);
    expect(f.log).toHaveLength(1);
  });

  test("network failures and cross-origin redirects become UpstreamError", async () => {
    const boom = new MediaUpstream({
      baseUrl: "http://mtx:8888",
      user: "u",
      password: "p",
      fetch: (() => Promise.reject(new TypeError("connection refused"))) as unknown as typeof fetch,
    });
    await expect(boom.get("live/a", "index.m3u8")).rejects.toBeInstanceOf(UpstreamError);
    const redirect = new MediaUpstream({
      baseUrl: "http://mtx:8888",
      user: "u",
      password: "p",
      fetch: (async () =>
        new Response(null, { status: 302, headers: { location: "http://evil/x" } })) as unknown as typeof fetch,
    });
    await expect(redirect.get("live/a", "index.m3u8")).rejects.toThrow("cross-origin redirect refused");
  });

  test("refuses objects above the size cap", async () => {
    const big = new MediaUpstream({
      baseUrl: "http://mtx:8888",
      user: "u",
      password: "p",
      maxBodyBytes: 10,
      fetch: (async () => new Response("x".repeat(11))) as unknown as typeof fetch,
    });
    await expect(big.get("live/a", "index.m3u8")).rejects.toThrow("too large");
  });
});

describe("ContentStore", () => {
  test("100 concurrent waiters on the same _HLS_msn cause one upstream request", async () => {
    const f = fakeMediaMtx({ blockMs: 30 });
    const up = mk(f);
    const store = new ContentStore({ upstream: up, cacheBytes: 1 << 20 });
    await up.get("live/a", "index.m3u8"); // establish a session
    const before = up.requests;
    const ref = { upstreamPath: "live/a", file: "video1_stream.m3u8", kind: "playlist" as const };
    const all = await Promise.all(Array.from({ length: 100 }, () => store.get(ref, { msn: 9, part: 0 })));
    expect(up.requests - before).toBe(1);
    expect(new Set(all)).toHaveProperty("size", 1);
    // A different directive is a different upstream request.
    await store.get(ref, { msn: 9, part: 1 });
    expect(up.requests - before).toBe(2);
  });

  test("segments are cached; fetched-hook fires once per object", async () => {
    const f = fakeMediaMtx();
    const fetched: string[] = [];
    const store = new ContentStore({
      upstream: mk(f),
      cacheBytes: 1 << 20,
      onFetched: (ref) => fetched.push(ref.file),
    });
    const ref = { upstreamPath: "live/a", file: "x_seg1.mp4", kind: "segment" as const };
    await Promise.all([store.get(ref), store.get(ref)]);
    await store.get(ref);
    expect(fetched).toEqual(["x_seg1.mp4"]);
    expect(f.log.filter((l) => l.includes("x_seg1"))).toHaveLength(1);
  });

  test("404s are negatively cached for the configured window", async () => {
    let now = 0;
    const f = fakeMediaMtx({ live: false });
    const store = new ContentStore({ upstream: mk(f, () => now), cacheBytes: 1 << 20, now: () => now });
    const ref = { upstreamPath: "live/a", file: "index.m3u8", kind: "playlist" as const };
    expect((await store.get(ref)).status).toBe(404);
    expect((await store.get(ref)).status).toBe(404);
    expect(f.log).toHaveLength(1);
    now = 2_000;
    await store.get(ref);
    expect(f.log).toHaveLength(2);
  });

  test("playlists expire quickly, media objects do not", async () => {
    let now = 0;
    const f = fakeMediaMtx();
    const store = new ContentStore({ upstream: mk(f, () => now), cacheBytes: 1 << 20, now: () => now });
    const pl = { upstreamPath: "live/a", file: "video1_stream.m3u8", kind: "playlist" as const };
    const seg = { upstreamPath: "live/a", file: "x_seg1.mp4", kind: "segment" as const };
    await store.get(pl);
    await store.get(seg);
    const n = f.log.length;
    now = 500;
    await store.get(pl);
    await store.get(seg);
    expect(f.log.length).toBe(n + 1);
  });
});
