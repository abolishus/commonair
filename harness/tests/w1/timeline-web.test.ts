// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The pure parts of `timeline-sync` step 2: reading the send frame, picking rungs, checking replay. */
import { describe, expect, it } from "vite-plus/test";
import {
  FORCED_LATENCIES,
  MEDIA_TS_TOLERANCE_MS,
  checkReplay,
  pickRenditions,
  sentFrameOf,
  type SentMarker,
} from "../../src/w1/timeline-web.ts";
import { W1_ROUTES } from "../../src/w1/selectors.ts";

const MARKER = "w1-timeline near abc";

describe("sentFrameOf", () => {
  it("reads mediaTs and playbackMode from the marker's send frame", () => {
    const frame = JSON.stringify({
      op: "send",
      channel: "c",
      body: MARKER,
      isAction: false,
      nonce: "m1",
      mediaTs: "2026-10-30T12:00:00.000Z",
    });
    expect(sentFrameOf(frame, MARKER)).toEqual({ mediaTs: "2026-10-30T12:00:00.000Z", playbackMode: null });
    expect(sentFrameOf(Buffer.from(frame), MARKER)?.mediaTs).toBe("2026-10-30T12:00:00.000Z");
    const dvr = JSON.stringify({ op: "send", body: MARKER, playbackMode: "dvr" });
    expect(sentFrameOf(dvr, MARKER)).toEqual({ mediaTs: null, playbackMode: "dvr" });
  });

  it("ignores other frames, other bodies and garbage", () => {
    expect(sentFrameOf(JSON.stringify({ op: "ping" }), MARKER)).toBeNull();
    expect(sentFrameOf(JSON.stringify({ op: "join", channel: "c" }), MARKER)).toBeNull();
    expect(sentFrameOf(JSON.stringify({ op: "send", body: "other" }), MARKER)).toBeNull();
    expect(sentFrameOf("not json", MARKER)).toBeNull();
    expect(sentFrameOf("null", MARKER)).toBeNull();
    expect(sentFrameOf("42", MARKER)).toBeNull();
  });
});

describe("pickRenditions", () => {
  it("source and the lowest advertised rung", () => {
    expect(pickRenditions(["source", "720p", "480p"])).toEqual({ near: "source", far: "480p" });
    expect(pickRenditions(["1080p", "source"])).toEqual({ near: "source", far: "1080p" });
    expect(pickRenditions(["source", "720p", "audio"])).toEqual({ near: "source", far: "720p" });
  });

  it("null while only source (or audio) is advertised", () => {
    expect(pickRenditions([])).toBeNull();
    expect(pickRenditions(["source"])).toBeNull();
    expect(pickRenditions(["source", "audio"])).toBeNull();
  });
});

describe("the channel URL with diagnostics", () => {
  it("carries targetLatency and rendition as the player reads them", () => {
    expect(W1_ROUTES.channel("river", { targetLatency: FORCED_LATENCIES.far, rendition: "480p" })).toBe(
      "/river?targetLatency=9&rendition=480p",
    );
  });
});

describe("checkReplay", () => {
  const T0 = Date.parse("2026-10-30T12:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  // The near viewer (3 s) sent first, the far viewer (9 s) a second later: far's moment is earlier.
  const sent: SentMarker[] = [
    { label: "near", marker: "m-near", mediaTs: iso(T0) },
    { label: "far", marker: "m-far", mediaTs: iso(T0 - 8_000) },
  ];
  const item = (body: string, mediaTs: number | null) => ({
    body,
    mediaTs: mediaTs === null ? null : iso(mediaTs),
    at: iso(mediaTs ?? T0),
  });

  it("passes in media-time order within the tolerance, other lines ignored", () => {
    const r = checkReplay(sent, [
      item("before", T0 - 20_000),
      item("m-far", T0 - 8_000 + 300),
      item("between", T0 - 4_000),
      item("m-near", T0 - MEDIA_TS_TOLERANCE_MS),
    ]);
    expect(r).toMatchObject({ ok: true, problems: [], order: ["far", "near"] });
    expect(r.deltaMs).toEqual({ near: -1_000, far: 300 });
  });

  it("fails in send order (not media-time order)", () => {
    const r = checkReplay(sent, [item("m-near", T0), item("m-far", T0 - 8_000)]);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/not media-time order far,near/);
  });

  it("fails past the tolerance, without mediaTs, missing or duplicated", () => {
    expect(checkReplay(sent, [item("m-far", T0 - 8_000), item("m-near", T0 + 1_001)]).problems).toEqual([
      expect.stringMatching(/^near mediaTs .* is 1001 ms/),
    ]);
    expect(checkReplay(sent, [item("m-far", T0 - 8_000), item("m-near", null)]).problems).toEqual([
      "near replayed without mediaTs",
    ]);
    expect(checkReplay(sent, [item("m-far", T0 - 8_000)]).problems).toEqual(["near missing from replay"]);
    expect(checkReplay(sent, [item("m-far", T0 - 8_000), item("m-near", T0), item("m-near", T0)]).problems).toEqual([
      "near replayed twice",
    ]);
  });
});
