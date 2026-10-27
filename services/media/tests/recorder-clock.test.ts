// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The recorder applies the media clock anchor (ADR 0012 decision 4) wherever a wall-clock time
 * leaves it: the recording start, the live clip window and the VOD playlist (re-stamped when a
 * run is re-anchored). Drives one poll at a time over a hand-written ffmpeg run playlist.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { IDENTITY_CLOCK, type ClockAnchor } from "../src/clock/anchor.ts";
import type { BroadcastInfo, MediaContext } from "../src/context.ts";
import { recorderInit, recorderPlaylist } from "../src/ffmpeg/args.ts";
import { parsePlaylist } from "../src/vod/playlist.ts";
import { SegmentRecorder, VOD_PLAYLIST } from "../src/vod/recorder.ts";
import { vodPrefix } from "@commonair/contracts/storage";
import { captureLogger } from "./helpers/moderation.ts";

const BROADCAST = "0192f3a4-5b6c-7d8e-9f01-000000000001";
const VOD = "0192f3a4-5b6c-7d8e-9f01-000000000002";
const T0 = Date.parse("2026-10-27T12:00:00.000Z");

/** The private members this test drives (a poll without ffmpeg). */
interface RecorderInternals {
  runs: string[];
  pollOnce(strict: boolean): Promise<void>;
}

let workDir: string;
let puts: Map<string, string>;

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

function recorder(clock: ClockAnchor, vodId: string | null = VOD) {
  const ctx = {
    workDir,
    logger: captureLogger().logger,
    bucket: "media",
    clock,
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

/** What ffmpeg writes for one run: `count` 4 s segments from `startMs` (raw host clock). */
async function writeRun(runId: string, startMs: number, count: number) {
  const dir = join(workDir, "broadcasts", BROADCAST);
  await mkdir(dir, { recursive: true });
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:4", `#EXT-X-MAP:URI="${recorderInit(runId)}"`];
  await writeFile(join(dir, recorderInit(runId)), "init");
  for (let i = 0; i < count; i++) {
    const uri = `${runId}_${String(i).padStart(6, "0")}.m4s`;
    lines.push("#EXTINF:4.000000,", `#EXT-X-PROGRAM-DATE-TIME:${new Date(startMs + i * 4000).toISOString()}`, uri);
    await writeFile(join(dir, uri), `seg ${i}`);
  }
  await writeFile(join(dir, recorderPlaylist(runId)), `${lines.join("\n")}\n`);
}

const vodPlaylist = () => parsePlaylist(puts.get(vodPrefix(VOD, "private") + VOD_PLAYLIST) ?? "").segments;

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
    const files = (l: ReturnType<typeof rec.localWindow>) =>
      l && l !== "pending" ? { files: l.segmentPaths.map((p) => p.split("/").pop()), offset: l.offsetSeconds } : l;
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
