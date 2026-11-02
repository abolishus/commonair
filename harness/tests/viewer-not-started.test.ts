// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import type { ProbeVideoStats } from "../player/probe.ts";
import { playerState, webProbe } from "../src/browser-viewer.ts";
import { emptyReport, notStarted } from "../src/viewer.ts";

// Main CI run 41504412484 failed viewers on "every viewer started playback" {"started":20,"total":21}
// with nothing saying which of the 21 (harness-page Chromium/WebKit, P2P web Chromium, HTTP).
describe("notStarted", () => {
  const viewers = [
    { id: "chromium-0-p0", kind: "browser" as const },
    { id: "chromium-0-v0", kind: "browser" as const },
    { id: "http-1", kind: "http" as const },
  ];

  test("lists only the rejected viewers, with their kind and the rejection's message", () => {
    const results: PromiseSettledResult<number>[] = [
      { status: "fulfilled", value: 900 },
      { status: "rejected", reason: new Error("first frame in chromium viewer chromium-0-v0 timed out") },
      { status: "rejected", reason: "socket closed" },
    ];
    expect(notStarted(viewers, results, (i) => (i === 1 ? "p2p-opted-in" : undefined))).toEqual([
      {
        viewer: "chromium-0-v0",
        kind: "p2p-opted-in",
        reason: "first frame in chromium viewer chromium-0-v0 timed out",
      },
      { viewer: "http-1", kind: "http", reason: "socket closed" },
    ]);
  });

  test("is empty when every viewer started", () => {
    expect(notStarted(viewers, [{ status: "fulfilled", value: 1 }])).toEqual([]);
    expect(notStarted([], [])).toEqual([]);
  });

  test("caps a long reason and survives a result without a viewer", () => {
    const [only] = notStarted([], [{ status: "rejected", reason: new Error("x".repeat(2_000)) }]);
    expect(only?.viewer).toBe("#0");
    expect(only?.kind).toBe("unknown");
    expect(only?.reason).toHaveLength(600);
  });
});

const probe = (id: string, over: Partial<ProbeVideoStats> = {}): ProbeVideoStats => ({
  id,
  startedAt: null,
  ttffMs: null,
  stalls: 0,
  stallMs: 0,
  playedSeconds: 0,
  latencyMs: [],
  width: 0,
  height: 0,
  currentTime: 0,
  bytesHttp: 0,
  bytesP2p: 0,
  errors: [],
  connected: true,
  ...over,
});

describe("webProbe", () => {
  test("the embed's one video", () => {
    expect(webProbe([probe("v0", { ttffMs: 800 })])?.id).toBe("v0");
  });

  test("a remounted player: the element still in the document, not the detached v0", () => {
    expect(webProbe([probe("v0", { connected: false }), probe("v1")])?.id).toBe("v1");
    expect(webProbe([probe("v0", { connected: false }), probe("v1", { ttffMs: 1_200 })])?.ttffMs).toBe(1_200);
  });

  test("of several connected videos, one that showed a frame", () => {
    expect(webProbe([probe("v0"), probe("v1", { ttffMs: 500 }), probe("v2")])?.id).toBe("v1");
  });

  test("falls back to the first entry when nothing is connected, and to nothing on an empty page", () => {
    expect(webProbe([probe("v0", { connected: false })])?.id).toBe("v0");
    expect(webProbe([])).toBeUndefined();
  });
});

describe("playerState with the web page's state", () => {
  test("names the player's data-state and the videos the probe tracks", () => {
    const r = emptyReport("c", "browser", "chromium");
    expect(playerState(r, { player: "error", videos: 1, connected: 1 })).toBe(
      "no player errors; path=none session=none source=none bytes=0 stalls=0 heartbeats=0; player=error videos=1 connected=1",
    );
    expect(playerState({ ...r, errors: ["hls.js x"] }, { player: null, videos: 0, connected: 0 })).toBe(
      "player errors: hls.js x; player=missing videos=0 connected=0",
    );
  });

  test("harness pages carry no web state", () => {
    expect(playerState(emptyReport("c", "browser", "webkit"), null)).not.toContain("player=");
  });
});
