// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Pure parts of the DMCA jobs: the private prefix, which objects an item covers, and when a counter-notice is due. */
import { describe, expect, test } from "vite-plus/test";
import type { WorkerContext } from "../src/context.ts";
import {
  DMCA_HIDDEN_PREFIX,
  dmcaHiddenKey,
  dmcaOriginalKey,
  objectsOf,
  stillWriting,
  type Covered,
} from "../src/dmca/objects.ts";
import { isDue, restoreAsOf } from "../src/dmca/restore.ts";

describe("private prefix", () => {
  test("is outside every publicly served prefix and round-trips", () => {
    for (const pub of ["channels/", "clips/", "thumbnails/", "vods/"])
      expect(DMCA_HIDDEN_PREFIX.startsWith(pub)).toBe(false);
    const k = "vods/0192f000-0000-7000-8000-000000000001/seg0.ts";
    expect(dmcaOriginalKey(dmcaHiddenKey(k))).toBe(k);
    expect(dmcaOriginalKey(k)).toBeNull();
  });
});

describe("objectsOf", () => {
  const covered: Covered = {
    vods: [
      { id: "v1", broadcastId: "b1", storagePrefix: "vods/v1/", thumbnailKey: "thumbnails/b1/t.jpg", status: "ready" },
      { id: "v2", broadcastId: "b1", storagePrefix: "vods/v2/", thumbnailKey: "vods/v2/thumb.jpg", status: "deleted" },
    ],
    clips: [
      { id: "c1", storageKey: "clips/c1.mp4", thumbnailKey: "clips/c1.jpg", status: "ready" },
      { id: "c2", storageKey: null, thumbnailKey: null, status: "processing" },
      { id: "c3", storageKey: "clips/c3.mp4", thumbnailKey: null, status: "deleted" },
    ],
    prefixes: ["thumbnails/b1/"],
  };

  test("prefixes and keys of rows that are not deleted; a thumbnail inside the VOD prefix is not listed twice", () => {
    // Both of a VOD's own prefixes, its storage_prefix first: a placement move may be in flight.
    expect(objectsOf(covered)).toEqual({
      keys: ["thumbnails/b1/t.jpg", "clips/c1.mp4", "clips/c1.jpg"],
      prefixes: ["thumbnails/b1/", "vods/v1/", "recordings/v1/"],
    });
    const recorded: Covered = {
      vods: [
        {
          id: "v3",
          broadcastId: "b",
          storagePrefix: "recordings/v3/",
          thumbnailKey: "recordings/v3/t.jpg",
          status: "ready",
        },
      ],
      clips: [],
      prefixes: [],
    };
    expect(objectsOf(recorded)).toEqual({ keys: [], prefixes: ["recordings/v3/", "vods/v3/"] });
  });

  test("material held by another notice is skipped", () => {
    expect(objectsOf(covered, { vodIds: new Set(["v1"]), clipIds: new Set(["c1"]) })).toEqual({
      keys: [],
      prefixes: ["thumbnails/b1/"],
    });
  });

  test("a storage prefix the VOD does not own falls back to its own prefixes", () => {
    const odd: Covered = {
      vods: [{ id: "v9", broadcastId: "b", storagePrefix: "elsewhere/", thumbnailKey: null, status: "ready" }],
      clips: [],
      prefixes: [],
    };
    expect(objectsOf(odd).prefixes).toEqual(["vods/v9/", "recordings/v9/"]);
  });
});

describe("stillWriting", () => {
  const vod = (status: string) => ({ id: "v", broadcastId: "b", storagePrefix: "vods/v/", thumbnailKey: null, status });
  const clip = (status: string) => ({ id: "c", storageKey: null, thumbnailKey: null, status });
  test("a VOD recording or processing, or a clip processing, is still being written", () => {
    for (const s of ["recording", "processing"])
      expect(stillWriting({ vods: [vod(s)], clips: [], prefixes: [] }), s).toBe(true);
    expect(stillWriting({ vods: [], clips: [clip("processing")], prefixes: [] })).toBe(true);
  });
  test("final states are not, and nothing covered is not", () => {
    for (const s of ["ready", "failed", "deleted"])
      expect(stillWriting({ vods: [vod(s)], clips: [clip(s)], prefixes: ["thumbnails/b/"] }), s).toBe(false);
    expect(stillWriting({ vods: [], clips: [], prefixes: [] })).toBe(false);
  });
});

describe("isDue", () => {
  const restoreAfter = new Date("2026-11-11T09:15:00Z");
  const base = { restoreAfter, restoredAt: null, suitFiledAt: null };
  test("inclusive at restore_after, not a millisecond before", () => {
    expect(isDue(base, new Date(restoreAfter.getTime() - 1))).toBe(false);
    expect(isDue(base, restoreAfter)).toBe(true);
    expect(isDue(base, new Date(restoreAfter.getTime() + 60_000))).toBe(true);
  });
  test("never once restored or with a suit filed", () => {
    const later = new Date("2027-01-01T00:00:00Z");
    expect(isDue({ ...base, restoredAt: later }, later)).toBe(false);
    expect(isDue({ ...base, suitFiledAt: later }, later)).toBe(false);
  });
});

describe("restoreAsOf", () => {
  const ctx = (testHooks: boolean) =>
    ({
      now: () => new Date("2026-10-27T00:00:00Z"),
      moderation: { testHooks },
      logger: { warn() {} },
    }) as unknown as WorkerContext;
  test("honours asOf only with test hooks on", () => {
    const asOf = "2030-01-01T00:00:00.000Z";
    expect(restoreAsOf(ctx(true), { asOf }).toISOString()).toBe(asOf);
    expect(restoreAsOf(ctx(false), { asOf }).toISOString()).toBe("2026-10-27T00:00:00.000Z");
    expect(restoreAsOf(ctx(true), {}).toISOString()).toBe("2026-10-27T00:00:00.000Z");
  });
});
