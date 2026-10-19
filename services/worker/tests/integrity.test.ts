// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SegmentFetch } from "@commonair/contracts/internal";
import { QUEUES } from "@commonair/contracts/internal";
import { parseNetworkList } from "@commonair/integrity";
import { createLogger, type Logger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { DEFAULT_CONCURRENCY } from "../src/env.ts";
import { ClassifierHolder, entryCount } from "../src/integrity/classifier.ts";
import { fetchEvidence } from "../src/integrity/fetches.ts";
import {
  INTEGRITY_BATCH,
  INTEGRITY_JOBS,
  INTEGRITY_SCHEDULES,
  integrityJobs,
  runLockKey,
} from "../src/integrity/jobs.ts";
import { withRunLock } from "../src/integrity/lock.ts";
import { JOBS } from "../src/jobs/index.ts";
import { metrics } from "../src/metrics.ts";
import { buildRegistry, scheduledJobs } from "../src/runtime/registry.ts";
import { schedulerTemplate } from "../src/runtime/runtime.ts";

const logger = createLogger({ service: "worker-test", level: "fatal" });

function recordingLogger() {
  const warnings: { msg: string; fields?: Record<string, unknown> }[] = [];
  const rec: Logger = { ...logger, warn: (msg, fields) => void warnings.push({ msg, fields }), child: () => rec };
  return { logger: rec, warnings };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("integrity scheduling", () => {
  test("the shipped registry schedules the four jobs on the integrity queue at their intervals", () => {
    const integrity = buildRegistry(JOBS).get(QUEUES.integrity);
    const every = (name: string) => integrity?.get(name)?.schedule;
    expect(every("score-sessions")).toEqual({ every: 15_000 });
    expect(every("verify-receipts")).toEqual({ every: 60_000 });
    expect(every("follow-bursts")).toEqual({ every: 60_000 });
    expect(every("stream-hours")).toEqual({ every: 300_000 });
  });

  test("every job retries with backoff, and its scheduler template carries that", () => {
    for (const def of integrityJobs()) {
      const spec = INTEGRITY_SCHEDULES[def.name as keyof typeof INTEGRITY_SCHEDULES];
      expect(def.attempts).toBeGreaterThan(1);
      const tpl = schedulerTemplate(def);
      expect(tpl.name).toBe(def.name);
      expect(tpl.opts.attempts).toBe(spec.attempts);
      expect(tpl.opts.backoff).toEqual({ type: "exponential", delay: spec.backoffMs });
      // A run may hold its lock for longer than one interval, never forever.
      expect(spec.maxRunMs).toBeGreaterThan(spec.everyMs);
    }
  });

  test("jobs without explicit retry settings get the runtime defaults", () => {
    const tpl = schedulerTemplate({ ...integrityJobs()[0]!, attempts: undefined, backoffMs: undefined });
    expect(tpl.opts.attempts).toBe(3);
    expect(tpl.opts.backoff).toEqual({ type: "exponential", delay: 5_000 });
  });

  test("each job has its own name and lock, and the queue has a slot for every recurring job", () => {
    const names = integrityJobs().map((j) => j.name);
    expect(new Set(names).size).toBe(4);
    expect(names.sort()).toEqual(Object.values(INTEGRITY_JOBS).sort());
    expect(new Set(names.map((n) => runLockKey(n as never))).size).toBe(4);
    const recurring = scheduledJobs(buildRegistry(JOBS)).filter((j) => j.queue === QUEUES.integrity);
    expect(DEFAULT_CONCURRENCY.integrity).toBeGreaterThanOrEqual(recurring.length);
  });

  test("interval overrides apply per job; the rest keep their defaults", () => {
    const jobs = integrityJobs({ everyMs: { "score-sessions": 1_000 } });
    const by = new Map(jobs.map((j) => [j.name, j.schedule]));
    expect(by.get("score-sessions")).toEqual({ every: 1_000 });
    expect(by.get("stream-hours")).toEqual({ every: 300_000 });
  });

  test("batches are bounded", () => {
    expect(INTEGRITY_BATCH.sessions).toBeGreaterThan(0);
    expect(INTEGRITY_BATCH.sessions).toBeLessThanOrEqual(5_000);
    expect(INTEGRITY_BATCH.receipts).toBeLessThanOrEqual(1_000);
  });
});

describe("fetchEvidence", () => {
  const SID = "0190a0a0-0000-7000-8000-000000000001";
  const CID = "0190a0a0-0000-7000-8000-000000000002";
  const f = (src: SegmentFetch["src"], kind: SegmentFetch["kind"], obj?: string): SegmentFetch => ({
    sid: SID,
    cid: CID,
    src,
    kind,
    bytes: 100,
    at: 1,
    ...(obj ? { obj } : {}),
  });

  test("keeps origin and p2p entries, drops relay and cdn", () => {
    const out = fetchEvidence([
      f("origin", "segment", "source/a_seg1.mp4"),
      f("relay", "segment", "source/a_seg1.mp4"),
      f("cdn", "playlist"),
      f("p2p", "part", "720p/a_part3.mp4"),
    ]);
    expect(out).toEqual([
      { sid: SID, kind: "segment", object: "source/a_seg1.mp4" },
      { sid: SID, kind: "part", object: "720p/a_part3.mp4" },
    ]);
  });

  test("entries without an object id (older origins, playlists) carry no object", () => {
    expect(fetchEvidence([f("origin", "playlist"), f("origin", "segment")])).toEqual([
      { sid: SID, kind: "playlist" },
      { sid: SID, kind: "segment" },
    ]);
  });

  test("empty and all-filtered batches", () => {
    expect(fetchEvidence([])).toEqual([]);
    expect(fetchEvidence([f("relay", "segment"), f("cdn", "segment")])).toEqual([]);
  });
});

describe("ClassifierHolder", () => {
  const list = (text: string) => () => parseNetworkList(text);

  test("loads the list and classifies with it", () => {
    const h = new ClassifierHolder(logger, {}, list("203.0.113.0/24 hosting-a\n"));
    expect(h.classifier).toBeUndefined();
    expect(h.reload()).toBe(true);
    expect(h.classifier?.classify("203.0.113.9", null)?.label).toBe("hosting-a");
  });

  test("an unreadable list at startup leaves scoring without one; on reload keeps the previous list", () => {
    let text: string | null = null;
    const h = new ClassifierHolder(logger, { INTEGRITY_DATACENTER_CIDRS_FILE: "/nope" }, () => {
      if (text === null) throw new Error("ENOENT");
      return parseNetworkList(text);
    });
    expect(h.reload()).toBe(false);
    expect(h.classifier).toBeUndefined();
    text = "198.51.100.0/24 first\n";
    expect(h.reload()).toBe(true);
    const first = h.classifier;
    text = null;
    expect(h.reload()).toBe(false);
    expect(h.classifier).toBe(first);
    text = "192.0.2.0/24 second\n";
    expect(h.reload()).toBe(true);
    expect(h.classifier?.classify("192.0.2.1", null)?.label).toBe("second");
    expect(h.classifier?.classify("198.51.100.1", null).hosting).toBe(false);
  });

  test("SIGHUP reloads; the returned function unregisters", () => {
    let loads = 0;
    const h = new ClassifierHolder(logger, {}, () => (loads++, parseNetworkList("")));
    const before = process.listenerCount("SIGHUP");
    const off = h.watchSighup();
    expect(process.listenerCount("SIGHUP")).toBe(before + 1);
    process.emit("SIGHUP");
    expect(loads).toBe(1);
    off();
    expect(process.listenerCount("SIGHUP")).toBe(before);
  });
});

describe("run lock lapses", () => {
  /** A Valkey stand-in: SET NX always succeeds, renewals answer `renew`, release succeeds. */
  function lockValkey(renew: () => Promise<unknown>) {
    const evals: string[] = [];
    const valkey = {
      set: async () => "OK",
      eval: (script: string) => {
        const kind = script.includes("pexpire") ? "renew" : "release";
        evals.push(kind);
        return kind === "renew" ? renew() : Promise.resolve(1);
      },
    } as unknown as ValkeyClient;
    return { valkey, evals };
  }
  const hold = (ms: number) => () => Bun.sleep(ms).then(() => "done");

  test("a failed renewal warns once with the job name and counts lock_lapsed; the run completes", async () => {
    const runs = vi.spyOn(metrics.integrityRuns, "add");
    const { logger: log, warnings } = recordingLogger();
    const { valkey, evals } = lockValkey(() => Promise.reject(new Error("connection lost")));
    const r = await withRunLock(
      valkey,
      "k",
      { ttlMs: 300, maxHoldMs: 60_000, job: "score-sessions", logger: log },
      hold(450),
    );
    expect(r).toEqual({ acquired: true, value: "done" });
    expect(evals.filter((e) => e === "renew").length).toBeGreaterThanOrEqual(2);
    expect(runs).toHaveBeenCalledTimes(1);
    expect(runs).toHaveBeenCalledWith(1, { job: "score-sessions", outcome: "lock_lapsed" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toEqual({ job: "score-sessions", reason: "renew_failed" });
  });

  test("a renewal that finds the lock taken over counts as a lapse", async () => {
    const runs = vi.spyOn(metrics.integrityRuns, "add");
    const { logger: log, warnings } = recordingLogger();
    const { valkey } = lockValkey(() => Promise.resolve(0));
    await withRunLock(valkey, "k", { ttlMs: 300, maxHoldMs: 60_000, job: "stream-hours", logger: log }, hold(250));
    expect(runs).toHaveBeenCalledWith(1, { job: "stream-hours", outcome: "lock_lapsed" });
    expect(warnings[0]?.fields).toEqual({ job: "stream-hours", reason: "lock_lost" });
  });

  test("reaching maxHoldMs stops renewing and counts a lapse", async () => {
    const runs = vi.spyOn(metrics.integrityRuns, "add");
    const { logger: log, warnings } = recordingLogger();
    const { valkey, evals } = lockValkey(() => Promise.resolve(1));
    await withRunLock(valkey, "k", { ttlMs: 300, maxHoldMs: 0, job: "follow-bursts", logger: log }, hold(350));
    expect(evals).toEqual(["release"]);
    expect(runs).toHaveBeenCalledTimes(1);
    expect(runs).toHaveBeenCalledWith(1, { job: "follow-bursts", outcome: "lock_lapsed" });
    expect(warnings[0]?.fields).toEqual({ job: "follow-bursts", reason: "max_hold" });
  });

  test("healthy renewals and a quick run report nothing", async () => {
    const runs = vi.spyOn(metrics.integrityRuns, "add");
    const { logger: log, warnings } = recordingLogger();
    const { valkey, evals } = lockValkey(() => Promise.resolve(1));
    await withRunLock(valkey, "k", { ttlMs: 300, maxHoldMs: 60_000, job: "verify-receipts", logger: log }, hold(250));
    expect(evals.filter((e) => e === "renew").length).toBeGreaterThanOrEqual(1);
    expect(runs).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });

  test("a run that finishes while a renewal is in flight is not reported", async () => {
    const runs = vi.spyOn(metrics.integrityRuns, "add");
    const { logger: log, warnings } = recordingLogger();
    // The renewal resolves only after the run has released the lock (and finds it gone).
    const { valkey } = lockValkey(() => Bun.sleep(200).then(() => 0));
    await withRunLock(valkey, "k", { ttlMs: 300, maxHoldMs: 60_000, job: "score-sessions", logger: log }, hold(150));
    await Bun.sleep(300);
    expect(runs).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });
});

describe("ClassifierHolder: empty reloads", () => {
  test("entryCount counts ranges and ASNs", () => {
    expect(entryCount(parseNetworkList("").classifier)).toBe(0);
    expect(entryCount(parseNetworkList("# only a comment\n\nnot-a-cidr\n").classifier)).toBe(0);
    expect(entryCount(parseNetworkList("203.0.113.0/24 a\n2001:db8::/32 b\nAS64500 c\n").classifier)).toBe(3);
  });

  test("a reload that parses to no entries keeps the previous list and warns", () => {
    let text = "203.0.113.0/24 hosting-a\n";
    const { logger: log, warnings } = recordingLogger();
    const h = new ClassifierHolder(log, {}, () => parseNetworkList(text));
    expect(h.reload()).toBe(true);
    const good = h.classifier;
    text = ""; // truncated, e.g. caught mid-write
    expect(h.reload()).toBe(false);
    expect(h.classifier).toBe(good);
    expect(h.classifier?.classify("203.0.113.9", null).hosting).toBe(true);
    expect(warnings.map((w) => w.msg)).toEqual(["network list reload parsed to no entries; keeping the previous list"]);
    expect(warnings[0]?.fields).toMatchObject({ previous: 1 });
    text = "garbage only\n";
    expect(h.reload()).toBe(false);
    expect(h.classifier).toBe(good);
    text = "198.51.100.0/24 hosting-b\n";
    expect(h.reload()).toBe(true);
    expect(h.classifier?.classify("198.51.100.1", null)?.label).toBe("hosting-b");
  });

  test("an empty list is accepted when there was none before", () => {
    const h = new ClassifierHolder(logger, {}, () => parseNetworkList(""));
    expect(h.reload()).toBe(true);
    expect(h.reload()).toBe(true);
    expect(h.classifier?.classify("203.0.113.9", null).hosting).toBe(false);
  });
});
