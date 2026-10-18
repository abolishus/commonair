// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SegmentFetch } from "@commonair/contracts/internal";
import { QUEUES } from "@commonair/contracts/internal";
import { parseNetworkList } from "@commonair/integrity";
import { createLogger } from "@commonair/observability";
import { describe, expect, test } from "vite-plus/test";
import { DEFAULT_CONCURRENCY } from "../src/env.ts";
import { ClassifierHolder } from "../src/integrity/classifier.ts";
import { fetchEvidence } from "../src/integrity/fetches.ts";
import {
  INTEGRITY_BATCH,
  INTEGRITY_JOBS,
  INTEGRITY_SCHEDULES,
  integrityJobs,
  runLockKey,
} from "../src/integrity/jobs.ts";
import { JOBS } from "../src/jobs/index.ts";
import { buildRegistry, scheduledJobs } from "../src/runtime/registry.ts";
import { schedulerTemplate } from "../src/runtime/runtime.ts";

const logger = createLogger({ service: "worker-test", level: "fatal" });

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
