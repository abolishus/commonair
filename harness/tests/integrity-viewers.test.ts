// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The integrity-basic helpers: row judgements, hidden-tab timing, and the two viewers against fakes. */
import { describe, expect, test } from "vite-plus/test";
import type { ApiClient } from "../src/api/client.ts";
import { seededRandom } from "../src/cidrs.ts";
import {
  FETCH_UNJUDGED,
  HeartbeatOnlyViewer,
  HiddenTabViewer,
  VIEWER_WINDOW_MS,
  cdnBotSettled,
  claimedBytes,
  fetchlessHeld,
  gateEligible,
  hiddenHeartbeatDelay,
  honestAudience,
  onCdn,
} from "../src/integrity-viewers.ts";
import type { HeartbeatInput } from "../src/viewer.ts";

describe("gateEligible (mirror of @commonair/integrity)", () => {
  test.each([
    ["verified", [], true],
    ["verified", ["datacenter_ip"], true],
    ["verified", [FETCH_UNJUDGED], false],
    ["verified", null, true],
    ["pending", [], false],
    ["pending", ["media_unconfirmed"], false],
    ["excluded", ["fetch_pattern"], false],
  ] as const)("%s with %j → %s", (verdict, reasons, expected) => {
    expect(gateEligible({ verdict, reasons })).toBe(expected);
  });
});

describe("fetchlessHeld", () => {
  test("pending needs media_unconfirmed; excluded needs fetch_pattern; verified never passes", () => {
    expect(fetchlessHeld({ verdict: "pending", reasons: ["media_unconfirmed"] })).toBe(true);
    expect(fetchlessHeld({ verdict: "pending", reasons: ["fetch_unjudged", "media_unconfirmed"] })).toBe(true);
    expect(fetchlessHeld({ verdict: "excluded", reasons: ["fetch_pattern", "headless"] })).toBe(true);
    // Pending only for too few beats is not the delivery check holding it.
    expect(fetchlessHeld({ verdict: "pending", reasons: ["insufficient_heartbeats"] })).toBe(false);
    expect(fetchlessHeld({ verdict: "excluded", reasons: ["datacenter_ip", "headless"] })).toBe(false);
    expect(fetchlessHeld({ verdict: "verified", reasons: [] })).toBe(false);
    expect(fetchlessHeld({ verdict: "pending", reasons: null })).toBe(false);
  });
});

describe("cdnBotSettled", () => {
  test("waits for the marker and for enough heartbeats", () => {
    expect(cdnBotSettled({ verdict: "verified", reasons: [FETCH_UNJUDGED] })).toBe(true);
    expect(cdnBotSettled({ verdict: "pending", reasons: [FETCH_UNJUDGED, "insufficient_heartbeats"] })).toBe(false);
    expect(cdnBotSettled({ verdict: "verified", reasons: [] })).toBe(false);
    expect(cdnBotSettled({ verdict: "verified", reasons: null })).toBe(false);
  });
});

describe("honestAudience and claimedBytes", () => {
  test("sums the groups, ignoring negatives", () => {
    expect(honestAudience({ plain: 3, household: 3, hidden: 1 })).toBe(7);
    expect(honestAudience({ plain: 3, household: 0, hidden: 1 })).toBe(4);
    expect(honestAudience({ plain: 3, household: -2, hidden: 1 })).toBe(4);
  });
  test("bytes at a claimed bitrate", () => {
    expect(claimedBytes(1000, 1500)).toBe(187_500);
    expect(claimedBytes(0, 1500)).toBe(0);
    expect(claimedBytes(-5, 1500)).toBe(0);
  });
});

describe("onCdn", () => {
  test("lists only sessions the API sent to the CDN; unknown and other sources pass", () => {
    expect(
      onCdn([
        { id: "a", source: "origin" },
        { id: "b", source: "cdn" },
        { id: "c", source: null },
        { id: "d", source: "relay" },
      ]),
    ).toEqual([{ id: "b", source: "cdn" }]);
    expect(onCdn([])).toEqual([]);
  });
});

describe("hiddenHeartbeatDelay", () => {
  test("whole seconds, slower than the visible cadence, below the viewer window", () => {
    const random = seededRandom(42);
    for (let i = 0; i < 500; i++) {
      const d = hiddenHeartbeatDelay(10_000, random);
      expect(d % 1000).toBe(0);
      expect(d).toBeGreaterThanOrEqual(15_000);
      expect(d).toBeLessThan(VIEWER_WINDOW_MS);
    }
  });
  test("stretch and cap are honoured; never below one second", () => {
    expect(hiddenHeartbeatDelay(10_000, () => 0.5, 1)).toBe(10_000);
    expect(hiddenHeartbeatDelay(10_000, () => 0.5, 5, 12_500)).toBe(12_000);
    expect(hiddenHeartbeatDelay(100, () => 0.5)).toBe(1_000);
  });
});

/** A playback API double: records heartbeats; the token carries `src`. */
function fakeApi(source: "origin" | "cdn", intervalMs = 300) {
  const beats: HeartbeatInput[] = [];
  const ended: string[] = [];
  const token = `${Buffer.from(JSON.stringify({ src: source, sid: "s1" })).toString("base64url")}.sig`;
  const api = {
    playback: {
      start: async () => ({
        sessionId: "s1",
        token,
        playlistUrl: `https://media.test/hls/live/c/index.m3u8?t=${token}`,
        source,
        heartbeatIntervalMs: intervalMs,
      }),
      heartbeat: async (input: HeartbeatInput) => {
        beats.push(input);
        return { ok: true };
      },
      end: async (input: { sessionId: string }) => {
        ended.push(input.sessionId);
        return { ok: true };
      },
    },
  } as unknown as ApiClient;
  return { api, beats, ended };
}

