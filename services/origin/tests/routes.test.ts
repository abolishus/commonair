// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import type { Executor } from "@commonair/db";
import type { ValkeyClient } from "@commonair/service";
import { generateSigningKey } from "@commonair/tokens";
import { createOrigin } from "../src/origin.ts";
import {
  CAPTIONS_DIR,
  parseCaptionsPath,
  parseDvrPath,
  parseMediaPath,
  requestKindOf,
  SUBTITLE_PLAYLIST,
} from "../src/paths.ts";
import { OriginRouteRegistry, routeNotFound } from "../src/routes.ts";

const VOD = "0192f3a4-5b6c-7d8e-9f01-0000000000aa";
const ok = () => Promise.resolve(new Response("ok"));

describe("OriginRouteRegistry", () => {
  test("first matching prefix wins; match narrows a shared prefix", () => {
    const r = new OriginRouteRegistry();
    r.register({ name: "narrow", prefix: "/hls/", match: (p) => p.includes("/captions/"), handle: ok });
    r.register({ name: "dvr", prefix: "/dvr/", handle: ok });
    expect(r.find("/hls/live/alice/captions/en/index.m3u8")?.name).toBe("narrow");
    expect(r.find("/hls/live/alice/index.m3u8")).toBeUndefined();
    expect(r.find(`/dvr/${VOD}/index.m3u8`)?.name).toBe("dvr");
    expect(r.find("/dvrx/")).toBeUndefined();
    expect(r.names).toEqual(["narrow", "dvr"]);
  });

  test("refuses a duplicate name and a relative prefix", () => {
    const r = new OriginRouteRegistry();
    r.register({ name: "a", prefix: "/a/", handle: ok });
    expect(() => r.register({ name: "a", prefix: "/b/", handle: ok })).toThrow(/already registered/);
    expect(() => r.register({ name: "c", prefix: "c/", handle: ok })).toThrow(/must start/);
  });

  test("routeNotFound is an uncached CORS 404", async () => {
    const res = routeNotFound();
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("captions and DVR request kinds", () => {
  test("captions playlist and segments on every pull route", () => {
    expect(parseCaptionsPath(`/hls/live/alice_01/${CAPTIONS_DIR}/en/${SUBTITLE_PLAYLIST}`)).toEqual({
      route: "hls",
      slug: "alice_01",
      language: "en",
      file: "index.m3u8",
      kind: "subtitles",
      channelPath: "live/alice_01",
    });
    expect(parseCaptionsPath("/relay-pull/live/alice/captions/pt-BR/seg_000012.vtt")).toMatchObject({
      route: "relayPull",
      kind: "vtt",
      language: "pt-BR",
    });
    expect(parseCaptionsPath("/cdn/live/alice/captions/es/a.vtt")?.route).toBe("cdn");
    // MediaMTX's grammar never accepts a captions path, and vice versa.
    expect(parseMediaPath("/hls/live/alice/captions/en/index.m3u8")).toBeNull();
    expect(parseCaptionsPath("/hls/live/alice/index.m3u8")).toBeNull();
  });

  test.each([
    "/hls/live/alice/captions/en/seg.mp4",
    "/hls/live/alice/captions/EN/index.m3u8",
    "/hls/live/alice/captions/english/index.m3u8",
    "/hls/live/alice/captions/index.m3u8",
    "/hls/live/alice/captions/en/../index.m3u8",
    "/hls/live/alice/captions/en/%2e.vtt",
    "/hls/live/al/captions/en/index.m3u8",
    "/hls/live/alice/subs/en/index.m3u8",
    "/hls/live/alice/captions/en/x/a.vtt",
    "/other/live/alice/captions/en/a.vtt",
  ])("captions rejects %s", (p) => {
    expect(parseCaptionsPath(p)).toBeNull();
  });

  test("DVR paths", () => {
    expect(parseDvrPath(`/dvr/${VOD}/index.m3u8`)).toEqual({ vodId: VOD, file: "index.m3u8", kind: "playlist" });
    expect(parseDvrPath(`/dvr/${VOD}/run1_000003.m4s`)?.kind).toBe("segment");
    expect(parseDvrPath(`/dvr/${VOD}/run1_init.mp4`)?.kind).toBe("segment");
  });

  test.each([
    `/dvr/${VOD.toUpperCase()}/index.m3u8`,
    "/dvr/not-a-uuid/index.m3u8",
    `/dvr/${VOD}/index.m3u8.bak`,
    `/dvr/${VOD}/a/index.m3u8`,
    `/dvr/${VOD}/../x.m4s`,
    `/dvr/${VOD}/x.ts`,
    `/dvr/${VOD}`,
    `/hls/${VOD}/index.m3u8`,
  ])("DVR rejects %s", (p) => {
    expect(parseDvrPath(p)).toBeNull();
  });

  test("requestKindOf covers every grammar", () => {
    expect(requestKindOf("/hls/live/alice/index.m3u8")).toBe("playlist");
    expect(requestKindOf("/hls/live/alice/720p/x_video1_part3.mp4")).toBe("part");
    expect(requestKindOf("/hls/live/alice/captions/en/index.m3u8")).toBe("subtitles");
    expect(requestKindOf("/hls/live/alice/captions/en/1.vtt")).toBe("vtt");
    expect(requestKindOf(`/dvr/${VOD}/index.m3u8`)).toBe("dvr");
    expect(requestKindOf("/nope")).toBeNull();
  });
});

describe("createOrigin dispatch", () => {
  test("the DVR and captions stubs are registered and answer 404 without touching upstream", async () => {
    const { pkcs8B64 } = await generateSigningKey();
    // Nothing below is reached: a registered stub answers before any directory, cache or upstream call.
    const unreachable = new Proxy(
      {},
      {
        get: () => {
          throw new Error("unexpected dependency use");
        },
      },
    );
    const origin = await createOrigin({
      db: unreachable as Executor,
      valkey: unreachable as ValkeyClient,
      playbackSigningKey: pkcs8B64,
      mediamtxHlsUrl: "http://127.0.0.1:9/",
      internalSecret: "x".repeat(32),
      mediaPassword: "x",
      cacheMb: 1,
      cdn: { provider: "none" },
    });
    expect(origin.routes.names).toEqual(["dvr", "captions:hls", "captions:relayPull", "captions:cdn"]);
    for (const path of [
      `/dvr/${VOD}/index.m3u8`,
      "/hls/live/alice/captions/en/index.m3u8",
      "/relay-pull/live/alice/captions/en/1.vtt",
    ]) {
      const res = await origin.fetch(new Request(`http://origin.test${path}?t=x`));
      expect(res.status, path).toBe(404);
    }
  });
});
