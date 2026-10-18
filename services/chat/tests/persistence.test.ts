// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import type { Database } from "@commonair/db";
import { CHAT_LIMITS } from "@commonair/contracts";
import { MemoryLimiter } from "../src/limiter.ts";
import { createMetrics } from "../src/metrics.ts";
import { MessageWriter, type MessageRow } from "../src/persistence.ts";
import { runSendPipeline } from "../src/pipeline.ts";
import { channel, deps, input, NOW, silentLogger } from "./fixtures.ts";

/** A stand-in for drizzle's insert chain that can be switched between "down" and "up". */
function fakeDb() {
  const state = { down: true, calls: 0, rows: [] as MessageRow[] };
  const db = {
    insert: () => ({
      values: (v: MessageRow | MessageRow[]) => ({
        onConflictDoNothing: async () => {
          state.calls++;
          if (state.down) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
          state.rows.push(...(Array.isArray(v) ? v : [v]));
        },
      }),
    }),
  } as unknown as Database;
  return { db, state };
}

const row = (i: number): MessageRow => ({ id: `id-${i}`, channelId: "c", userId: "u", body: `b${i}` });

describe("MessageWriter during a database outage", () => {
  test("requeues in order, backs off instead of retrying hot, and recovers", async () => {
    let now = 0;
    const { db, state } = fakeDb();
    const w = new MessageWriter(db, silentLogger, createMetrics(), {
      intervalMs: 60_000,
      backoffMs: 1000,
      clock: () => now,
    });
    for (let i = 0; i < 3; i++) w.enqueue(row(i));
    await w.flush();
    expect(state.calls).toBe(1);
    expect(w.pending).toBe(3);
    expect(w.degraded).toBe(true);
    // Within the backoff window flushes are no-ops: no hammering of a dead database.
    for (let i = 0; i < 10; i++) await w.flush();
    expect(state.calls).toBe(1);
    now = 1001;
    await w.flush();
    expect(state.calls).toBe(2); // second failure doubles the backoff
    now = 2500;
    await w.flush();
    expect(state.calls).toBe(2);
    now = 3002;
    state.down = false;
    w.enqueue(row(3));
    await w.flush();
    expect(state.rows.map((r) => r.id)).toEqual(["id-0", "id-1", "id-2", "id-3"]);
    expect(w.degraded).toBe(false);
    await w.close();
  });

  test("bounded waits: flushWithin and close do not hang behind an outage", async () => {
    const { db } = fakeDb();
    const w = new MessageWriter(db, silentLogger, createMetrics(), { intervalMs: 60_000, closeTimeoutMs: 100 });
    w.enqueue(row(1));
    expect(await w.flushWithin(100)).toBe(false);
    const started = performance.now();
    await w.close();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("concurrent flush callers share one follow-up drain", async () => {
    const { db, state } = fakeDb();
    state.down = false;
    const w = new MessageWriter(db, silentLogger, createMetrics(), { intervalMs: 60_000 });
    w.enqueue(row(1));
    await Promise.all(Array.from({ length: 50 }, () => w.flush()));
    expect(state.calls).toBeLessThanOrEqual(2);
    expect(state.rows).toHaveLength(1);
    await w.close();
  });
});

describe("global rate limit", () => {
  test("a user's messages across channels are capped at 3× the per-channel limit", async () => {
    const limiter = new MemoryLimiter(() => NOW.getTime());
    let accepted = 0;
    for (let c = 0; c < 5; c++)
      for (let i = 0; i < CHAT_LIMITS.user; i++) {
        const ch = channel({}, { id: `00000000-0000-7000-8000-0000000000${20 + c}` });
        const r = await runSendPipeline(deps([], limiter), input({ body: `c${c} m${i}`, channel: ch }));
        accepted += r.ok ? 1 : 0;
      }
    expect(accepted).toBe(CHAT_LIMITS.user * 3);
  });
});
