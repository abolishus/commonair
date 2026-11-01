// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `live-dvr` helpers (src/w2/dvr/): the DVR viewer's start point, the in-progress segment name, the runners. */
import { describe, expect, test } from "vite-plus/test";
import { DVR_STEP_RUNNERS } from "../../src/w2/dvr/index.ts";
import { DvrHttpViewer, nextSegmentName, startIndex } from "../../src/w2/dvr/viewer.ts";
import { DVR_STEP_NUMBERS } from "../../src/w2/steps.ts";
import type { ApiClient } from "../../src/api/client.ts";

describe("startIndex", () => {
  const four = (n: number) => Array.from({ length: n }, () => ({ duration: 4 }));
  test("the segment about `behind` seconds before the newest end", () => {
    expect(startIndex(four(30), 60)).toBe(15);
    expect(startIndex(four(30), 4)).toBe(29);
    expect(startIndex(four(30), 1)).toBe(29);
    expect(startIndex(four(10), 600)).toBe(0);
    expect(startIndex([], 60)).toBe(0);
  });
});

describe("nextSegmentName", () => {
  test("the recorder's next segment after the newest listed one", () => {
    expect(nextSegmentName("r1abc_000041.m4s?t=x")).toBe("r1abc_000042.m4s");
    expect(nextSegmentName("dvr/vod/r9_000999.m4s")).toBe("r9_001000.m4s");
    expect(nextSegmentName("r1_999999.m4s")).toBe("r1_1000000.m4s");
  });
  test("null for names the recorder does not write", () => {
    expect(nextSegmentName("init.mp4")).toBeNull();
    expect(nextSegmentName("seg12.m4s")).toBeNull();
    expect(nextSegmentName("")).toBeNull();
  });
});

describe("the step runners", () => {
  test("every live-dvr step has a runner", () => {
    expect(Object.keys(DVR_STEP_RUNNERS).map(Number)).toEqual([...DVR_STEP_NUMBERS]);
    for (const n of DVR_STEP_NUMBERS) expect(typeof DVR_STEP_RUNNERS[n]).toBe("function");
  });
});

describe("DvrHttpViewer", () => {
  test("refuses to run without a DVR grant", async () => {
    const api = {
      playback: {
        start: async () => ({ sessionId: "s", token: "t", dvrWindowSeconds: 0, dvrPlaylistUrl: null }),
        end: async () => ({ ok: true }),
      },
    } as unknown as ApiClient;
    const v = new DvrHttpViewer({ api, channel: "alice", behindSeconds: 60 });
    await expect(v.start()).rejects.toThrow("the session has no DVR grant");
    expect(v.report.dvrWindowSeconds).toBe(0);
    await v.stop();
  });

  test("plays from behind live, heartbeats in dvr mode and takes the refreshed DVR token", async () => {
    const pdt = Date.now() - 120_000;
    const playlist = (token: string) =>
      [
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:4",
        "#EXT-X-MEDIA-SEQUENCE:0",
        '#EXT-X-MAP:URI="r1_init.mp4"',
        ...Array.from({ length: 25 }, (_, i) => [
          `#EXT-X-PROGRAM-DATE-TIME:${new Date(pdt + i * 4000).toISOString()}`,
          "#EXTINF:4.000000,",
          `r1_${String(i).padStart(6, "0")}.m4s?t=${token}`,
        ]).flat(),
      ].join("\n");
    const fetched: string[] = [];
    const fakeFetch = (async (input: string | URL) => {
      const url = new URL(input);
      fetched.push(`${url.pathname.split("/").at(-1)}?${url.searchParams.get("t")}`);
      if (url.pathname.endsWith(".m3u8")) return new Response(playlist(url.searchParams.get("t") ?? ""));
      return new Response("media");
    }) as typeof fetch;
    const beats: Record<string, unknown>[] = [];
    const api = {
      playback: {
        start: async () => ({
          sessionId: "s",
          token: "live1",
          dvrWindowSeconds: 1800,
          dvrPlaylistUrl: "https://origin.test/dvr/v/index.m3u8?t=dvr1",
        }),
        heartbeat: async (input: Record<string, unknown>) => {
          beats.push(input);
          return { ok: true, token: "live2", dvrToken: "dvr2" };
        },
        end: async () => ({ ok: true }),
      },
    } as unknown as ApiClient;
    const v = new DvrHttpViewer({ api, channel: "alice", behindSeconds: 60, fetch: fakeFetch });
    const before = Date.now();
    await v.start();
    // The first playlist poll and a forward buffer of segments from ~60 s behind.
    await Bun.sleep(50);
    expect(fetched[0]).toBe("index.m3u8?dvr1");
    expect(fetched).toContain("r1_init.mp4?dvr1");
    expect(fetched).toContain("r1_000010.m4s?dvr1");
    expect(fetched.some((f) => f.startsWith("r1_000009"))).toBe(false);
    const report = await v.stop();
    expect(report.segments).toBeGreaterThanOrEqual(4);
    expect(report.playlists).toBe(1);
    // One finish time per counted fetch, in order (the relay step compares receipts with these).
    const times = v.segmentTimes();
    expect(times.length).toBe(report.segments);
    expect(times.every((t, i) => t >= before && t <= Date.now() && (i === 0 || t >= (times[i - 1] ?? 0)))).toBe(true);
    // No heartbeat within 50 ms; their shape is checked by the scenario against the API.
    expect(beats).toEqual([]);
  });
});
