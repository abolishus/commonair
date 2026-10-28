// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The recorder applies the media clock anchor (ADR 0012 decision 4) wherever a wall-clock time
 * leaves it: the recording start, the live clip window and the VOD playlist (re-stamped when a
 * run is re-anchored). With W0 known it anchors each run itself (R4): `offset = W0 + first sample
 * − raw PDT`, persisted in the run's sidecar. Drives one poll at a time over hand-written ffmpeg
 * run playlists (and, for R4, real fMP4 fixtures).
 */
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { IDENTITY_CLOCK, type ClockAnchor, type MediaClock } from "../src/clock/anchor.ts";
import { createMediaClock, offlineClock } from "../src/clock/media-clock.ts";
import type { ClockMetrics } from "../src/clock/metrics.ts";
import { readSidecar } from "../src/clock/run.ts";
import { W0Error } from "../src/clock/w0.ts";
import type { BroadcastInfo, MediaContext } from "../src/context.ts";
import { recorderInit, recorderPlaylist } from "../src/ffmpeg/args.ts";
import { parsePlaylist } from "../src/vod/playlist.ts";
import { SegmentRecorder, VOD_PLAYLIST } from "../src/vod/recorder.ts";
import { vodPrefix } from "@commonair/contracts/storage";
import { captureLogger } from "./helpers/moderation.ts";

const BROADCAST = "0192f3a4-5b6c-7d8e-9f01-000000000001";
const VOD = "0192f3a4-5b6c-7d8e-9f01-000000000002";
const T0 = Date.parse("2026-10-27T12:00:00.000Z");
const FIXTURES = new URL("./fixtures/clock/", import.meta.url).pathname;

/** The private members this test drives (a poll without ffmpeg). */
interface RecorderInternals {
  runs: string[];
  pollOnce(strict: boolean): Promise<void>;
}

let workDir: string;
let puts: Map<string, string>;
const dir = () => join(workDir, "broadcasts", BROADCAST);

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "recorder-clock-"));
  puts = new Map();
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const broadcast: BroadcastInfo = {
  broadcastId: BROADCAST,
  channelId: "0192f3a4-5b6c-7d8e-9f01-000000000003",
  slug: "alice",
  path: "live/alice",
  title: "t",
  startedAt: new Date(T0),
  vodEnabled: true,
};

function recorder(clock: ClockAnchor | MediaClock, vodId: string | null = VOD) {
  const ctx = {
    workDir,
    logger: captureLogger().logger,
    bucket: "media",
    clock: "w0" in clock ? clock : offlineClock(clock),
    // A large buffer so nothing is pruned by the test's (real) clock.
    timings: { recorderPollMs: 1000, clipBufferSeconds: 10 * 365 * 86_400 },
    storage: {
      get: async () => null,
      put: async (_bucket: string, key: string, body: Uint8Array | string) => {
        puts.set(key, typeof body === "string" ? body : new TextDecoder().decode(body));
      },
    },
  } as unknown as MediaContext;
  const rec = new SegmentRecorder(ctx, broadcast, vodId, vodId ? vodPrefix(vodId, "private") : null);
  return { rec, internals: rec as unknown as RecorderInternals };
}

/**
 * What ffmpeg writes for one run: `count` segments of `seconds` from `startMs` (raw host clock).
 * `fixture`: copy real fMP4 init/segments (`nob_*`, 0.5 s each) instead of placeholder bytes.
 */
async function writeRun(runId: string, startMs: number, count: number, opts: { fixture?: boolean } = {}) {
  const seconds = opts.fixture ? 0.5 : 4;
  await mkdir(dir(), { recursive: true });
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:4", `#EXT-X-MAP:URI="${recorderInit(runId)}"`];
  if (opts.fixture) await copyFile(join(FIXTURES, "nob_init.mp4"), join(dir(), recorderInit(runId)));
  else await writeFile(join(dir(), recorderInit(runId)), "init");
  for (let i = 0; i < count; i++) {
    const uri = `${runId}_${String(i).padStart(6, "0")}.m4s`;
    lines.push(
      `#EXTINF:${seconds.toFixed(6)},`,
      `#EXT-X-PROGRAM-DATE-TIME:${new Date(startMs + i * seconds * 1000).toISOString()}`,
      uri,
    );
    if (opts.fixture) await copyFile(join(FIXTURES, `nob_${i}.m4s`), join(dir(), uri));
    else await writeFile(join(dir(), uri), `seg ${i}`);
  }
  await writeFile(join(dir(), recorderPlaylist(runId)), `${lines.join("\n")}\n`);
}

