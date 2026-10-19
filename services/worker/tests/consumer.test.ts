// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Failure paths of the segment consumer with in-memory fakes: evidence recording that fails
 * after the batch is committed, and an XACK that fails after the batch is applied. Neither may
 * apply a batch twice in this process. The happy paths run against real services in
 * segments.int.test.ts.
 */
import { createLogger, type Logger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { WorkerContext } from "../src/context.ts";
import { metrics } from "../src/metrics.ts";
import { ACK_ATTEMPTS, ackEntries, BroadcastCache, processResilient } from "../src/segments/consumer.ts";

const SID = "0190a0a0-0000-7000-8000-000000000001";
const CID = "0190a0a0-0000-7000-8000-000000000002";
const BID = "0190a0a0-0000-7000-8000-000000000003";
const NOW = Date.UTC(2026, 9, 18, 12, 0, 30);

type Entry = [string, string[]];
const entry = (id: string, obj: string): Entry => [
  id,
  ["sid", SID, "cid", CID, "src", "origin", "kind", "segment", "bytes", "100", "at", String(NOW), "obj", obj],
];
const BATCH: Entry[] = [entry("1-0", "source/a_seg1.mp4"), entry("2-0", "source/a_seg2.mp4")];

function recordingLogger() {
  const warnings: { msg: string; fields?: Record<string, unknown> }[] = [];
  const base = createLogger({ service: "worker-test", level: "fatal" });
  const logger: Logger = {
    ...base,
    warn: (msg, fields) => void warnings.push({ msg, fields }),
    child: () => logger,
  };
  return { logger, warnings };
}

/** A `postgres.Sql` stand-in: the broadcast lookup answers one session, transactions are counted. */
function fakeSql() {
  const state = { transactions: 0, statements: 0 };
  const tx = (first: unknown) => {
    if (Array.isArray(first) && "raw" in first) {
      state.statements++;
      return Promise.resolve([]);
    }
    return first; // the `tx(rows)` values helper
  };
  const sql = Object.assign(() => Promise.resolve([{ id: SID, broadcast_id: BID }]), {
    begin: async (fn: (t: typeof tx) => Promise<unknown>) => {
      state.transactions++;
      return fn(tx);
    },
  });
  return { sql, state };
}

/** A Valkey stand-in whose MULTI pipeline accepts every command and rejects (or not) on EXEC. */
function fakeValkey(execFails: boolean) {
  const state = { execs: 0 };
  const pipeline: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === "exec"
          ? () => {
              state.execs++;
              return execFails ? Promise.reject(new Error("EXECABORT")) : Promise.resolve([]);
            }
          : () => pipeline,
    },
  );
  return { valkey: { multi: () => pipeline } as unknown as ValkeyClient, state };
}

function fakeClient(failures: number) {
  const calls: string[][] = [];
  const client = {
    xack: async (_stream: string, _group: string, ...ids: string[]) => {
      calls.push(ids);
      if (calls.length <= failures) throw new Error("connection lost");
      return ids.length;
    },
  } as unknown as ValkeyClient;
  return { client, calls };
}

function context(opts: { execFails?: boolean } = {}) {
  const { sql, state: db } = fakeSql();
  const { valkey, state: vk } = fakeValkey(opts.execFails ?? false);
  const { logger, warnings } = recordingLogger();
  const ctx = {
    sql,
    valkey,
    logger,
    segmentStream: "test:stream",
    now: () => new Date(NOW),
  } as unknown as WorkerContext;
  return { ctx, db, vk, warnings };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("evidence recording failure", () => {
  test("is logged and counted as failed; the batch is still committed and acknowledged once", async () => {
    const evidence = vi.spyOn(metrics.fetchEvidence, "add");
    const { ctx, db, vk, warnings } = context({ execFails: true });
    const { client, calls } = fakeClient(0);

    expect(await processResilient(ctx, client, new BroadcastCache(), BATCH)).toBe(2);

    expect(db.transactions).toBe(1);
    expect(vk.execs).toBe(1);
    expect(calls).toEqual([["1-0", "2-0"]]);
    expect(evidence).toHaveBeenCalledWith(2, { outcome: "failed" });
    expect(evidence).not.toHaveBeenCalledWith(expect.anything(), { outcome: "recorded" });
    expect(warnings.map((w) => w.msg)).toEqual(["recording integrity fetch evidence failed"]);
    expect(warnings[0]?.fields?.count).toBe(2);
  });

  test("a successful write is counted as recorded", async () => {
    const evidence = vi.spyOn(metrics.fetchEvidence, "add");
    const { ctx, vk, warnings } = context();
    expect(await processResilient(ctx, fakeClient(0).client, new BroadcastCache(), BATCH)).toBe(2);
    expect(vk.execs).toBe(1);
    expect(evidence).toHaveBeenCalledWith(2, { outcome: "recorded" });
    expect(warnings).toEqual([]);
  });
});

describe("acknowledgement failure", () => {
  test("a transient XACK failure is retried alone; aggregate and evidence are applied once", async () => {
    const { ctx, db, vk, warnings } = context();
    const { client, calls } = fakeClient(ACK_ATTEMPTS - 1);

    expect(await processResilient(ctx, client, new BroadcastCache(), BATCH)).toBe(2);

    expect(db.transactions).toBe(1);
    expect(vk.execs).toBe(1);
    expect(calls).toHaveLength(ACK_ATTEMPTS);
    for (const ids of calls) expect(ids).toEqual(["1-0", "2-0"]);
    expect(warnings).toEqual([]);
  });

  test("an XACK that keeps failing leaves the batch pending without re-applying it", async () => {
    const entries = vi.spyOn(metrics.segmentEntries, "add");
    const { ctx, db, vk, warnings } = context();
    const { client, calls } = fakeClient(Number.POSITIVE_INFINITY);

    // No throw, no per-entry fallback: the batch was applied, only its ack is missing.
    expect(await processResilient(ctx, client, new BroadcastCache(), BATCH)).toBe(0);

    expect(db.transactions).toBe(1);
    expect(vk.execs).toBe(1);
    expect(calls).toHaveLength(ACK_ATTEMPTS);
    // Until telemetry is initialized every counter is the same no-op instance, so the spy also
    // sees the evidence counter (called with attributes); the entries counter has none.
    expect(entries.mock.calls.filter((c) => c[1] === undefined)).toEqual([[2]]);
    expect(warnings.map((w) => w.msg)).toEqual(["acknowledging applied segment entries failed; left pending"]);
  });

  test("ackEntries reports success, and failure after exactly ACK_ATTEMPTS tries", async () => {
    const { ctx } = context();
    expect(await ackEntries(ctx, fakeClient(0).client, ["1-0"], 0)).toBe(true);
    const failing = fakeClient(ACK_ATTEMPTS);
    expect(await ackEntries(ctx, failing.client, ["1-0"], 0)).toBe(false);
    expect(failing.calls).toHaveLength(ACK_ATTEMPTS);
  });
});
