// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import type { Database } from "@commonair/db";
import { createLogger } from "@commonair/observability";
import type { ObjectStorage } from "@commonair/storage";
import { HashMatchEnforcer, withRetry } from "../src/safety/enforce.ts";
import type { HashMatcher } from "../src/safety/hashmatch.ts";

const logger = createLogger({ service: "test", level: "fatal" });
const always: HashMatcher = { name: "t", records: true, check: async () => ({ matched: true, details: {} }) };

describe("withRetry", () => {
  test("retries until success and reports each failure", async () => {
    let n = 0;
    const errors: number[] = [];
    const v = await withRetry(
      async () => {
        if (++n < 3) throw new Error("db down");
        return "ok";
      },
      { attempts: 5, initialMs: 1, maxMs: 2 },
      (_e, attempt) => errors.push(attempt),
    );
    expect(v).toBe("ok");
    expect(errors).toEqual([1, 2]);
  });

  test("gives up after the last attempt", async () => {
    await expect(
      withRetry(
        () => Promise.reject(new Error("still down")),
        { attempts: 2, initialMs: 1, maxMs: 1 },
        () => {},
      ),
    ).rejects.toThrow("still down");
  });
});

describe("HashMatchEnforcer on a live match", () => {
  test("cuts the stream before writing, and a database outage does not keep it on air", async () => {
    const events: string[] = [];
    let txCalls = 0;
    const db = {
      transaction: async () => {
        txCalls++;
        events.push("record");
        throw new Error("database unavailable");
      },
    } as unknown as Database;
    const enforcer = new HashMatchEnforcer({
      db,
      storage: {} as ObjectStorage,
      bucket: "b",
      matcher: always,
      logger,
      mtx: {
        kickPublisher: async () => {
          events.push("kick");
          return true;
        },
      },
      stopBroadcast: async () => {
        events.push("stop");
      },
      retry: { attempts: 3, initialMs: 1, maxMs: 1 },
    });
    const bid = crypto.randomUUID();
    const matched = await enforcer.check(new Uint8Array([1]), {
      subjectType: "broadcast",
      subjectId: bid,
      channelId: crypto.randomUUID(),
      broadcastId: bid,
      path: "live/x",
    });
    expect(matched).toBe(true);
    // The kick happened before the check returned and before any database write.
    expect(events[0]).toBe("kick");
    expect(enforcer.isTainted(bid)).toBe(true);
    await enforcer.settle();
    expect(events).toEqual(["kick", "stop", "record", "record", "record"]);
    expect(txCalls).toBe(3);
  });

  test("a failing kick does not prevent stopping and recording", async () => {
    const events: string[] = [];
    const enforcer = new HashMatchEnforcer({
      db: {
        transaction: async () => {
          events.push("record");
          throw new Error("x");
        },
      } as unknown as Database,
      storage: {} as ObjectStorage,
      bucket: "b",
      matcher: always,
      logger,
      mtx: { kickPublisher: () => Promise.reject(new Error("mediamtx down")) },
      stopBroadcast: async () => {
        events.push("stop");
      },
      retry: { attempts: 1, initialMs: 1, maxMs: 1 },
    });
    const bid = crypto.randomUUID();
    expect(
      await enforcer.check(new Uint8Array(), {
        subjectType: "broadcast",
        subjectId: bid,
        channelId: crypto.randomUUID(),
        broadcastId: bid,
        path: "live/x",
      }),
    ).toBe(true);
    await enforcer.settle();
    expect(events).toEqual(["stop", "record"]);
  });
});
