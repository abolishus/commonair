// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  MAX_STARTUP_NON_FATAL,
  copyStartup,
  emptyStartup,
  formatStartup,
  recordMilestone,
  recordNonFatal,
  urlPath,
} from "../player/startup.ts";
import { MAX_TTFF_MS, ttffDetails } from "../scenarios/_ingest.ts";
import { playerState } from "../src/browser-viewer.ts";
import { emptyReport } from "../src/viewer.ts";

// ingest-whip's TTFF assertion failed on CI with only {"ttff": …}: nothing said whether the time
// went to the session, the playlists, GAP fragments or the decoder (docs/operators/flakes.md).
describe("start-up timeline", () => {
  test("keeps milestones in the order they happened, rounded, each only the first time", () => {
    const t = emptyStartup();
    expect(recordMilestone(t, "session", 101.4)).toBe(true);
    expect(recordMilestone(t, "manifest", 250.6)).toBe(true);
    expect(recordMilestone(t, "level-audio", 300)).toBe(true);
    expect(recordMilestone(t, "level-video", 310)).toBe(true);
    expect(recordMilestone(t, "level-video", 1_310)).toBe(false);
    expect(recordMilestone(t, "frag-video", 400, { sn: 12, gap: false })).toBe(true);
    expect(recordMilestone(t, "frag-video", 500, { sn: 13, gap: false })).toBe(false);
    expect(recordMilestone(t, "frag-audio", 450, { sn: "initSegment" })).toBe(true);
    expect(t.events).toEqual([
      { event: "session", at: 101 },
      { event: "manifest", at: 251 },
      { event: "level-audio", at: 300 },
      { event: "level-video", at: 310 },
      { event: "frag-video", at: 400, sn: 12, gap: false },
      { event: "frag-audio", at: 450, sn: "initSegment" },
    ]);
  });

  test("records nothing after the first frame", () => {
    const t = emptyStartup();
    recordMilestone(t, "manifest", 10);
    recordNonFatal(t, 20, { details: "fragGap", url: "http://o/live/a/video.m3u8" });
    expect(recordMilestone(t, "first-frame", 900)).toBe(true);
    expect(recordMilestone(t, "frag-audio", 950, { sn: 3 })).toBe(false);
    expect(recordMilestone(t, "first-frame", 1_000)).toBe(false);
    recordNonFatal(t, 1_000, { details: "fragLoadError", code: 404 });
    expect(t.events.map((e) => e.event)).toEqual(["manifest", "first-frame"]);
    expect(t.nonFatal).toHaveLength(1);
    expect(t.nonFatalDropped).toBe(0);
  });

  test("caps the non-fatal errors, keeping the earliest and counting the rest", () => {
    const t = emptyStartup();
    for (let i = 0; i < MAX_STARTUP_NON_FATAL + 7; i++) recordNonFatal(t, i, { details: `e${i}` });
    expect(t.nonFatal).toHaveLength(MAX_STARTUP_NON_FATAL);
    expect(t.nonFatal[0]?.details).toBe("e0");
    expect(t.nonFatal.at(-1)?.details).toBe(`e${MAX_STARTUP_NON_FATAL - 1}`);
    expect(t.nonFatalDropped).toBe(7);
  });

  test("keeps a request's path, never its query (the playback token), and only real status codes", () => {
    const t = emptyStartup();
    recordNonFatal(t, 5.6, {
      details: "levelLoadError",
      code: 503,
      url: "https://o.test/live/ch/video.m3u8?t=SECRET&_HLS_msn=4",
    });
    recordNonFatal(t, 7, { details: "fragGap", code: 0, url: null });
    recordNonFatal(t, 8, { details: "bufferStalledError", url: "not a url" });
    expect(t.nonFatal).toEqual([
      { at: 6, details: "levelLoadError", code: 503, path: "/live/ch/video.m3u8" },
      { at: 7, details: "fragGap", code: null, path: null },
      { at: 8, details: "bufferStalledError", code: null, path: null },
    ]);
    expect(JSON.stringify(t)).not.toContain("SECRET");
  });

  test("urlPath", () => {
    expect(urlPath("http://h/a/b.m4s?t=x#f")).toBe("/a/b.m4s");
    expect(urlPath(undefined)).toBeNull();
    expect(urlPath("")).toBeNull();
    expect(urlPath("relative/path")).toBeNull();
  });

  test("a copy does not follow later changes", () => {
    const t = emptyStartup();
    recordMilestone(t, "session", 1);
    const c = copyStartup(t);
    recordMilestone(t, "manifest", 2);
    recordNonFatal(t, 3, { details: "x" });
    expect(c).toEqual({ events: [{ event: "session", at: 1 }], nonFatal: [], nonFatalDropped: 0 });
  });
});

