// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The service worker's shell cache: what it intercepts, how caches are named and cleaned up. */
import { describe, expect, it } from "vite-plus/test";
import { CACHE_PREFIX, cacheName, shouldServeFromCache, staleCaches } from "../src/sw/cache.ts";

const ORIGIN = "https://air.example";
const PRECACHE = new Set(["/assets/index-abc.js", "/assets/styles-def.css", "/icons/icon-192.png"]);
const get = (url: string) => ({ method: "GET", url });

describe("shouldServeFromCache", () => {
  it.each(["/assets/index-abc.js", "/assets/styles-def.css", "/icons/icon-192.png"])(
    "serves the precached %s",
    (path) => {
      expect(shouldServeFromCache(get(`${ORIGIN}${path}`), ORIGIN, PRECACHE)).toBe(true);
    },
  );

  it.each([
    ["an /api URL", "/api/auth/get-session"],
    ["an /rpc call", "/rpc/me/get"],
    ["HLS", "/hls/abc/index.m3u8"],
    ["media", "/media/abc.png"],
    ["VOD", "/vod/abc/index.m3u8"],
    ["chat", "/chat"],
    ["an overlay", "/overlay/chat"],
    ["an embed", "/embed/somebody"],
    ["a document", "/"],
    ["a channel page", "/somebody"],
    ["the manifest", "/manifest.webmanifest"],
    ["the worker itself", "/sw.js"],
    ["a lazy chunk not in the list", "/assets/route-xyz.js"],
  ])("does not intercept %s", (_label, path) => {
    expect(shouldServeFromCache(get(`${ORIGIN}${path}`), ORIGIN, PRECACHE)).toBe(false);
  });

  it("does not intercept another origin with the same path", () => {
    expect(shouldServeFromCache(get("https://cdn.example/assets/index-abc.js"), ORIGIN, PRECACHE)).toBe(false);
    expect(shouldServeFromCache(get("http://air.example/assets/index-abc.js"), ORIGIN, PRECACHE)).toBe(false);
  });

  it.each(["POST", "PUT", "HEAD", "DELETE"])("does not intercept %s", (method) => {
    expect(shouldServeFromCache({ method, url: `${ORIGIN}/assets/index-abc.js` }, ORIGIN, PRECACHE)).toBe(false);
  });

  it("does not intercept an asset with a query string", () => {
    expect(shouldServeFromCache(get(`${ORIGIN}/assets/index-abc.js?v=2`), ORIGIN, PRECACHE)).toBe(false);
  });

  it("serves an asset whatever the fragment", () => {
    expect(shouldServeFromCache(get(`${ORIGIN}/assets/index-abc.js#x`), ORIGIN, PRECACHE)).toBe(true);
  });

  it("does not intercept a malformed URL or an empty list", () => {
    expect(shouldServeFromCache(get("not a url"), ORIGIN, PRECACHE)).toBe(false);
    expect(shouldServeFromCache(get(`${ORIGIN}/assets/index-abc.js`), ORIGIN, new Set())).toBe(false);
  });

  it("matches the decoded path the browser sends, not a traversal", () => {
    expect(shouldServeFromCache(get(`${ORIGIN}/icons/../assets/index-abc.js`), ORIGIN, PRECACHE)).toBe(true);
    expect(shouldServeFromCache(get(`${ORIGIN}/api/../icons/x.png`), ORIGIN, PRECACHE)).toBe(false);
  });
});

describe("cache names", () => {
  it("names the cache from the build version", () => {
    expect(cacheName("0123abcd")).toBe("commonair-shell-0123abcd");
    expect(cacheName("v").startsWith(CACHE_PREFIX)).toBe(true);
  });

  it("deletes only older shell caches, never the current one or someone else's", () => {
    const current = cacheName("new");
    expect(staleCaches([cacheName("old"), current, "other-cache", cacheName("older")], current)).toEqual([
      cacheName("old"),
      cacheName("older"),
    ]);
    expect(staleCaches([current], current)).toEqual([]);
    expect(staleCaches([], current)).toEqual([]);
  });
});
