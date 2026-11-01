// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The `captions` scenario's pure parts: the SUBTITLES advert, the follower's parsing and timing, the publisher. */
import { describe, expect, test } from "vite-plus/test";
import { MASK_TOKEN } from "@commonair/captions";
import { CAPTIONS_STEP_RUNNERS, CUE_DEADLINE_MS, MASK_WORD, MAX_WER } from "../../src/w2/captions/index.ts";
import {
  distinctCues,
  lateSegments,
  listedSegments,
  segmentCues,
  subtitleAdvert,
  transcriptOf,
  type SeenSegment,
} from "../../src/w2/captions/live.ts";
import { speechStreamArgs } from "../../src/w2/captions/publisher.ts";
import { CAPTIONS_STEP_NUMBERS } from "../../src/w2/steps.ts";
import { REFERENCE_PATH, SPEECH_LICENSE } from "../../src/w2/captions/fixture.ts";

const MULTIVARIANT = `#EXTM3U
#EXT-X-VERSION:9

#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="source-audio",NAME="audio2",URI="audio2_stream.m3u8?t=x"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="commonair-captions",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=NO,FORCED=NO,URI="captions/en/index.m3u8?t=x"

#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=640x360,AUDIO="source-audio",SUBTITLES="commonair-captions"
video1_stream.m3u8?t=x
#EXT-X-STREAM-INF:BANDWIDTH=192000,CODECS="mp4a.40.2",SUBTITLES="commonair-captions"
audio2_stream.m3u8?t=x
`;

describe("SUBTITLES advert", () => {
  test("found with its flags and on every variant", () => {
    expect(subtitleAdvert(MULTIVARIANT)).toEqual({
      uri: "captions/en/index.m3u8?t=x",
      language: "en",
      groupId: "commonair-captions",
      isDefault: false,
      autoselect: false,
      onEveryVariant: true,
      variants: 2,
    });
  });

  test("a variant without the attribute, or no group at all", () => {
    const missing = MULTIVARIANT.replace(',SUBTITLES="commonair-captions"\naudio2', "\naudio2");
    expect(subtitleAdvert(missing)?.onEveryVariant).toBe(false);
    expect(subtitleAdvert(MULTIVARIANT.replace(/^#EXT-X-MEDIA:TYPE=SUBTITLES.*$/m, ""))).toBeNull();
  });
});

describe("subtitle follower", () => {
  const playlist = [
    "#EXTM3U",
    "#EXT-X-TARGETDURATION:3",
    "#EXT-X-MEDIA-SEQUENCE:7",
    "#EXT-X-PROGRAM-DATE-TIME:2026-11-01T12:00:21.000Z",
    "#EXTINF:3.000,",
    "7.vtt?t=x",
    "#EXT-X-PROGRAM-DATE-TIME:2026-11-01T12:00:24.000Z",
    "#EXTINF:3.000,",
    "8.vtt?t=x",
    "",
  ].join("\n");

  test("segments with their sequence and PDT", () => {
    expect(listedSegments(playlist)).toEqual([
      { sequence: 7, uri: "7.vtt?t=x", pdtMs: Date.parse("2026-11-01T12:00:21.000Z") },
      { sequence: 8, uri: "8.vtt?t=x", pdtMs: Date.parse("2026-11-01T12:00:24.000Z") },
    ]);
  });

  test("cues of a segment, deduplicated across segments, joined into a transcript", () => {
    const a = segmentCues(
      "WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n00:00:31.000 --> 00:00:32.500\nhello there\n\n00:00:33.500 --> 00:00:34.200\nacross\n",
    );
    const b = segmentCues(
      "WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n00:00:33.500 --> 00:00:34.200\nacross\n\n00:00:35.000 --> 00:00:36.000\nworld\n",
    );
    const segments: SeenSegment[] = [
      { sequence: 1, pdtMs: 0, firstSeenAt: 0, cues: a },
      { sequence: 2, pdtMs: 3000, firstSeenAt: 3000, cues: b },
    ];
    expect(distinctCues(segments).map((c) => c.text)).toEqual(["hello there", "across", "world"]);
    expect(transcriptOf(segments)).toBe("hello there across world");
  });

  test("a segment is late when listed after the playhead reached it; silent ones never count", () => {
    const cue = { text: "x", localStartMs: 0, localEndMs: 1 };
    const segs: SeenSegment[] = [
      { sequence: 1, pdtMs: 1_000, firstSeenAt: 1_000 + CUE_DEADLINE_MS, cues: [cue] },
      { sequence: 2, pdtMs: 4_000, firstSeenAt: 4_000 + CUE_DEADLINE_MS + 1, cues: [cue] },
      { sequence: 3, pdtMs: 7_000, firstSeenAt: 99_000, cues: [] },
    ];
    expect(lateSegments(segs, CUE_DEADLINE_MS).map((s) => s.sequence)).toEqual([2]);
  });
});

describe("speech publisher", () => {
  test("speech after a lead of silence, padded, over a test pattern, in real time to RTMP", () => {
    const args = speechStreamArgs({ url: "rtmp://h/live/k", audioPath: "/f/speech.ogg", loops: 3 });
    expect(args.slice(-3)).toEqual(["-f", "flv", "rtmp://h/live/k"]);
    expect(args).toContain("testsrc2=size=640x360:rate=30");
    expect(args[args.indexOf("-stream_loop") + 1]).toBe("2");
    expect(args[args.indexOf("-filter_complex") + 1]).toBe("[1:a]aresample=48000,adelay=6000:all=1,apad=pad_dur=8[a]");
    expect(args.filter((a) => a === "-readrate")).toHaveLength(2);
    expect(args).toContain("-shortest");
  });
});

describe("scenario wiring", () => {
  test("a runner for every step; thresholds as the brief sets them", () => {
    expect(Object.keys(CAPTIONS_STEP_RUNNERS).map(Number)).toEqual([...CAPTIONS_STEP_NUMBERS]);
    expect(MAX_WER).toBe(0.25);
    expect(CUE_DEADLINE_MS).toBeGreaterThanOrEqual(8_000);
    expect(CUE_DEADLINE_MS).toBeLessThanOrEqual(10_000);
    expect(MASK_TOKEN).toBe("[***]");
  });

  test("the mask word is in the reference transcript; the fixture licence is CC0", async () => {
    const reference = (await Bun.file(REFERENCE_PATH).text()).toLowerCase();
    expect(reference).toContain(MASK_WORD);
    expect(reference.split(/\s+/).length).toBeGreaterThan(60);
    expect(SPEECH_LICENSE).toContain("CC0-1.0");
  });
});
