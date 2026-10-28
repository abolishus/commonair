// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Crash recovery on the broadcast clock (ADR 0012, R4): a crashed recorder leaves published
 * segments (stamped, or raw if W0 came late) and local run playlists (always raw). Recovery stamps
 * each local run from its sidecar before ordering and rendering, re-stamps that run's published
 * segments from the same raw times, and leaves a run without a sidecar offset raw.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { vodPrefix } from "@commonair/contracts/storage";
import type { Database } from "@commonair/db";
import type { ObjectStorage } from "@commonair/storage";
import { createMediaClock } from "../src/clock/media-clock.ts";
import { writeSidecar } from "../src/clock/run.ts";
import { recorderInit, recorderPlaylist } from "../src/ffmpeg/args.ts";
import { recoverWorkDir, stampRecovery, type LocalRun } from "../src/recovery.ts";
import { parsePlaylist, renderPlaylist, type PlaylistSegment } from "../src/vod/playlist.ts";
import { VOD_PLAYLIST } from "../src/vod/recorder.ts";
import { captureLogger } from "./helpers/moderation.ts";

const BROADCAST = "0192f3a4-5b6c-7d8e-9f01-0000000000c1";
const VOD = "0192f3a4-5b6c-7d8e-9f01-0000000000c2";
const PREFIX = vodPrefix(VOD, "private");
const T0 = Date.parse("2026-10-27T12:00:00.000Z");

const seg = (runId: string, i: number, at: number): PlaylistSegment => ({
  uri: `${runId}_${String(i).padStart(6, "0")}.m4s`,
  durationSeconds: 4,
  startedAt: new Date(at),
  map: recorderInit(runId),
});
const run = (runId: string, startMs: number, count: number): LocalRun => ({
  runId,
  segments: Array.from({ length: count }, (_, i) => seg(runId, i, startMs + i * 4000)),
});
const times = (s: readonly PlaylistSegment[]) => s.map((x) => [x.uri, x.startedAt ? x.startedAt.getTime() - T0 : null]);

describe("stampRecovery", () => {
  test("local runs with an offset are stamped; published segments of those runs re-stamped; others kept", () => {
    const published = [
      seg("r1", 0, T0 + 300), // stamped by the crashed process
      seg("r1", 1, T0 + 4000), // uploaded before W0 arrived: raw
      seg("r0", 0, T0 - 9000), // an earlier run, no longer on disk: untouched
    ];
    const runs = [run("r1", T0, 3), run("r2", T0 + 20_000, 2)];
    const out = stampRecovery(published, runs, new Map([["r1", 300]]));
    expect(times(out.published)).toEqual([
      ["r1_000000.m4s", 300],
      ["r1_000001.m4s", 4300],
      ["r0_000000.m4s", -9000],
    ]);
    expect(times(out.runs[0]?.segments ?? [])).toEqual([
      ["r1_000000.m4s", 300],
      ["r1_000001.m4s", 4300],
      ["r1_000002.m4s", 8300],
    ]);
    // No sidecar offset: raw.
    expect(times(out.runs[1]?.segments ?? [])).toEqual([
      ["r2_000000.m4s", 20_000],
      ["r2_000001.m4s", 24_000],
    ]);
    expect(out.rawRuns).toBe(1);
  });
});

describe("recoverWorkDir on the broadcast clock", () => {
  let workDir: string;
  let objects: Map<string, string>;
  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "clock-recovery-"));
    objects = new Map();
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  /** The two queries recovery makes: no T0 case, then the broadcast's recording VOD. */
  function fakeDb(): Database {
    let n = 0;
    const answer = async () => (n++ % 2 === 0 ? [] : [{ id: VOD, status: "recording", storagePrefix: PREFIX }]);
    return { select: () => ({ from: () => ({ where: () => ({ limit: answer }) }) }) } as unknown as Database;
  }
  const storage = {
    get: async (_b: string, key: string) => {
      const v = objects.get(key);
      return v === undefined ? null : new Response(v);
    },
    put: async (_b: string, key: string, body: Uint8Array | string) => {
      objects.set(key, typeof body === "string" ? body : new TextDecoder().decode(body));
    },
  } as unknown as ObjectStorage;

  async function writeLocalRun(dir: string, r: LocalRun, files: number[]) {
    await writeFile(join(dir, recorderInit(r.runId)), "init");
    for (const i of files) await writeFile(join(dir, r.segments[i]?.uri ?? ""), `seg ${i}`);
    await writeFile(join(dir, recorderPlaylist(r.runId)), renderPlaylist(r.segments, { ended: false }));
  }

  test("published stamped + raw local runs render one monotonic, fully stamped playlist; a sidecar-less run stays raw", async () => {
    const dir = join(workDir, "broadcasts", BROADCAST);
    await mkdir(dir, { recursive: true });
    // Published by the crashed process: r1's first segment stamped (+300), its second still raw.
    objects.set(
      PREFIX + VOD_PLAYLIST,
      renderPlaylist([seg("r1", 0, T0 + 300), seg("r1", 1, T0 + 4000)], { ended: false }),
    );
    const r1 = run("r1", T0, 3); // offset +300 in its sidecar
    const r2 = run("r2", T0 + 12_100, 2); // crashed before W0: no sidecar
    const r3 = run("r3", T0 + 21_000, 2); // offset −1000: its raw times overlap nothing once stamped
    await writeLocalRun(dir, r1, [2]);
    await writeLocalRun(dir, r2, [0, 1]);
    await writeLocalRun(dir, r3, [0, 1]);
    await writeSidecar(dir, { runId: "r1", w0Ms: 1, offsetMs: 300 });
    await writeSidecar(dir, { runId: "r2", w0Ms: null, offsetMs: null });
    await writeSidecar(dir, { runId: "r3", w0Ms: 1, offsetMs: -1000 });

    const cap = captureLogger();
    const clock = createMediaClock({ hlsBase: "http://m", password: "p", logger: cap.logger });
    const result = await recoverWorkDir({ clock, db: fakeDb(), storage, bucket: "media", workDir, logger: cap.logger });
    expect(result).toEqual({ directories: 1, uploaded: 5, kept: 0 });

    const out = parsePlaylist(objects.get(PREFIX + VOD_PLAYLIST) ?? "").segments;
    expect(times(out)).toEqual([
      ["r1_000000.m4s", 300],
      ["r1_000001.m4s", 4300],
      ["r1_000002.m4s", 8300],
      ["r2_000000.m4s", 12_100],
      ["r2_000001.m4s", 16_100],
      ["r3_000000.m4s", 20_000],
      ["r3_000001.m4s", 24_000],
    ]);
    const ms = out.map((s) => s.startedAt?.getTime() ?? 0);
    expect(ms).toEqual([...ms].sort((a, b) => a - b));
    expect(cap.lines.some((l) => l.includes("raw times") && l.includes('"runs":1'))).toBe(true);
  });

  test("without a clock (tools, older callers) recovery keeps raw times", async () => {
    const dir = join(workDir, "broadcasts", BROADCAST);
    await mkdir(dir, { recursive: true });
    const r1 = run("r1", T0, 1);
    await writeLocalRun(dir, r1, [0]);
    await writeSidecar(dir, { runId: "r1", w0Ms: 1, offsetMs: 300 });
    const { logger } = captureLogger();
    await recoverWorkDir({ db: fakeDb(), storage, bucket: "media", workDir, logger });
    expect(times(parsePlaylist(objects.get(PREFIX + VOD_PLAYLIST) ?? "").segments)).toEqual([["r1_000000.m4s", 0]]);
  });
});
