// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** ADR 0018 decision 5: the data-mode filter over the synthesized multivariant playlist. */
import { describe, expect, test } from "vite-plus/test";
import { dataModeCeilingBps } from "@commonair/contracts/enums";
import { AUDIO_ONLY_BANDWIDTH, filterForDataMode, stripLowLatency, synthesizeMultivariant } from "../src/playlist.ts";
import { MEDIA, MULTIVARIANT, rendition480, rendition720, renditionAudio } from "./fixtures.ts";

/** `[BANDWIDTH, uri]` per variant, in listed order. */
function variants(text: string): [number, string][] {
  const lines = text.split("\n");
  const out: [number, string][] = [];
  lines.forEach((l, i) => {
    if (l.startsWith("#EXT-X-STREAM-INF:")) out.push([Number(/BANDWIDTH=(\d+)/.exec(l)?.[1]), lines[i + 1] ?? ""]);
  });
  return out;
}
const mediaLines = (text: string) => text.split("\n").filter((l) => l.startsWith("#EXT-X-MEDIA:"));

// A full ladder as the media service publishes it (720p and 480p from the fixtures, the source at
// 2.1 Mbit/s) with the derived audio-only variant at AUDIO_ONLY_BANDWIDTH.
const derivedLadder = synthesizeMultivariant([
  { rendition: "source", text: MULTIVARIANT },
  { rendition: "720p", text: rendition720 },
  { rendition: "480p", text: rendition480 },
]);
// The same ladder with the `audio` rung (140 kbit/s measured) in place of the derived variant.
const audioRungLadder = synthesizeMultivariant([
  { rendition: "source", text: MULTIVARIANT },
  { rendition: "720p", text: rendition720 },
  { rendition: "480p", text: rendition480 },
  { rendition: "audio", text: renditionAudio },
]);
const sourceOnly = synthesizeMultivariant([{ rendition: "source", text: MULTIVARIANT }]);

describe("filterForDataMode", () => {
  test("keeps video variants at or under the ceiling and the audio-only variant, in order", () => {
    expect(variants(filterForDataMode(derivedLadder, 1_400_000))).toEqual([
      [1_400_000, "720p/video1_stream.m3u8?session=aaaa"],
      [800_000, "480p/video1_stream.m3u8?session=bbbb"],
      [AUDIO_ONLY_BANDWIDTH, expect.stringMatching(/^audio2_stream\.m3u8/)],
    ]);
    expect(variants(filterForDataMode(derivedLadder, 1_399_999)).map(([b]) => b)).toEqual([
      800_000,
      AUDIO_ONLY_BANDWIDTH,
    ]);
    expect(variants(filterForDataMode(derivedLadder, 8_000_000)).map(([b]) => b)).toEqual([
      2_117_768,
      1_400_000,
      800_000,
      AUDIO_ONLY_BANDWIDTH,
    ]);
  });

  test("the presets against a ladder with the audio rung", () => {
    const at = (mb: number) => variants(filterForDataMode(audioRungLadder, dataModeCeilingBps(mb))).map(([b]) => b);
    expect(at(50)).toEqual([140_000]);
    expect(at(800)).toEqual([1_400_000, 800_000, 140_000]);
    expect(at(1900)).toEqual([2_117_768, 1_400_000, 800_000, 140_000]);
  });

  test("the audio-only variant is kept even above the ceiling (it is the floor)", () => {
    const out = filterForDataMode(derivedLadder, 32_000);
    expect(variants(out)).toEqual([[AUDIO_ONLY_BANDWIDTH, expect.stringMatching(/^audio2_stream\.m3u8/)]]);
  });

  test("no video variant fits: audio-only is listed first", () => {
    const out = filterForDataMode(audioRungLadder, 100_000);
    expect(variants(out)[0]?.[1]).toBe("audio/audio1_stream.m3u8?session=cccc");
    // A ladder listing audio last still starts with audio once video is filtered out.
    const ordered = variants(audioRungLadder).map(([b]) => b);
    expect(ordered.at(-1)).toBe(140_000);
  });

  test("a source-only channel keeps its derived audio-only variant under a small budget", () => {
    expect(variants(filterForDataMode(sourceOnly, dataModeCeilingBps(50)))).toEqual([
      [AUDIO_ONLY_BANDWIDTH, expect.stringMatching(/^audio2_stream\.m3u8/)],
    ]);
    // The source fits a large budget and is kept with the audio floor.
    expect(variants(filterForDataMode(sourceOnly, dataModeCeilingBps(1900))).map(([b]) => b)).toEqual([
      2_117_768,
      AUDIO_ONLY_BANDWIDTH,
    ]);
  });

  test("media groups no kept variant references are dropped; referenced ones stay", () => {
    const low = filterForDataMode(derivedLadder, 1_000_000);
    expect(mediaLines(low)).toEqual([]);
    const mid = filterForDataMode(derivedLadder, 1_400_000);
    expect(mediaLines(mid)).toHaveLength(1);
    expect(mediaLines(mid)[0]).toContain('GROUP-ID="720p-audio"');
    const all = filterForDataMode(derivedLadder, 8_000_000);
    expect(mediaLines(all)).toEqual(mediaLines(derivedLadder));
  });

  test("header lines are kept", () => {
    const out = filterForDataMode(derivedLadder, 100_000);
    expect(out.startsWith("#EXTM3U\n#EXT-X-VERSION:10\n#EXT-X-INDEPENDENT-SEGMENTS\n")).toBe(true);
  });

  test("a ladder with no audio-only variant and nothing under the ceiling keeps its lowest variant", () => {
    const videoOnly = synthesizeMultivariant([
      { rendition: "720p", text: rendition720 },
      { rendition: "480p", text: rendition480 },
    ]);
    expect(variants(filterForDataMode(videoOnly, 100_000))).toEqual([
      [800_000, "480p/video1_stream.m3u8?session=bbbb"],
    ]);
  });

  test("CRLF input and a playlist without variants", () => {
    expect(variants(filterForDataMode(derivedLadder.replaceAll("\n", "\r\n"), 900_000)).map(([b]) => b)).toEqual([
      800_000,
      AUDIO_ONLY_BANDWIDTH,
    ]);
    expect(variants(filterForDataMode("#EXTM3U\n", 100_000))).toEqual([]);
  });
});

