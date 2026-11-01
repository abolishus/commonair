// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Live DVR at the origin (ADR 0016; docs/testing/w2-selectors.md "Live DVR"): the window cut,
 * token refusals, per-request state refusals, listed-only segments, headers and the segment log.
 */
import { describe, expect, test } from "vite-plus/test";
import type { SegmentFetch } from "@commonair/contracts/internal";
import { dvrTokenPath, vodTokenPath, type DvrState } from "@commonair/contracts/storage";
import type { PlaybackClaims } from "@commonair/contracts/tokens";
import { S3Error, type GetOptions } from "@commonair/storage";
import { generateSigningKey, signPlaybackToken } from "@commonair/tokens";
import type { SegmentLog } from "../src/accounting.ts";
import {
  createDvrHandler,
  cutToWindow,
  DVR_PLAYLIST_TTL_MS,
  dvrTokenRefusal,
  parseRecording,
  registerDvrRoutes,
  type DvrDeps,
} from "../src/dvr.ts";
import { noopMetrics } from "../src/metrics.ts";
import { OriginRouteRegistry, type OriginRouteContext } from "../src/routes.ts";
import { VOD_STATE_TTL_MS, VodStateCache, type VodState } from "../src/vod.ts";

const VOD = "0192f3a4-5b6c-7d8e-9f01-00000000aa01";
const OTHER_VOD = "0192f3a4-5b6c-7d8e-9f01-00000000aa02";
const CHANNEL = "0192f3a4-5b6c-7d8e-9f01-00000000cc01";
const SID = "0192f3a4-5b6c-7d8e-9f01-00000000dd01";
const RELAY_ID = "0192f3a4-5b6c-7d8e-9f01-00000000ee01";
const RELAY_TOKEN = `relay_${"g".repeat(43)}`;
const NOW_MS = Date.parse("2026-11-01T12:00:00.000Z");
const NOW = NOW_MS / 1000;
const T0 = Date.parse("2026-11-01T11:00:00.000Z");

