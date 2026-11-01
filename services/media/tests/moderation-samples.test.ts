// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The rehearsal moderation sample count (batch 7 follow-up, `moderation.ts`
 * `countRehearsalSample`): one `INCR` per sampled frame of a rehearsal broadcast, with the
 * rehearsal report's TTL; never for a live broadcast; never in the way of the scan itself.
 */
import { describe, expect, test } from "vite-plus/test";
import { KEYS, REHEARSAL_REPORT_TTL_SECONDS } from "@commonair/contracts/internal";
import type { Database } from "@commonair/db";
import { fakeFrame, fakeValkey, makeModeration, stubDb } from "./helpers/moderation.ts";

const base = {
  broadcastId: "0192a1b2-0000-7000-8000-0000000000b1",
  channelId: "0192a1b2-0000-7000-8000-0000000000c1",
  path: "live/someone",
};
const key = KEYS.rehearsalModerationSamples(base.broadcastId);

/** `stubDb`, answering the broadcast-kind read with `kind` and counting those reads. */
function kindDb(kind: "live" | "rehearsal" | null): { db: Database; reads: () => number } {
  const inner = stubDb() as unknown as { select: (f: Record<string, unknown>) => unknown };
  let reads = 0;
  const db = {
    select: (fields: Record<string, unknown>) => {
      if (!("kind" in fields)) return inner.select(fields);
      reads++;
      const p = Promise.resolve(kind === null ? [] : [{ kind }]);
      const chain = Object.assign(p, {}) as Promise<unknown[]> & Record<string, () => unknown>;
      for (const m of ["from", "where"]) chain[m] = () => chain;
      return chain;
    },
  } as unknown as Database;
  return { db, reads: () => reads };
}

describe("rehearsal moderation samples", () => {
  test("a rehearsal's sampled frames are counted, with the report's TTL", async () => {
    const valkey = fakeValkey();
    const { moderation } = await makeModeration({ valkey });
    const target = { ...base, kind: "rehearsal" as const };
    for (let i = 0; i < 3; i++) await moderation.scanLiveFrame(target, fakeFrame("1", 90), new Date());
    expect(valkey.counters.get(key)).toBe(3);
    expect(valkey.ttls.get(key)).toBe(REHEARSAL_REPORT_TTL_SECONDS);
  });

  test("a live broadcast's frames are never counted", async () => {
    const valkey = fakeValkey();
    const { moderation, queue } = await makeModeration({ valkey });
    await moderation.scanLiveFrame({ ...base, kind: "live" }, fakeFrame("1", 90), new Date());
    expect(valkey.counters.size).toBe(0);
    // The scan itself is unchanged.
    expect(queue.scans).toHaveLength(1);
  });

  test("a low-quality frame (never matched or classified) is a sampled frame too", async () => {
    const valkey = fakeValkey();
    const { moderation, queue } = await makeModeration({ valkey });
    const target = { ...base, kind: "rehearsal" as const };
    expect(await moderation.scanLiveFrame(target, fakeFrame("1", 10), new Date())).toBe("clean");
    expect(valkey.counters.get(key)).toBe(1);
    expect(queue.scans[0]?.pdq ?? null).toBeNull();
  });

  test("without a kind from the caller it reads the broadcast once and keeps it", async () => {
    const valkey = fakeValkey();
    const { db, reads } = kindDb("rehearsal");
    const { moderation } = await makeModeration({ valkey, db });
    for (let i = 0; i < 4; i++) await moderation.scanLiveFrame(base, fakeFrame("1", 90), new Date());
    expect(valkey.counters.get(key)).toBe(4);
    expect(reads()).toBe(1);
  });

  test("an unknown broadcast is not counted, and is read again next frame", async () => {
    const valkey = fakeValkey();
    const { db, reads } = kindDb(null);
    const { moderation } = await makeModeration({ valkey, db });
    await moderation.scanLiveFrame(base, fakeFrame("1", 90), new Date());
    await moderation.scanLiveFrame(base, fakeFrame("1", 90), new Date());
    expect(valkey.counters.size).toBe(0);
    expect(reads()).toBe(2);
  });

  test("a Valkey failure is logged and the frame is still scanned", async () => {
    const valkey = fakeValkey({
      incr: async () => {
        throw new Error("valkey down");
      },
    });
    const { moderation, queue, lines } = await makeModeration({ valkey });
    expect(await moderation.scanLiveFrame({ ...base, kind: "rehearsal" }, fakeFrame("1", 90), new Date())).toBe(
      "clean",
    );
    expect(queue.scans).toHaveLength(1);
    expect(lines.join("\n")).toContain("could not count a rehearsal moderation sample");
  });

  test("the scan does not wait for the count: the frame is queued while the count is in flight", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let queuedBeforeCount = false;
    const inner = fakeValkey();
    const valkey = fakeValkey({
      incr: async (k: string) => {
        await gate;
        return inner.incr(k);
      },
    });
    const { moderation, queue } = await makeModeration({ valkey });
    const done = moderation.scanLiveFrame({ ...base, kind: "rehearsal" }, fakeFrame("1", 90), new Date());
    await new Promise((r) => setTimeout(r, 20));
    queuedBeforeCount = queue.scans.length === 1;
    release();
    expect(await done).toBe("clean");
    expect(queuedBeforeCount).toBe(true);
    expect(inner.counters.get(key)).toBe(1);
  });
});