describe("stripLowLatency", () => {
  const stripped = stripLowLatency(MEDIA);
  const lines = stripped.split("\n");

  test("drops parts, preload hints, rendition reports, PART-INF and SERVER-CONTROL", () => {
    for (const tag of ["#EXT-X-PART", "#EXT-X-PRELOAD-HINT", "#EXT-X-RENDITION-REPORT", "#EXT-X-SERVER-CONTROL"])
      expect(stripped).not.toContain(tag);
  });

  test("keeps the map, every complete segment, their durations and PDT", () => {
    expect(lines.filter((l) => l !== "" && !l.startsWith("#")).map((l) => l.split("?")[0])).toEqual([
      "54dd20fd99ec_video1_seg33.mp4",
      "54dd20fd99ec_video1_seg34.mp4",
      "54dd20fd99ec_video1_seg35.mp4",
    ]);
    expect(stripped).toContain("#EXT-X-MAP:URI=");
    expect(stripped).toContain("#EXT-X-PROGRAM-DATE-TIME:2026-10-18T21:21:42.825Z");
    expect(lines.filter((l) => l.startsWith("#EXTINF"))).toHaveLength(3);
    expect(stripped).toContain("#EXT-X-MEDIA-SEQUENCE:33");
    expect(stripped).toContain("#EXT-X-TARGETDURATION:1");
  });

  test("tags of the in-progress segment (parts only, no EXTINF yet) go with it; ENDLIST stays", () => {
    const inProgress = `${MEDIA.trimEnd()}\n#EXT-X-PROGRAM-DATE-TIME:2026-10-18T21:21:43.825Z\n#EXT-X-PART:DURATION=0.20000,URI="p158.mp4"\n`;
    const out = stripLowLatency(inProgress);
    expect(out).not.toContain("21:21:43.825Z");
    expect(out.trimEnd().endsWith("54dd20fd99ec_video1_seg35.mp4?session=5565db7c-d34e-4a36-adf9-30f3d705b919")).toBe(
      true,
    );
    expect(stripLowLatency(`${MEDIA}#EXT-X-ENDLIST\n`)).toContain("#EXT-X-ENDLIST");
  });

  test("a playlist with parts only (no complete segment yet) keeps its header", () => {
    const out = stripLowLatency('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-PART:DURATION=0.2,URI="p1.mp4"\n');
    expect(out).toContain("#EXT-X-TARGETDURATION:1");
    expect(out).not.toContain("p1.mp4");
  });
});
