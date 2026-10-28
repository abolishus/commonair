// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The recorder writes and resumes under the VOD row's `storage_prefix` (ADR 0009 amendment 1): a
 * new VOD's private `recordings/<id>/`, or the `vods/<id>/` of a recording resumed across the
 * upgrade. Anything else is refused, and nothing is uploaded until the prefix is known.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { vodPrefix } from "@commonair/contracts/storage";
import { offlineClock } from "../src/clock/media-clock.ts";
import type { BroadcastInfo, MediaContext } from "../src/context.ts";
import { recorderInit, recorderPlaylist } from "../src/ffmpeg/args.ts";
import { parsePlaylist } from "../src/vod/playlist.ts";
import { SegmentRecorder, VOD_PLAYLIST } from "../src/vod/recorder.ts";
import { captureLogger } from "./helpers/moderation.ts";

const BROADCAST = "0192f3a4-5b6c-7d8e-9f01-0000000000a1";
const VOD = "0192f3a4-5b6c-7d8e-9f01-0000000000a2";
const T0 = Date.parse("2026-10-27T12:00:00.000Z");

interface RecorderInternals {
  runs: string[];
  pollOnce(strict: boolean): Promise<void>;
}

let workDir: string;
let puts: Map<string, string>;
let gets: string[];

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "recorder-prefix-"));
  puts = new Map();
  gets = [];
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const broadcast: BroadcastInfo = {
  broadcastId: BROADCAST,
  channelId: "0192f3a4-5b6c-7d8e-9f01-0000000000a3",
  slug: "alice",
  path: "live/alice",
  title: "t",
  startedAt: new Date(T0),
  vodEnabled: true,
};

/** A `db` whose single VOD query answers `rows()` (or throws). */
function fakeDb(rows: () => { prefix: string }[]) {
  let queries = 0;
  const db = {
    select: () => ({
      from: () => ({
        where: async () => {
          queries++;
          return rows();
        },
      }),
    }),
  };
  return { db, queries: () => queries };
}

function recorder(db: unknown, stored: Record<string, string> = {}) {
  const { logger, lines } = captureLogger();
  const ctx = {
    workDir,
    logger,
    db,
    bucket: "media",
    clock: offlineClock(),
    timings: { recorderPollMs: 1000, clipBufferSeconds: 10 * 365 * 86_400 },
    storage: {
      get: async (_bucket: string, key: string) => {
        gets.push(key);
        return stored[key] === undefined ? null : new Response(stored[key]);
      },
      put: async (_bucket: string, key: string, body: Uint8Array | string) => {
        puts.set(key, typeof body === "string" ? body : new TextDecoder().decode(body));
      },
    },
  } as unknown as MediaContext;
  const rec = new SegmentRecorder(ctx, broadcast, VOD);
  return { rec, internals: rec as unknown as RecorderInternals, lines };
}

async function writeRun(runId: string, count: number) {
  const dir = join(workDir, "broadcasts", BROADCAST);
  await mkdir(dir, { recursive: true });
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:4", `#EXT-X-MAP:URI="${recorderInit(runId)}"`];
  await writeFile(join(dir, recorderInit(runId)), "init");
  for (let i = 0; i < count; i++) {
    const uri = `${runId}_${String(i).padStart(6, "0")}.m4s`;
    lines.push("#EXTINF:4.000000,", `#EXT-X-PROGRAM-DATE-TIME:${new Date(T0 + i * 4000).toISOString()}`, uri);
    await writeFile(join(dir, uri), `seg ${i}`);
  }
  await writeFile(join(dir, recorderPlaylist(runId)), `${lines.join("\n")}\n`);
}

const keys = () => [...puts.keys()].sort();

describe("recorder storage prefix", () => {
  test("a new VOD records under the private prefix read from its row", async () => {
    const { db } = fakeDb(() => [{ prefix: vodPrefix(VOD, "private") }]);
    const { internals } = recorder(db);
    internals.runs.push("r1");
    await writeRun("r1", 2);
    await internals.pollOnce(true);
    expect(keys()).toEqual(
      ["r1_000000.m4s", "r1_000001.m4s", VOD_PLAYLIST, recorderInit("r1")].map((f) => `recordings/${VOD}/${f}`).sort(),
    );
    expect(keys().some((k) => k.startsWith("vods/"))).toBe(false);
  });

  test("a recording resumed across the upgrade keeps its vods/ prefix and its published segments", async () => {
    const old = vodPrefix(VOD, "public");
    const published = [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      "#EXT-X-TARGETDURATION:4",
      '#EXT-X-MAP:URI="r0_init.mp4"',
      "#EXTINF:4.000000,",
      `#EXT-X-PROGRAM-DATE-TIME:${new Date(T0 - 8000).toISOString()}`,
      "r0_000000.m4s",
      "",
    ].join("\n");
    const { db } = fakeDb(() => [{ prefix: old }]);
    const { rec, internals } = recorder(db, { [old + VOD_PLAYLIST]: published });
    // start() would also spawn ffmpeg; the resume half is what is under test.
    await (rec as unknown as { vodTarget(id: string): Promise<string | null> }).vodTarget(VOD);
    expect(gets).toEqual([old + VOD_PLAYLIST]);
    internals.runs.push("r1");
    await writeRun("r1", 1);
    await internals.pollOnce(true);
    expect(keys().every((k) => k.startsWith(old))).toBe(true);
    const segments = parsePlaylist(puts.get(old + VOD_PLAYLIST) ?? "").segments.map((s) => s.uri);
    expect(segments).toEqual(["r0_000000.m4s", "r1_000000.m4s"]);
  });

  test("an unexpected prefix is refused: nothing is uploaded anywhere", async () => {
    for (const prefix of ["vods/", "recordings/", `vods/${VOD}`, "channels/x/", `recordings/${VOD}/../x/`]) {
      puts.clear();
      const { db } = fakeDb(() => [{ prefix }]);
      const { internals, lines } = recorder(db);
      internals.runs.push("r1");
      await writeRun("r1", 1);
      await internals.pollOnce(false);
      expect(puts.size, prefix).toBe(0);
      // Strict quiescence (T0, shutdown) reports it instead of claiming the segments are up.
      await expect(internals.pollOnce(true)).rejects.toThrow("VOD storage prefix unknown");
      expect(lines.some((l) => l.includes("VOD storage prefix missing or unexpected"))).toBe(true);
    }
  });

  test("a failed prefix read waits locally and uploads once the read succeeds", async () => {
    let fail = true;
    const { db, queries } = fakeDb(() => {
      if (fail) throw new Error("db down");
      return [{ prefix: vodPrefix(VOD, "private") }];
    });
    const { internals } = recorder(db);
    internals.runs.push("r1");
    await writeRun("r1", 1);
    await internals.pollOnce(false);
    expect(puts.size).toBe(0);
    fail = false;
    await internals.pollOnce(true);
    expect(keys()).toContain(`recordings/${VOD}/r1_000000.m4s`);
    // Read once it succeeded; later polls reuse it.
    await internals.pollOnce(true);
    expect(queries()).toBe(2);
  });
});
