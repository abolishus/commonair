// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { advertisedRenditions, selectRungs } from "../src/transcode/ladder.ts";

const names = (h: number | null, hasAudio = true) => selectRungs({ height: h, hasAudio }).map((r) => r.name);

describe("selectRungs", () => {
  test("a 1080p source gets every rung plus audio", () => {
    expect(names(1080)).toEqual(["1080p", "720p", "480p", "audio"]);
  });

  test("taller sources (1440p, 4K) still top out at 1080p", () => {
    expect(names(1440)).toEqual(["1080p", "720p", "480p", "audio"]);
    expect(names(2160)).toEqual(["1080p", "720p", "480p", "audio"]);
  });

  test("never upscales: rungs above the source are skipped", () => {
    expect(names(720)).toEqual(["720p", "480p", "audio"]);
    expect(names(900)).toEqual(["720p", "480p", "audio"]);
    expect(names(1079)).toEqual(["720p", "480p", "audio"]);
    expect(names(480)).toEqual(["480p", "audio"]);
  });

  test("a source below the lowest rung gets one rung at its own (even) height", () => {
    const rungs = selectRungs({ height: 361, hasAudio: true });
    expect(rungs.map((r) => r.name)).toEqual(["480p", "audio"]);
    const video = rungs[0];
    expect(video && "height" in video ? video.height : null).toBe(360);
  });

  test("audio-only and video-only sources", () => {
    expect(names(null)).toEqual(["audio"]);
    expect(names(720, false)).toEqual(["720p", "480p"]);
    expect(names(null, false)).toEqual([]);
    expect(names(0)).toEqual(["audio"]);
  });

  test("advertised renditions always lead with the source", () => {
    expect(advertisedRenditions(selectRungs({ height: 720, hasAudio: true }))).toEqual([
      "source",
      "720p",
      "480p",
      "audio",
    ]);
    expect(advertisedRenditions([])).toEqual(["source"]);
  });
});