/** `n` 4 s segments from T0, rendered as the recorder does (`services/media/src/vod/playlist.ts`). */
function recorderPlaylist(n: number, opts: { runs?: number[]; noPdt?: boolean } = {}): string {
  const runs = opts.runs ?? [n];
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-TARGETDURATION:4",
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    "#EXT-X-INDEPENDENT-SEGMENTS",
  ];
  let i = 0;
  runs.forEach((count, r) => {
    if (r > 0) lines.push("#EXT-X-DISCONTINUITY");
    lines.push(`#EXT-X-MAP:URI="r${r}_init.mp4"`);
    for (let k = 0; k < count; k++, i++) {
      if (!opts.noPdt) lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(T0 + i * 4000).toISOString()}`);
      lines.push("#EXTINF:4.000000,", `r${r}_${String(k).padStart(6, "0")}.m4s`);
    }
  });
  return `${lines.join("\n")}\n`;
}

const segmentLines = (text: string) => text.split("\n").filter((l) => l !== "" && !l.startsWith("#"));

describe("parseRecording and cutToWindow", () => {
  test("parses the recorder's playlist: PDT, init segments, discontinuities", () => {
    const rec = parseRecording(recorderPlaylist(4, { runs: [2, 2] }));
    expect(rec.mediaSequence).toBe(0);
    expect(rec.segments.map((s) => [s.uri, s.map, s.discontinuity])).toEqual([
      ["r0_000000.m4s", "r0_init.mp4", false],
      ["r0_000001.m4s", "r0_init.mp4", false],
      ["r1_000000.m4s", "r1_init.mp4", true],
      ["r1_000001.m4s", "r1_init.mp4", false],
    ]);
    expect(rec.segments[1]!.pdtMs).toBe(T0 + 4000);
    expect(rec.segments[0]!.durationSeconds).toBe(4);
  });

  test("tolerates junk: a URI without EXTINF, a bad PDT, negative sequences", () => {
    const rec = parseRecording(
      "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:-3\nstray.m4s\n#EXT-X-PROGRAM-DATE-TIME:nope\n#EXTINF:x,\na.m4s\n#EXTINF:2,\nb.m4s\n",
    );
    expect(rec.mediaSequence).toBe(0);
    expect(rec.segments.map((s) => [s.uri, s.pdtMs])).toEqual([["b.m4s", null]]);
  });

  test("cuts to the window by PDT from the newest segment and fixes the media sequence", () => {
    // 100 segments = 400 s; a 60 s window keeps the last 15.
    const cut = cutToWindow(parseRecording(recorderPlaylist(100)), 60);
    const uris = segmentLines(cut.text);
    expect(uris).toHaveLength(15);
    expect(uris[0]).toBe("r0_000085.m4s");
    expect(cut.text).toContain("#EXT-X-MEDIA-SEQUENCE:85\n");
    expect(cut.text).toContain('#EXT-X-MAP:URI="r0_init.mp4"');
    expect(cut.text).not.toContain("ENDLIST");
    expect(cut.text).not.toContain("PLAYLIST-TYPE");
    expect(cut.text).toContain(`#EXT-X-PROGRAM-DATE-TIME:${new Date(T0 + 85 * 4000).toISOString()}`);
    expect(cut.startMs).toBe(T0 + 85 * 4000);
    expect(cut.endMs).toBe(T0 + 400_000);
    expect([...cut.objects]).toEqual(["r0_init.mp4", ...uris]);
  });

  test("a segment partly inside the window is kept; a window wider than the recording keeps all", () => {
    expect(segmentLines(cutToWindow(parseRecording(recorderPlaylist(100)), 61).text)).toHaveLength(16);
    expect(segmentLines(cutToWindow(parseRecording(recorderPlaylist(10)), 7200).text)).toHaveLength(10);
    expect(cutToWindow(parseRecording(recorderPlaylist(10)), 7200).text).toContain("#EXT-X-MEDIA-SEQUENCE:0\n");
  });

  test("the window is by PDT, not by count: a gap in the recording shortens it", () => {
    const rec = parseRecording(recorderPlaylist(10));
    // Segments 0–4 recorded an hour earlier than 5–9.
    rec.segments.slice(0, 5).forEach((s) => (s.pdtMs = (s.pdtMs ?? 0) - 3_600_000));
    expect(segmentLines(cutToWindow(rec, 60).text)).toEqual(rec.segments.slice(5).map((s) => s.uri));
  });

  test("discontinuities: the sequence counts the ones cut away, the new run's init segment is repeated", () => {
    const rec = parseRecording(recorderPlaylist(40, { runs: [20, 10, 10] }));
    // 30 s keeps the last 8 segments, all of the third run.
    const third = cutToWindow(rec, 30);
    expect(third.text).toContain("#EXT-X-DISCONTINUITY-SEQUENCE:2\n");
    expect(third.text).toContain("#EXT-X-MEDIA-SEQUENCE:32\n");
    expect(third.text).not.toContain("#EXT-X-DISCONTINUITY\n");
    expect(third.objects.has("r2_init.mp4")).toBe(true);
    expect(third.objects.has("r1_init.mp4")).toBe(false);
    // 60 s keeps the end of the second run and the whole third: one tag between them.
    const both = cutToWindow(rec, 60);
    expect(both.text).toContain("#EXT-X-DISCONTINUITY-SEQUENCE:1\n");
    expect(both.text.match(/#EXT-X-DISCONTINUITY\n/g)).toHaveLength(1);
    expect(both.text.indexOf('#EXT-X-MAP:URI="r1_init.mp4"')).toBeLessThan(both.text.indexOf("#EXT-X-DISCONTINUITY\n"));
    expect(both.text.indexOf("#EXT-X-DISCONTINUITY\n")).toBeLessThan(both.text.indexOf('#EXT-X-MAP:URI="r2_init.mp4"'));
    // Without a cut there is no sequence tag.
    expect(cutToWindow(rec, 7200).text).not.toContain("DISCONTINUITY-SEQUENCE");
  });

  test("without PDT the window is counted in durations back from the newest segment", () => {
    const cut = cutToWindow(parseRecording(recorderPlaylist(20, { noPdt: true })), 20);
    expect(segmentLines(cut.text)).toHaveLength(5);
    expect(cut.startMs).toBeNull();
    expect(cut.text).not.toContain("PROGRAM-DATE-TIME");
  });

  test("leading segments without PDT get one derived backwards", () => {
    const rec = parseRecording(recorderPlaylist(6));
    rec.segments[0]!.pdtMs = null;
    rec.segments[1]!.pdtMs = null;
    rec.segments[3]!.pdtMs = null;
    const cut = cutToWindow(rec, 7200);
    expect(cut.startMs).toBe(T0);
    expect(cut.text.match(/PROGRAM-DATE-TIME/g)).toHaveLength(6);
  });

  test("an empty recording cuts to an empty window", () => {
    const cut = cutToWindow(parseRecording("#EXTM3U\n"), 60);
    expect(cut.objects.size).toBe(0);
    expect(cut.endMs).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------

const { key } = await generateSigningKey();
const { key: otherKey } = await generateSigningKey();
const claims = (over: Partial<PlaybackClaims> = {}): PlaybackClaims => ({
  v: 1,
  sid: SID,
  cid: CHANNEL,
  path: dvrTokenPath(VOD),
  src: "origin",
  iat: NOW - 10,
  exp: NOW + 120,
  ...over,
});
const token = (over: Partial<PlaybackClaims> = {}, k = key) => signPlaybackToken(k, claims(over));

const SERVABLE: Omit<DvrState, never> = {
  vodStatus: "recording",
  removedReason: null,
  broadcastLive: true,
  broadcastKind: "live",
  broadcastRestricted: false,
  channelSuspended: false,
  dvrEnabled: true,
  nciiHidden: false,
  dmcaHidden: false,
};

function vodState(s: DvrState, prefix = `recordings/${VOD}/`): VodState {
  return {
    channelId: CHANNEL,
    storagePrefix: prefix,
    state: {
      status: s.vodStatus,
      visibility: "public",
      removedReason: s.removedReason,
      broadcastRestricted: s.broadcastRestricted,
      channelSuspended: s.channelSuspended,
      nciiHidden: s.nciiHidden,
      dmcaHidden: s.dmcaHidden,
    },
    dvr: { broadcastLive: s.broadcastLive, broadcastKind: s.broadcastKind, dvrEnabled: s.dvrEnabled },
  };
}

function setup(opts: { segments?: number; window?: number; cap?: number } = {}) {
  const objects: Record<string, string> = {
    [`recordings/${VOD}/index.m3u8`]: recorderPlaylist(opts.segments ?? 100),
    [`recordings/${VOD}/r0_init.mp4`]: "init",
    [`vods/${VOD}/index.m3u8`]: recorderPlaylist(3),
  };
  for (let i = 0; i < (opts.segments ?? 100); i++)
    objects[`recordings/${VOD}/r0_${String(i).padStart(6, "0")}.m4s`] = `seg${i}`;
  const reads: string[] = [];
  const storage = {
    async get(_bucket: string, k: string, o?: GetOptions): Promise<Response | null> {
      reads.push(k);
      if (k.endsWith("index.m3u8") && storageDown) throw new S3Error(500, "InternalError", "get");
      const body = objects[k];
      if (body === undefined) return null;
      if (o?.range) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(o.range)!;
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : body.length - 1;
        return new Response(body.slice(start, end + 1), {
          status: 206,
          headers: { "content-type": "video/mp4", "content-range": `bytes ${start}-${end}/${body.length}` },
        });
      }
      const type = k.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/iso.segment";
      return new Response(body, { headers: { "content-type": type, "content-length": String(body.length) } });
    },
  };
  let storageDown = false;
  let clock = NOW_MS;
  let current: VodState | null = vodState(SERVABLE);
  const states = new VodStateCache(async () => current, { now: () => clock });
  const logged: SegmentFetch[] = [];
  const segments = { record: (e: SegmentFetch) => logged.push(e) } as unknown as SegmentLog;
  let windowLookups = 0;
  const deps: DvrDeps = {
    publicKey: key.publicKey,
    vodStates: states,
    media: { storage, bucket: "media" },
    segments,
    dvrMaxWindowSeconds: opts.cap ?? 7200,
    metrics: noopMetrics,
    now: () => clock,
    channelWindow: async () => {
      windowLookups++;
      return opts.window ?? 60;
    },
    // One relay token is known (`Bearer relay_good…`); anything else is refused.
    relays: {
      authenticate: async (header: string | null) => (header === `Bearer ${RELAY_TOKEN}` ? { id: RELAY_ID } : null),
    },
  };
  const handler = createDvrHandler(deps);
  const get = async (path: string, init: RequestInit & { t?: string | null } = {}) => {
    const t = init.t === undefined ? await token() : init.t;
    const url = `http://origin/dvr/${path}${t === null ? "" : `${path.includes("?") ? "&" : "?"}t=${t}`}`;
    const raw = new URL(url).pathname;
    return handler(new Request(url, init), raw);
  };
  /** A relay pull of `/relay-pull/dvr/<path>`, with the known relay token unless told otherwise. */
  const pull = async (path: string, init: RequestInit & { bearer?: string | null; peer?: string } = {}) => {
    const url = `http://origin/relay-pull/dvr/${path}`;
    const bearer = init.bearer === undefined ? RELAY_TOKEN : init.bearer;
    const headers = new Headers(init.headers);
    if (bearer !== null) headers.set("authorization", `Bearer ${bearer}`);
    return handler(new Request(url, { ...init, headers }), new URL(url).pathname, init.peer ?? "10.0.0.9");
  };
  return {
    get,
    pull,
    objects,
    reads,
    logged,
    windowLookups: () => windowLookups,
    setState: (s: Partial<DvrState> | null, prefix?: string) => {
      current = s === null ? null : vodState({ ...SERVABLE, ...s }, prefix);
    },
    advance: (ms: number) => (clock += ms),
    storageDown: (down: boolean) => (storageDown = down),
  };
}

describe("/dvr/ playlist", () => {
  test("serves the window, URIs carrying the token, private no-store, logged as dvr", async () => {
    const s = setup();
    const t = await token();
    const res = await s.get(`${VOD}/index.m3u8`, { t });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await res.text();
    expect(Number(res.headers.get("content-length"))).toBe(new TextEncoder().encode(body).byteLength);
    const uris = segmentLines(body);
    expect(uris).toHaveLength(15);
    expect(uris.every((u) => u.endsWith(`?t=${encodeURIComponent(t)}`) || u.endsWith(`?t=${t}`))).toBe(true);
    expect(body).toContain(`#EXT-X-MAP:URI="r0_init.mp4?t=`);
    expect(body).toContain("#EXT-X-MEDIA-SEQUENCE:85");
    expect(body).not.toContain("ENDLIST");
    expect(s.logged).toEqual([
      {
        sid: SID,
        cid: CHANNEL,
        src: "origin",
        kind: "playlist",
        bytes: Number(res.headers.get("content-length")),
        at: NOW_MS,
        mode: "dvr",
      },
    ]);
  });

  test("reads only the recording's playlist, never vods/", async () => {
    const s = setup();
    await s.get(`${VOD}/index.m3u8`);
    await s.get(`${VOD}/r0_000099.m4s`);
    expect(s.reads.every((k) => k.startsWith(`recordings/${VOD}/`))).toBe(true);
    // A VOD whose row already points at vods/ is not recording: refused before storage is read.
    s.setState({}, `vods/${VOD}/`);
    s.advance(VOD_STATE_TTL_MS);
    const before = s.reads.length;
    expect((await s.get(`${VOD}/index.m3u8`)).status).toBe(404);
    expect(s.reads.length).toBe(before);
  });

  test("the window is min(channel window, instance cap)", async () => {
    expect(segmentLines(await (await setup({ window: 1800, cap: 40 }).get(`${VOD}/index.m3u8`)).text())).toHaveLength(
      10,
    );
    expect(segmentLines(await (await setup({ window: 20, cap: 7200 }).get(`${VOD}/index.m3u8`)).text())).toHaveLength(
      5,
    );
    expect((await setup({ window: 1800, cap: 0 }).get(`${VOD}/index.m3u8`)).status).toBe(404);
  });

  test("HEAD answers headers only and is not logged", async () => {
    const s = setup();
    const res = await s.get(`${VOD}/index.m3u8`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
    expect(s.logged).toEqual([]);
  });

  test("the playlist is reused for a second, then re-read", async () => {
    const s = setup();
    await s.get(`${VOD}/index.m3u8`);
    await s.get(`${VOD}/index.m3u8`);
    const playlistReads = () => s.reads.filter((k) => k.endsWith("index.m3u8")).length;
    expect(playlistReads()).toBe(1);
    s.advance(DVR_PLAYLIST_TTL_MS);
    await s.get(`${VOD}/index.m3u8`);
    expect(playlistReads()).toBe(2);
  });

  test("only index.m3u8 is a playlist; a missing recording is 404; storage down is 502", async () => {
    const s = setup();
    expect((await s.get(`${VOD}/other.m3u8`)).status).toBe(404);
    s.advance(DVR_PLAYLIST_TTL_MS);
    s.storageDown(true);
    expect((await s.get(`${VOD}/index.m3u8`)).status).toBe(502);
    s.storageDown(false);
    s.advance(DVR_PLAYLIST_TTL_MS);
    delete s.objects[`recordings/${VOD}/index.m3u8`];
    expect((await s.get(`${VOD}/index.m3u8`)).status).toBe(404);
  });
});

describe("/dvr/ segments", () => {
  test("a listed segment inside the window, with ranges, private no-store, logged with obj", async () => {
    const s = setup();
    const res = await s.get(`${VOD}/r0_000099.m4s`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("seg99");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(s.logged).toEqual([
      {
        sid: SID,
        cid: CHANNEL,
        src: "origin",
        kind: "segment",
        bytes: 5,
        at: NOW_MS,
        obj: `dvr/${VOD}/r0_000099.m4s`,
        mode: "dvr",
      },
    ]);
    const ranged = await s.get(`${VOD}/r0_000099.m4s`, { headers: { range: "bytes=1-2" } });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe("eg");
    expect((await s.get(`${VOD}/r0_000099.m4s`, { headers: { range: "pages=1" } })).status).toBe(416);
  });

  test("the init segment of a listed segment is served", async () => {
    const s = setup();
    const res = await s.get(`${VOD}/r0_init.mp4`);
    expect(res.status).toBe(200);
    expect(s.logged[0]?.obj).toBe(`dvr/${VOD}/r0_init.mp4`);
  });

  test("outside the window, unlisted (still recording) or listed but missing: 404, nothing logged", async () => {
    const s = setup();
    // Segment 0 exists in storage but is 400 s back, outside the 60 s window.
    expect((await s.get(`${VOD}/r0_000000.m4s`)).status).toBe(404);
    // The segment being recorded is not in the playlist yet (uploaded or not).
    s.objects[`recordings/${VOD}/r0_000100.m4s`] = "partial";
    expect((await s.get(`${VOD}/r0_000100.m4s`)).status).toBe(404);
    delete s.objects[`recordings/${VOD}/r0_000099.m4s`];
    expect((await s.get(`${VOD}/r0_000099.m4s`)).status).toBe(404);
    expect(s.logged).toEqual([]);
  });

  test("HEAD on a segment is not logged", async () => {
    const s = setup();
    const res = await s.get(`${VOD}/r0_000099.m4s`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(s.logged).toEqual([]);
  });
});

describe("/dvr/ token refusals", () => {
  test.each<[string, Partial<PlaybackClaims> | "missing" | "other-key" | "garbage"]>([
    ["missing", "missing"],
    ["garbage", "garbage"],
    ["signed by another key", "other-key"],
    ["expired", { iat: NOW - 600, exp: NOW - 300 }],
    ["a live token", { path: "live/alice" }],
    ["a VOD token", { path: vodTokenPath(VOD) }],
    ["another VOD's DVR token", { path: dvrTokenPath(OTHER_VOD) }],
    ["a relay token", { src: "relay", rid: "0192f3a4-5b6c-7d8e-9f01-00000000ee01" }],
    ["a CDN token", { src: "cdn" }],
    ["another channel", { cid: "0192f3a4-5b6c-7d8e-9f01-00000000cc02" }],
  ])("%s: 401", async (_name, over) => {
    const s = setup();
    const t =
      over === "missing"
        ? null
        : over === "garbage"
          ? "abc.def"
          : over === "other-key"
            ? await token({}, otherKey)
            : await token(over);
    for (const file of ["index.m3u8", "r0_000099.m4s"]) {
      const res = await s.get(`${VOD}/${file}`, { t });
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(s.logged).toEqual([]);
  });

  test("a data-mode token is refused (by the claim schema, and by the route if it ever parsed)", async () => {
    const s = setup();
    // The contract's refine refuses `dm` on a `dvr/` path, so such a token never verifies.
    await expect(token({ dm: 400_000 })).rejects.toThrow("dm only on origin tokens for a live path");
    expect(dvrTokenRefusal(claims({ dm: 400_000 }), VOD)).toBe("data_mode");
    expect(dvrTokenRefusal(claims(), VOD)).toBeNull();
    expect(dvrTokenRefusal(claims({ src: "relay" }), VOD)).toBe("wrong_source");
    expect(dvrTokenRefusal(claims(), OTHER_VOD)).toBe("wrong_path");
    expect(s.logged).toEqual([]);
  });
});

describe("/dvr/ state refusals", () => {
  test.each<[string, Partial<DvrState> | null]>([
    ["no such VOD", null],
    ["VOD ready (the broadcast ended and it published)", { vodStatus: "ready" }],
    ["VOD processing", { vodStatus: "processing" }],
    ["removed by the owner", { removedReason: "owner" }],
    ["removed (T0)", { vodStatus: "deleted", removedReason: "t0" }],
    ["broadcast ended", { broadcastLive: false }],
    ["a rehearsal", { broadcastKind: "rehearsal" }],
    ["T1-restricted", { broadcastRestricted: true }],
    ["channel suspended", { channelSuspended: true }],
    ["DVR off", { dvrEnabled: false }],
    ["NCII hidden", { nciiHidden: true }],
    ["DMCA hidden", { dmcaHidden: true }],
  ])("%s: 404 for the playlist and segments", async (_name, state) => {
    const s = setup();
    s.setState(state);
    for (const file of ["index.m3u8", "r0_000099.m4s"]) expect((await s.get(`${VOD}/${file}`)).status).toBe(404);
    expect(s.logged).toEqual([]);
  });

  test("a removal answers 404 once the 5 s state cache turns over", async () => {
    const s = setup();
    expect((await s.get(`${VOD}/index.m3u8`)).status).toBe(200);
    s.setState({ removedReason: "owner" });
    // Within the TTL the cached state still serves (the bound ADR 0016 decision 3 accepts).
    s.advance(VOD_STATE_TTL_MS - 1);
    expect((await s.get(`${VOD}/r0_000099.m4s`)).status).toBe(200);
    s.advance(1);
    expect((await s.get(`${VOD}/r0_000099.m4s`)).status).toBe(404);
    expect((await s.get(`${VOD}/index.m3u8`)).status).toBe(404);
  });
});

describe("/dvr/ request handling", () => {
  test("OPTIONS, wrong method, bad paths", async () => {
    const s = setup();
    expect((await s.get(`${VOD}/index.m3u8`, { method: "OPTIONS" })).status).toBe(204);
    const post = await s.get(`${VOD}/index.m3u8`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    for (const bad of [`${VOD}/../x.m4s`, `not-a-uuid/index.m3u8`, `${VOD}/a/b.m4s`, `${VOD}/x.ts`])
      expect((await s.get(bad)).status).toBe(404);
  });

  test("without object storage every request is 404", async () => {
    const deps = { ...setupDeps(), media: undefined };
    const res = await createDvrHandler(deps)(
      new Request(`http://origin/dvr/${VOD}/index.m3u8?t=${await token()}`),
      `/dvr/${VOD}/index.m3u8`,
    );
    expect(res.status).toBe(404);
  });

  test("registers the dvr route on the registry", () => {
    const registry = new OriginRouteRegistry();
    const ctx = { ...setupDeps(), db: {} } as unknown as OriginRouteContext;
    registerDvrRoutes(registry, ctx);
    expect(registry.find(`/dvr/${VOD}/index.m3u8`)?.name).toBe("dvr");
    expect(registry.find("/hls/live/a/index.m3u8")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------
// Relay pulls (batch 7 decision (x), ADR 0016 Amendment 1 A1.3).

describe("/relay-pull/dvr/", () => {
  const relayLog = (kind: "playlist" | "segment", bytes: number, obj?: string): SegmentFetch => ({
    sid: RELAY_ID,
    cid: CHANNEL,
    src: "relay",
    rid: RELAY_ID,
    kind,
    bytes,
    at: NOW_MS,
    ...(obj ? { obj } : {}),
    mode: "dvr",
  });

  test("the relay bearer token, as the live pull: missing or unknown is 401, repeated failures 429", async () => {
    const s = setup();
    expect((await s.pull(`${VOD}/index.m3u8`, { bearer: null })).status).toBe(401);
    // A viewer's DVR token is no relay credential.
    expect((await s.pull(`${VOD}/index.m3u8?t=${await token()}`, { bearer: null })).status).toBe(401);
    for (let i = 0; i < 8; i++) expect((await s.pull(`${VOD}/index.m3u8`, { bearer: "relay_nope" })).status).toBe(401);
    const limited = await s.pull(`${VOD}/index.m3u8`, { bearer: "relay_nope" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    // Even the right token from that peer waits out the minute; another peer is unaffected.
    expect((await s.pull(`${VOD}/index.m3u8`)).status).toBe(429);
    expect((await s.pull(`${VOD}/index.m3u8`, { peer: "10.0.0.10" })).status).toBe(200);
    s.advance(60_000);
    expect((await s.pull(`${VOD}/index.m3u8`)).status).toBe(200);
    expect(s.reads.filter((k) => k.endsWith("index.m3u8"))).toHaveLength(2); // refused pulls read nothing
  });

  test("the same window, with bare relative URIs, logged as the relay's dvr fetch", async () => {
    const s = setup();
    const res = await s.pull(`${VOD}/index.m3u8`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.text();
    const uris = segmentLines(body);
    expect(uris).toHaveLength(15);
    expect(uris[0]).toBe("r0_000085.m4s");
    expect(body).toContain(`#EXT-X-MAP:URI="r0_init.mp4"`);
    expect(body).not.toContain("?t=");
    expect(body).toContain("#EXT-X-MEDIA-SEQUENCE:85");
    expect(s.logged).toEqual([relayLog("playlist", Number(res.headers.get("content-length")))]);
    // The viewer route shares the cached recording.
    expect((await s.get(`${VOD}/index.m3u8`)).status).toBe(200);
    expect(s.reads.filter((k) => k.endsWith("index.m3u8"))).toHaveLength(1);
  });

  test("listed segments only; HEAD is not logged", async () => {
    const s = setup();
    const seg = await s.pull(`${VOD}/r0_000099.m4s`);
    expect(seg.status).toBe(200);
    expect(await seg.text()).toBe("seg99");
    expect(seg.headers.get("cache-control")).toBe("private, no-store");
    expect((await s.pull(`${VOD}/r0_init.mp4`)).status).toBe(200);
    expect((await s.pull(`${VOD}/r0_000010.m4s`)).status).toBe(404);
    expect((await s.pull(`${VOD}/r0_000098.m4s`, { method: "HEAD" })).status).toBe(200);
    expect(s.logged).toEqual([
      relayLog("segment", 5, `dvr/${VOD}/r0_000099.m4s`),
      relayLog("segment", 4, `dvr/${VOD}/r0_init.mp4`),
    ]);
  });

  test("the same state checks: removal, restriction, suspension, DVR off and a finished VOD close it", async () => {
    for (const change of [
      { removedReason: "moderation" },
      { broadcastRestricted: true },
      { channelSuspended: true },
      { dvrEnabled: false },
      { broadcastLive: false },
      { vodStatus: "processing" as const },
      { nciiHidden: true },
    ] satisfies Partial<DvrState>[]) {
      const s = setup();
      expect((await s.pull(`${VOD}/index.m3u8`)).status).toBe(200);
      s.setState(change);
      s.advance(VOD_STATE_TTL_MS);
      expect([(await s.pull(`${VOD}/index.m3u8`)).status, change]).toEqual([404, change]);
      expect([(await s.pull(`${VOD}/r0_000099.m4s`)).status, change]).toEqual([404, change]);
    }
    const s = setup();
    s.setState({}, `vods/${VOD}/`);
    expect((await s.pull(`${VOD}/index.m3u8`)).status).toBe(404);
  });

  test("bad paths are 404 before any lookup", async () => {
    const s = setup();
    for (const p of [`${VOD}/x/index.m3u8`, `NOTAUUID/index.m3u8`, `${VOD}/../index.m3u8`, `${VOD}/index.txt`])
      expect([(await s.pull(p)).status, p]).toEqual([404, p]);
    expect(s.reads).toEqual([]);
  });

  test("the viewer route still refuses a relay DVR token: relay viewers rewind on their relay", async () => {
    const s = setup();
    const relayToken = await token({ src: "relay", rid: RELAY_ID });
    expect((await s.get(`${VOD}/index.m3u8`, { t: relayToken })).status).toBe(401);
  });

  test("without relay auth wired the relay route is 404", async () => {
    const deps = setupDeps();
    const res = await createDvrHandler(deps)(
      new Request(`http://origin/relay-pull/dvr/${VOD}/index.m3u8`, {
        headers: { authorization: `Bearer ${RELAY_TOKEN}` },
      }),
      `/relay-pull/dvr/${VOD}/index.m3u8`,
    );
    expect(res.status).toBe(404);
  });

  test("one registry entry serves both routes; live relay pulls are not its", () => {
    const registry = new OriginRouteRegistry();
    registerDvrRoutes(registry, { ...setupDeps(), db: {} } as unknown as OriginRouteContext);
    expect(registry.names).toEqual(["dvr"]);
    expect(registry.find(`/relay-pull/dvr/${VOD}/index.m3u8`)?.name).toBe("dvr");
    expect(registry.find(`/dvr/${VOD}/index.m3u8`)?.name).toBe("dvr");
    expect(registry.find("/relay-pull/live/a/index.m3u8")).toBeUndefined();
    expect(registry.find("/cdn/dvr/x")).toBeUndefined();
  });
});

function setupDeps(): DvrDeps {
  return {
    publicKey: key.publicKey,
    vodStates: new VodStateCache(async () => vodState(SERVABLE)),
    media: { storage: { get: async () => null }, bucket: "media" },
    segments: { record: () => undefined } as unknown as SegmentLog,
    dvrMaxWindowSeconds: 7200,
    metrics: noopMetrics,
    now: () => NOW_MS,
    channelWindow: async () => 60,
  };
}