describe("formatStartup", () => {
  test("lists milestones with fragment tags and groups repeated non-fatal errors", () => {
    const t = emptyStartup();
    recordMilestone(t, "session", 120);
    recordMilestone(t, "manifest", 480);
    recordNonFatal(t, 600, { details: "fragGap", url: "http://o/live/x/video_1.m4s?t=a" });
    recordNonFatal(t, 650, { details: "levelLoadError", code: 503, url: "http://o/live/x/audio.m3u8?t=a" });
    recordNonFatal(t, 700, { details: "fragGap", url: "http://o/live/x/video_1.m4s?t=b" });
    recordMilestone(t, "frag-video", 900, { sn: 12, gap: true });
    recordMilestone(t, "frag-audio", 950, { sn: 7, gap: false });
    recordMilestone(t, "first-frame", 1_300);
    expect(formatStartup(t)).toBe(
      "session@120 manifest@480 frag-video@900(sn=12,gap) frag-audio@950(sn=7,media) first-frame@1300; " +
        "non-fatal: fragGap@600 /live/x/video_1.m4s ×2, levelLoadError@650 503 /live/x/audio.m3u8",
    );
  });

  test("says when there was nothing, and how many errors were dropped", () => {
    expect(formatStartup(null)).toBe("no start-up timeline");
    expect(formatStartup(undefined)).toBe("no start-up timeline");
    expect(formatStartup(emptyStartup())).toBe("no start-up events; no non-fatal errors");
    const t = emptyStartup();
    for (let i = 0; i < MAX_STARTUP_NON_FATAL + 2; i++) recordNonFatal(t, 1, { details: "fragGap" });
    expect(formatStartup(t)).toBe(`no start-up events; non-fatal: fragGap@1 ×${MAX_STARTUP_NON_FATAL} (+2 more)`);
  });
});

describe("the TTFF assertion's details", () => {
  test("carry the viewer's path, start-up timeline, last five errors, bytes and stalls", () => {
    const startup = emptyStartup();
    recordMilestone(startup, "session", 50);
    recordMilestone(startup, "first-frame", 16_000);
    const r = {
      ...emptyReport("chromium-0-p0", "browser", "chromium"),
      playbackPath: "mse" as const,
      bytesHttp: 3_300_000,
      stalls: 1,
      errors: ["e1", "e2", "e3", "e4", "e5", "e6"],
      startup,
    };
    expect(ttffDetails(MAX_TTFF_MS + 1_000, r)).toEqual({
      ttff: 16_000,
      playbackPath: "mse",
      startup: "session@50 first-frame@16000; no non-fatal errors",
      lastErrors: ["e2", "e3", "e4", "e5", "e6"],
      bytesHttp: 3_300_000,
      stalls: 1,
    });
  });

  test("a viewer without a timeline (web or HTTP) says so", () => {
    expect(ttffDetails(1, emptyReport("http-0", "http", "http")).startup).toBeNull();
  });
});

describe("a first-frame timeout names how far start-up got", () => {
  test("appends the harness page's timeline to the player state", () => {
    const startup = emptyStartup();
    recordMilestone(startup, "manifest", 300);
    recordNonFatal(startup, 400, { details: "fragGap" });
    const r = { ...emptyReport("c", "browser", "chromium"), startup };
    expect(playerState(r)).toBe(
      "no player errors; path=none session=none source=none bytes=0 stalls=0 heartbeats=0; " +
        "startup: manifest@300; non-fatal: fragGap@400",
    );
    expect(playerState({ ...r, errors: ["hls.js x"] })).toBe(
      "player errors: hls.js x; startup: manifest@300; non-fatal: fragGap@400",
    );
    expect(playerState(emptyReport("c", "browser", "chromium"))).not.toContain("startup");
  });
});
