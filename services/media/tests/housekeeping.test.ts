// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdirSync, mkdtempSync, rmSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { createLogger } from "@commonair/observability";
import { segmentsToRecover, sweepWorkDir } from "../src/recovery.ts";
import { thumbnailsToDelete } from "../src/thumbnails.ts";
import type { PlaylistSegment } from "../src/vod/playlist.ts";
import { decideVod, type FinalizeJobInfo } from "../src/vod/reconcile.ts";

const logger = createLogger({ service: "test", level: "fatal" });

describe("decideVod", () => {
  const now = new Date("2026-10-18T12:00:00Z");
  const base = { now, failAfterMs: 24 * 3600_000, retryAfterMs: 600_000 };
  const job = (state: FinalizeJobInfo["state"], finishedOn: number | null = null): FinalizeJobInfo => ({
    state,
    finishedOn,
  });
  const ago = (ms: number) => new Date(now.getTime() - ms);

  test("a job that is queued, delayed or running owns the VOD", () => {
    for (const s of ["active", "waiting", "delayed", "prioritized", "waiting-children"] as const)
      expect(decideVod({ ...base, job: job(s), since: ago(48 * 3600_000) })).toBe("owned");
  });

  test("no job: re-queue (resume)", () => {
    expect(decideVod({ ...base, job: job("unknown"), since: ago(60_000) })).toBe("requeue");
  });

  test("a job that failed for good is retried only after the retry delay", () => {
    expect(decideVod({ ...base, job: job("failed", now.getTime() - 60_000), since: ago(3600_000) })).toBe("wait");
    expect(decideVod({ ...base, job: job("failed", now.getTime() - 600_000), since: ago(3600_000) })).toBe("requeue");
    expect(decideVod({ ...base, job: job("completed", now.getTime() - 700_000), since: ago(3600_000) })).toBe(
      "requeue",
    );
  });

  test("past the deadline an unowned VOD fails (exactly at the boundary too)", () => {
    expect(decideVod({ ...base, job: job("failed", now.getTime()), since: ago(24 * 3600_000) })).toBe("fail");
    expect(decideVod({ ...base, job: job("unknown"), since: ago(24 * 3600_000 - 1) })).toBe("requeue");
  });
});

describe("thumbnailsToDelete", () => {
  const p = "thumbnails/b1/";
  test("keeps the newest N stamped copies, ignores latest.* and foreign keys", () => {
    const keys = [
      `${p}latest.webp`,
      `${p}1000.webp`,
      `${p}3000.webp`,
      `${p}2000.jpg`,
      `${p}4000.webp`,
      `${p}notes.txt`,
    ];
    expect(thumbnailsToDelete(keys, 2).sort()).toEqual([`${p}1000.webp`, `${p}2000.jpg`]);
    expect(thumbnailsToDelete(keys, 10)).toEqual([]);
  });

  test("numeric, not lexical, order; never deletes the newest even with keep 0", () => {
    const keys = [`${p}999.webp`, `${p}1000.webp`];
    expect(thumbnailsToDelete(keys, 1)).toEqual([`${p}999.webp`]);
    expect(thumbnailsToDelete(keys, 0)).toEqual([`${p}999.webp`]);
    expect(thumbnailsToDelete([], 3)).toEqual([]);
  });
});

describe("segmentsToRecover", () => {
  const seg = (uri: string, t: number | null, map = "init_r1.mp4"): PlaylistSegment => ({
    uri,
    durationSeconds: 4,
    startedAt: t === null ? null : new Date(t),
    map,
  });

  test("returns completed local segments missing from the published playlist, in time order", () => {
    const published = [seg("r1_000000.m4s", 0), seg("r1_000001.m4s", 4000)];
    const runs = [
      {
        runId: "r2",
        segments: [seg("r2_000000.m4s", 20_000, "init_r2.mp4"), seg("r2_000001.m4s", 24_000, "init_r2.mp4")],
      },
      { runId: "r1", segments: [seg("r1_000000.m4s", 0), seg("r1_000001.m4s", 4000), seg("r1_000002.m4s", 8000)] },
    ];
    expect(segmentsToRecover(published, runs).map((s) => s.uri)).toEqual([
      "r1_000002.m4s",
      "r2_000000.m4s",
      "r2_000001.m4s",
    ]);
  });

  test("strips directories from URIs and maps; without timestamps keeps run then playlist order", () => {
    const runs = [
      { runId: "rb", segments: [seg("/w/b/rb_000000.m4s", null, "/w/b/init_rb.mp4")] },
      { runId: "ra", segments: [seg("ra_000001.m4s", null), seg("ra_000000.m4s", null)] },
    ];
    const out = segmentsToRecover([], runs);
    expect(out.map((s) => s.uri)).toEqual(["ra_000001.m4s", "ra_000000.m4s", "rb_000000.m4s"]);
    expect(out[2]?.map).toBe("init_rb.mp4");
  });

  test("nothing to do when everything is published", () => {
    expect(
      segmentsToRecover([seg("r1_000000.m4s", 0)], [{ runId: "r1", segments: [seg("r1_000000.m4s", 0)] }]),
    ).toEqual([]);
  });
});

describe("sweepWorkDir", () => {
  const dir = mkdtempSync(join(tmpdir(), "media-sweep-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const old = (path: string, ms: number) => {
    const t = (Date.now() - ms) / 1000;
    utimesSync(path, t, t);
  };

  test("removes old orphans, keeps owned, fresh and unrelated directories", async () => {
    const mk = (p: string) => {
      mkdirSync(join(dir, p), { recursive: true });
      return join(dir, p);
    };
    const oldClip = mk("clip-abc");
    const newVod = mk("vod-def");
    const other = mk("something-else");
    const orphan = mk("broadcasts/orphan");
    const owned = mk("broadcasts/owned");
    const fresh = mk("broadcasts/fresh");
    old(oldClip, 2 * 3600_000);
    old(other, 48 * 3600_000);
    old(orphan, 3600_000);
    old(owned, 3600_000);

    const { removed } = await sweepWorkDir({
      workDir: dir,
      owned: new Set(["owned"]),
      broadcastDirMaxAgeMs: 15 * 60_000,
      scratchMaxAgeMs: 3600_000,
      logger,
    });
    expect(removed.sort()).toEqual([orphan, oldClip].sort());
    for (const keep of [newVod, other, owned, fresh]) expect(existsSync(keep), keep).toBe(true);
  });

  test("age 0 removes every scratch directory (startup, before jobs run)", async () => {
    mkdirSync(join(dir, "clip-fresh"));
    const { removed } = await sweepWorkDir({
      workDir: dir,
      owned: new Set(),
      broadcastDirMaxAgeMs: 15 * 60_000,
      scratchMaxAgeMs: 0,
      logger,
    });
    expect(removed).toContain(join(dir, "clip-fresh"));
    expect(removed).toContain(join(dir, "vod-def"));
  });

  test("a missing work dir is not an error", async () => {
    await expect(
      sweepWorkDir({
        workDir: join(dir, "nope"),
        owned: new Set(),
        broadcastDirMaxAgeMs: 0,
        scratchMaxAgeMs: 0,
        logger,
      }),
    ).resolves.toEqual({ removed: [] });
  });
});