const vodPlaylist = () => parsePlaylist(puts.get(vodPrefix(VOD, "private") + VOD_PLAYLIST) ?? "").segments;
const files = (l: ReturnType<SegmentRecorder["localWindow"]>) =>
  l && l !== "pending" ? { files: l.segmentPaths.map((p) => p.split("/").pop()), offset: l.offsetSeconds } : l;

/** Real clock with a scripted W0 source and recorded metrics. */
function liveClock(w0: () => Promise<number>) {
  const seen = { offset: [] as number[], residual: [] as number[] };
  const metrics: ClockMetrics = {
    recorderOffset: (ms) => seen.offset.push(ms),
    recorderResidual: (ms) => seen.residual.push(ms),
    w0Failure: () => {},
    w0Drift: () => {},
  };
  const clock = createMediaClock({
    hlsBase: "http://m",
    password: "p",
    logger: captureLogger().logger,
    metrics,
    fetchW0: async () => ({
      w0Ms: await w0(),
      handler: "vide",
      sample: { pdtMs: 0, baseDecodeTime: 0, compositionOffset: 0, timescale: 90_000 },
    }),
  });
  return { clock, seen };
}

/** Let the recorder's background W0 fetch settle. */
const settle = () => new Promise((r) => setTimeout(r, 10));

describe("recorder clock anchor", () => {
  test("identity anchor: playlist times are the raw times", async () => {
    const { internals } = recorder(IDENTITY_CLOCK);
    internals.runs.push("r1");
    await writeRun("r1", T0, 3);
    await internals.pollOnce(true);
    expect(vodPlaylist().map((s) => s.startedAt?.getTime())).toEqual([T0, T0 + 4000, T0 + 8000]);
  });

  test("the offset is applied per run, in the playlist and the live window", async () => {
    const offsets: Record<string, number> = { r1: 250, r2: -1500 };
    const calls: [string, string][] = [];
    const clock: ClockAnchor = {
      offsetMs: (b, r) => {
        calls.push([b, r]);
        return offsets[r] ?? 0;
      },
    };
    const { rec, internals } = recorder(clock);
    internals.runs.push("r1", "r2");
    await writeRun("r1", T0, 2);
    await writeRun("r2", T0 + 20_000, 2);
    await internals.pollOnce(true);

    expect(calls.every(([b]) => b === BROADCAST)).toBe(true);
    expect(vodPlaylist().map((s) => [s.uri, s.startedAt?.getTime()])).toEqual([
      ["r1_000000.m4s", T0 + 250],
      ["r1_000001.m4s", T0 + 4250],
      ["r2_000000.m4s", T0 + 18_500],
      ["r2_000001.m4s", T0 + 22_500],
    ]);

    // Clip windows are asked for on the broadcast clock: r2's first segment starts at +18.5 s.
    expect(files(rec.localWindow(new Date(T0 + 18_500), 4))).toEqual({ files: ["r2_000000.m4s"], offset: 0 });
    // The recording starts at r1's anchored start (+250 ms), not its raw one: a clip asked from
    // +100 ms starts at the first segment.
    expect(files(rec.localWindow(new Date(T0 + 100), 1))).toEqual({ files: ["r1_000000.m4s"], offset: 0 });
  });

  test("a re-anchored run is re-stamped on the next poll without new segments", async () => {
    let offset = 0;
    const { internals } = recorder({ offsetMs: () => offset });
    internals.runs.push("r1");
    await writeRun("r1", T0, 2);
    await internals.pollOnce(true);
    expect(vodPlaylist()[0]?.startedAt?.getTime()).toBe(T0);

    offset = 400;
    puts.clear();
    await internals.pollOnce(true);
    expect(vodPlaylist().map((s) => s.startedAt?.getTime())).toEqual([T0 + 400, T0 + 4400]);

    // Unchanged anchor and no new segments: the playlist is not uploaded again.
    puts.clear();
    await internals.pollOnce(true);
    expect(puts.size).toBe(0);
  });

  test("the recording start follows an offset that changes after the first segment (no stale start)", async () => {
    let offset = 0;
    const { rec, internals } = recorder({ offsetMs: () => offset });
    internals.runs.push("r1");
    await writeRun("r1", T0, 3);
    await internals.pollOnce(true);
    // A window asked from before the recording is clamped to its start: T0 at offset 0.
    expect(files(rec.localWindow(new Date(T0 - 1500), 1))).toEqual({ files: ["r1_000000.m4s"], offset: 0 });

    // W0 arrives late and moves the run 2 s earlier: the recording now starts at T0 − 2 s, so
    // the same request starts 0.5 s into the first segment. A start stamped once and kept would
    // still clamp it to T0, 2 s into the segment.
    offset = -2000;
    expect(files(rec.localWindow(new Date(T0 - 1500), 1))).toEqual({ files: ["r1_000000.m4s"], offset: 0.5 });
    expect(files(rec.localWindow(new Date(T0 - 5000), 1))).toEqual({ files: ["r1_000000.m4s"], offset: 0 });
  });

  test("without a VOD nothing is uploaded, and nothing before the first segment", async () => {
    const { internals } = recorder({ offsetMs: () => 1000 }, null);
    internals.runs.push("r1");
    await writeRun("r1", T0, 1);
    await internals.pollOnce(true);
    expect(puts.size).toBe(0);

    const withVod = recorder({ offsetMs: () => 1000 });
    withVod.internals.runs.push("r9");
    await withVod.internals.pollOnce(true);
    expect(puts.size).toBe(0);
  });
});

