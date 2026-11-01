// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Live captions in the multivariant playlist (ADR 0011): `withSubtitles` over every playlist shape the origin serves. */
import { describe, expect, test } from "vite-plus/test";
import {
  CAPTIONS_GROUP,
  filterForDataMode,
  rewritePlaylist,
  synthesizeMultivariant,
  withSubtitles,
} from "../src/playlist.ts";
import { MULTIVARIANT, rendition480, rendition720, renditionAudio } from "./fixtures.ts";

const EN = [{ language: "en", name: "English" }];
const streamInfs = (text: string) => text.split("\n").filter((l) => l.startsWith("#EXT-X-STREAM-INF:"));
const subtitleMedia = (text: string) => text.split("\n").filter((l) => l.includes("TYPE=SUBTITLES"));

describe("withSubtitles", () => {
  test("no track, no group: the playlist is returned unchanged", () => {
    expect(withSubtitles(MULTIVARIANT, [])).toBe(MULTIVARIANT);
    // A media playlist is never touched.
    expect(withSubtitles("#EXTM3U\n#EXTINF:1,\na.mp4\n", EN)).toBe("#EXTM3U\n#EXTINF:1,\na.mp4\n");
  });

  test("one SUBTITLES group, not default or autoselected, named on every variant", () => {
    const out = withSubtitles(MULTIVARIANT, EN);
    expect(subtitleMedia(out)).toEqual([
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="${CAPTIONS_GROUP}",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=NO,FORCED=NO,URI="captions/en/index.m3u8"`,
    ]);
    for (const inf of streamInfs(out)) expect(inf).toContain(`SUBTITLES="${CAPTIONS_GROUP}"`);
    // The media lines come before the first variant, the audio group is kept.
    expect(out.indexOf("TYPE=SUBTITLES")).toBeLessThan(out.indexOf("#EXT-X-STREAM-INF"));
    expect(out).toContain('TYPE=AUDIO,GROUP-ID="audio"');
  });

  test("on a synthesized ladder: namespaced groups untouched, every variant (audio-only too) gets it", () => {
    const ladder = synthesizeMultivariant([
      { rendition: "source", text: MULTIVARIANT },
      { rendition: "720p", text: rendition720 },
      { rendition: "480p", text: rendition480 },
    ]);
    const out = withSubtitles(ladder, EN);
    const infs = streamInfs(out);
    // source, 720p, 480p and the derived audio-only variant.
    expect(infs).toHaveLength(4);
    for (const inf of infs) expect(inf).toContain(`SUBTITLES="${CAPTIONS_GROUP}"`);
    expect(out).toContain('GROUP-ID="source-audio"');
    expect(out).toContain('GROUP-ID="720p-audio"');
    expect(subtitleMedia(out)).toHaveLength(1);
    const withAudio = withSubtitles(
      synthesizeMultivariant([
        { rendition: "source", text: MULTIVARIANT },
        { rendition: "audio", text: renditionAudio },
      ]),
      EN,
    );
    const audioOnly = streamInfs(withAudio).find((l) => !l.includes("RESOLUTION="));
    expect(audioOnly).toContain(`SUBTITLES="${CAPTIONS_GROUP}"`);
  });

  test("an upstream subtitles group is replaced, so variants name only the group that exists", () => {
    const upstream = MULTIVARIANT.replace(
      "#EXT-X-STREAM-INF:",
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="x",URI="x.m3u8"\n#EXT-X-STREAM-INF:SUBTITLES="subs",',
    );
    const out = withSubtitles(synthesizeMultivariant([{ rendition: "source", text: upstream }]), EN);
    expect(out).not.toContain("source-subs");
    expect(subtitleMedia(out)).toHaveLength(1);
    for (const inf of streamInfs(out)) expect(inf.match(/SUBTITLES=/g)).toHaveLength(1);
  });

  test("survives the data-mode filter in either order", () => {
    const ladder = synthesizeMultivariant([
      { rendition: "source", text: MULTIVARIANT },
      { rendition: "720p", text: rendition720 },
      { rendition: "480p", text: rendition480 },
    ]);
    const before = filterForDataMode(withSubtitles(ladder, EN), 900_000);
    const after = withSubtitles(filterForDataMode(ladder, 900_000), EN);
    for (const out of [before, after]) {
      expect(subtitleMedia(out)).toHaveLength(1);
      expect(streamInfs(out).length).toBeGreaterThan(0);
      for (const inf of streamInfs(out)) expect(inf).toContain(`SUBTITLES="${CAPTIONS_GROUP}"`);
    }
    // Audio-only budget: only the audio variant remains, still with captions.
    const audio = filterForDataMode(withSubtitles(ladder, EN), 1);
    expect(streamInfs(audio)).toHaveLength(1);
    expect(subtitleMedia(audio)).toHaveLength(1);
  });

  test("the rewrite gives the subtitle URI the viewer's token, inside the channel", () => {
    const out = rewritePlaylist(withSubtitles(MULTIVARIANT, EN), {
      dir: "live/alice",
      root: "live/alice",
      target: { kind: "relative", token: "tok" },
    });
    expect(out).toContain('URI="captions/en/index.m3u8?t=tok"');
  });

  test("a hostile name cannot break out of its attribute", () => {
    const out = withSubtitles(MULTIVARIANT, [{ language: "en", name: 'Eng"lish\n#EXT-X-X' }]);
    expect(subtitleMedia(out)[0]).toContain('NAME="English#EXT-X-X"');
  });
});