describe("HeartbeatOnlyViewer", () => {
  test("heartbeats claimed playback with plausible stats and never fetches anything", async () => {
    const { api, beats, ended } = fakeApi("cdn");
    const v = new HeartbeatOnlyViewer({ id: "b", api, channel: "c", random: seededRandom(1) });
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      return new Response("");
    }) as unknown as typeof fetch;
    try {
      await v.start();
      expect(v.assignment).toEqual({ source: "cdn", relayId: null });
      expect(v.sessionId).toBe("s1");
      await new Promise((r) => setTimeout(r, 1_200));
      await v.stop();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetched).toBe(0);
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(v.heartbeats).toBe(beats.length);
    for (const b of beats) {
      expect(b).toMatchObject({ visible: true, muted: false, bytesP2p: 0 });
      expect(b.playedSeconds).toBeGreaterThan(0);
      expect(b.bytesHttp).toBeGreaterThan(0);
      expect(b.fingerprint?.webdriver).toBe(false);
    }
    expect(ended).toEqual(["s1"]);
  });
});

describe("HiddenTabViewer", () => {
  const MEDIA = (seq: number) =>
    [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      "#EXT-X-TARGETDURATION:1",
      `#EXT-X-MEDIA-SEQUENCE:${seq}`,
      '#EXT-X-MAP:URI="init.mp4"',
      ...[0, 1, 2].flatMap((i) => ["#EXTINF:1.0,", `seg${seq + i}.mp4`]),
    ].join("\n");

  test("keeps fetching while hidden; hidden beats say visible: false on whole-second wake-ups", async () => {
    const { api, beats } = fakeApi("origin", 300);
    const requests: string[] = [];
    let seq = 0;
    // The viewer always passes a URL string.
    const fakeFetch = (async (input: string) => {
      const url = new URL(input);
      requests.push(url.pathname);
      if (url.pathname.endsWith(".m3u8")) return new Response(MEDIA(seq++));
      return new Response(new Uint8Array(64));
    }) as unknown as typeof fetch;
    const v = new HiddenTabViewer({ api, channel: "c", fetch: fakeFetch, random: seededRandom(3) });
    await v.start();
    expect(await v.waitForFirstFrame(5_000)).toBeGreaterThanOrEqual(0);
    await new Promise((r) => setTimeout(r, 700));
    const visibleBeats = beats.length;
    expect(visibleBeats).toBeGreaterThanOrEqual(1);
    v.hide();
    const segmentsBefore = requests.filter((p) => p.includes("seg")).length;
    await new Promise((r) => setTimeout(r, 2_600));
    v.show();
    const report = await v.stop();

    // The media kept coming while hidden.
    expect(requests.filter((p) => p.includes("seg")).length).toBeGreaterThan(segmentsBefore);
    const hiddenBeats = beats.filter((b) => !b.visible);
    expect(hiddenBeats.length).toBeGreaterThanOrEqual(1);
    expect(v.beatsWhileHidden).toBe(hiddenBeats.length);
    expect(beats.slice(0, visibleBeats).every((b) => b.visible)).toBe(true);
    for (const b of beats) expect(b.muted).toBe(false);
    expect(report.heartbeats).toBe(beats.length);
    expect(report.playedSeconds).toBeGreaterThan(0);
  });

  test("hidden beats are held to the background cadence; show() releases a held beat; other calls pass through", async () => {
    const { api, beats, ended } = fakeApi("origin", 300);
    const at: number[] = [];
    const timed = new Proxy(api, {
      get: (t, k, r) =>
        k === "playback"
          ? new Proxy(api.playback, {
              get: (pt, pk, pr) =>
                pk === "heartbeat"
                  ? async (input: HeartbeatInput) => {
                      at.push(Date.now());
                      return api.playback.heartbeat(input);
                    }
                  : Reflect.get(pt, pk, pr),
            })
          : Reflect.get(t, k, r),
    });
    const fakeFetch = (async (input: string) =>
      new URL(input).pathname.endsWith(".m3u8")
        ? new Response(MEDIA(0))
        : new Response(new Uint8Array(64))) as unknown as typeof fetch;
    const v = new HiddenTabViewer({ api: timed, channel: "c", fetch: fakeFetch, random: seededRandom(5) });
    await v.start();
    expect(v.assignment).toEqual({ source: "origin", relayId: null });
    await new Promise((r) => setTimeout(r, 700));
    v.hide();
    const hiddenFrom = beats.length;
    await new Promise((r) => setTimeout(r, 3_200));
    const hiddenGaps = at.slice(hiddenFrom).map((t, i) => t - (at[hiddenFrom + i - 1] ?? t));
    // hiddenHeartbeatDelay(300 ms) is at least one whole second; visible beats come every ~300 ms.
    expect(beats.length - hiddenFrom).toBeGreaterThanOrEqual(2);
    for (const gap of hiddenGaps) expect(gap).toBeGreaterThanOrEqual(950);
    // A beat held while hidden goes out promptly, as visible, once the tab is shown.
    v.show();
    const shownAt = Date.now();
    const before = beats.length;
    await new Promise((r) => setTimeout(r, 450));
    expect(beats.length).toBeGreaterThan(before);
    expect((at[before] ?? Infinity) - shownAt).toBeLessThan(450);
    expect(beats.at(-1)?.visible).toBe(true);
    await v.stop();
    expect(ended).toEqual(["s1"]);
  });
});