describe("R4: the recorder anchors its own runs from W0", () => {
  // nob_0's first sample is at 50000 s on the source timeline, nob_1's at 50000.5 s.
  const W0 = T0 - 50_000_000 + 300;

  test("W0 known: the run's offset comes from its first segment, before anything is published", async () => {
    const { clock, seen } = liveClock(async () => W0);
    const { rec, internals } = recorder(clock);
    internals.runs.push("r1");
    await mkdir(dir(), { recursive: true }); // start() creates it
    await internals.pollOnce(true); // asks for W0 (no segments yet)
    await settle();
    expect(await readSidecar(dir(), "r1")).toEqual({ runId: "r1", w0Ms: W0, offsetMs: null });

    await writeRun("r1", T0, 2, { fixture: true });
    await internals.pollOnce(true);
    expect(clock.offsetMs(BROADCAST, "r1")).toBeCloseTo(300, 6);
    expect(await readSidecar(dir(), "r1")).toEqual({ runId: "r1", w0Ms: W0, offsetMs: 300 });
    // The very first upload is already stamped.
    expect(vodPlaylist().map((s) => s.startedAt?.getTime())).toEqual([T0 + 300, T0 + 800]);
    expect(files(rec.localWindow(new Date(T0 + 300), 0.5))).toEqual({ files: ["r1_000000.m4s"], offset: 0 });
    // One offset per run; the second segment's own sample time agrees with it (residual 0).
    expect(seen.offset).toEqual([300]);
    expect(seen.residual).toHaveLength(1);
    expect(seen.residual[0]).toBeCloseTo(0, 6);
  });

  test("W0 unknown: raw times (offset 0); when it arrives the run is re-stamped from disk", async () => {
    let available = false;
    const { clock } = liveClock(async () => {
      if (!available) throw new W0Error("multivariant playlist of live/alice: HTTP 404", "http");
      return W0;
    });
    const { internals } = recorder(clock);
    internals.runs.push("r1");
    await writeRun("r1", T0, 2, { fixture: true });
    await internals.pollOnce(true);
    await settle();
    expect(clock.offsetMs(BROADCAST, "r1")).toBe(0);
    expect(vodPlaylist().map((s) => s.startedAt?.getTime())).toEqual([T0, T0 + 500]);
    expect(await readSidecar(dir(), "r1")).toBeNull();

    // The recorder waits before asking again after a failure; skip the wait.
    available = true;
    (internals as unknown as { clocks: Map<string, { nextW0At: number }> }).clocks.get("r1")!.nextW0At = 0;
    await internals.pollOnce(true); // fetches W0 in the background
    await settle();
    await internals.pollOnce(true); // anchors from the oldest local segment, re-stamps the playlist
    expect(clock.offsetMs(BROADCAST, "r1")).toBeCloseTo(300, 6);
    expect(vodPlaylist().map((s) => s.startedAt?.getTime())).toEqual([T0 + 300, T0 + 800]);
    expect((await readSidecar(dir(), "r1"))?.offsetMs).toBeCloseTo(300, 6);
  });

  test("an unreadable segment leaves the run on raw times after a few tries", async () => {
    const { clock } = liveClock(async () => W0);
    const { internals } = recorder(clock);
    internals.runs.push("r1");
    await internals.pollOnce(true);
    await settle();
    await writeRun("r1", T0, 2); // placeholder bytes, not fMP4
    for (let i = 0; i < 4; i++) await internals.pollOnce(true);
    expect(clock.offsetMs(BROADCAST, "r1")).toBe(0);
    expect(vodPlaylist().map((s) => s.startedAt?.getTime())).toEqual([T0, T0 + 4000]);
  });
});
