// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { describe, expect, test } from "vite-plus/test";
import { z } from "zod";
import { creditSeconds } from "../src/counters.ts";
import { DEFAULT_CONCURRENCY, parseConcurrency, QUEUE_NAMES, type QueueName } from "../src/env.ts";
import { JOBS } from "../src/jobs/index.ts";
import { WEBHOOK_JOBS } from "../src/jobs/names.ts";
import { toBusEvent, withTimeout } from "../src/outbox.ts";
import { AdaptiveDelay } from "../src/runtime/loop.ts";
import { buildRegistry, defineJob, scheduledJobs } from "../src/runtime/registry.ts";

const noop = async () => undefined;
const job = (queue: string, name: string, extra: Record<string, unknown> = {}) =>
  defineJob({ queue: queue as QueueName, name, description: "", data: z.object({}), handler: noop, ...extra });

describe("job registry", () => {
  test("the shipped registry loads, has every webhook job and valid schedules", () => {
    const reg = buildRegistry(JOBS);
    const webhooks = reg.get(QUEUES.webhooks);
    for (const name of Object.values(WEBHOOK_JOBS)) expect(webhooks?.has(name)).toBe(true);
    const scheduled = scheduledJobs(reg).map((j) => j.name);
    expect(scheduled).toEqual(
      expect.arrayContaining([
        "live-counters",
        "close-stale-sessions",
        "relays-offline",
        "expire-auth-rows",
        "prune-webhook-deliveries",
        "vod-retention",
      ]),
    );
    for (const j of scheduledJobs(reg)) expect(j.data.safeParse({}).success).toBe(true);
    expect(reg.get(QUEUES.integrity)?.get("live-counters")?.schedule).toEqual({ every: 10_000 });
  });

  test("rejects duplicates, unknown queues, bad names and sub-second schedules", () => {
    expect(() => buildRegistry([job("webhooks", "a"), job("webhooks", "a")])).toThrow(/registered twice/);
    expect(() => buildRegistry([job("nope", "a")])).toThrow(/unknown queue/);
    expect(() => buildRegistry([job("webhooks", "Bad_Name")])).toThrow(/kebab-case/);
    expect(() => buildRegistry([job("webhooks", "fast", { schedule: { every: 10 } })])).toThrow(/once per second/);
  });

  test("the same name may exist on different queues", () => {
    const reg = buildRegistry([job("webhooks", "a"), job("retention", "a")]);
    expect(reg.get("webhooks")?.has("a")).toBe(true);
    expect(reg.get("retention")?.has("a")).toBe(true);
  });
});

describe("parseConcurrency", () => {
  test("defaults, overrides and validation", () => {
    expect(parseConcurrency("")).toEqual(DEFAULT_CONCURRENCY);
    const c = parseConcurrency(" webhooks = 8 , retention=2");
    expect(c.webhooks).toBe(8);
    expect(c.retention).toBe(2);
    expect(Object.keys(c).sort()).toEqual([...QUEUE_NAMES].sort());
    expect(() => parseConcurrency("nope=1")).toThrow(/unknown queue/);
    expect(() => parseConcurrency("webhooks=0")).toThrow(/integer/);
    expect(() => parseConcurrency("webhooks=1.5")).toThrow(/integer/);
    expect(() => parseConcurrency("webhooks")).toThrow(/integer/);
  });
});

describe("AdaptiveDelay", () => {
  test("no sleep on a full batch, min after some work, doubling to max when idle", () => {
    const d = new AdaptiveDelay(50, 1000);
    expect(d.next("full")).toBe(0);
    expect(d.next("none")).toBe(100);
    expect(d.next("none")).toBe(200);
    expect(d.next("none")).toBe(400);
    expect(d.next("none")).toBe(800);
    expect(d.next("none")).toBe(1000);
    expect(d.next("none")).toBe(1000);
    expect(d.next("some")).toBe(50);
    expect(d.next("error")).toBe(1000);
    expect(d.next("full")).toBe(0);
  });
});

describe("creditSeconds", () => {
  const now = 1_000_000;
  test("measures since the previous tick, capped", () => {
    expect(creditSeconds(now, now - 10_000, 0, 10, 30)).toBe(10);
    expect(creditSeconds(now, now - 9_500, 0, 10, 30)).toBe(9.5);
    expect(creditSeconds(now, now - 600_000, 0, 10, 30)).toBe(30);
  });
  test("first tick credits one nominal tick, but never before the broadcast started", () => {
    expect(creditSeconds(now, null, now - 60_000, 10, 30)).toBe(10);
    expect(creditSeconds(now, null, now - 4_000, 10, 30)).toBe(4);
  });
  test("clock skew never credits negative time", () => {
    expect(creditSeconds(now, now + 5_000, 0, 10, 30)).toBe(0);
    expect(creditSeconds(now, null, now + 5_000, 10, 30)).toBe(0);
  });
});

describe("toBusEvent", () => {
  const base = {
    id: "0193e6a0-0000-7000-8000-000000000001",
    type: "stream.offline",
    version: "1",
    channelId: "0193e6a0-0000-7000-8000-000000000002",
    payload: { broadcaster_user_id: "b", broadcaster_user_login: "l", broadcaster_user_name: "N", extra: "x" },
    occurredAt: new Date("2026-03-04T05:06:07Z"),
    publishedAt: null,
  };
  test("valid rows become bus events with unknown payload keys stripped", () => {
    const r = toBusEvent(base);
    expect(r.ok && r.event).toEqual({
      id: base.id,
      type: "stream.offline",
      version: "1",
      channelId: base.channelId,
      payload: { broadcaster_user_id: "b", broadcaster_user_login: "l", broadcaster_user_name: "N" },
      occurredAt: "2026-03-04T05:06:07.000Z",
    });
  });
  test("unknown types, versions and invalid payloads are rejected with a reason", () => {
    expect(toBusEvent({ ...base, type: "made.up" })).toEqual({ ok: false, reason: "unknown event type" });
    expect(toBusEvent({ ...base, version: "2" })).toEqual({ ok: false, reason: "unsupported version 2" });
    const bad = toBusEvent({ ...base, payload: { broadcaster_user_id: 5 } });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.reason).toContain("broadcaster_user_id");
  });
  test("prototype keys are not event types", () => {
    expect(toBusEvent({ ...base, type: "constructor" }).ok).toBe(false);
  });
});

describe("withTimeout", () => {
  test("passes results through and rejects slow calls", async () => {
    expect(await withTimeout(Promise.resolve(3), 100, "x")).toBe(3);
    await expect(withTimeout(new Promise(() => {}), 20, "bus publish")).rejects.toThrow(/bus publish timed out/);
    await expect(withTimeout(Promise.reject(new Error("boom")), 100, "x")).rejects.toThrow("boom");
  });
});

describe("webhook job retries", () => {
  test("deliver and fanout survive long infrastructure outages", () => {
    const webhooks = buildRegistry(JOBS).get(QUEUES.webhooks);
    for (const name of [WEBHOOK_JOBS.deliver, WEBHOOK_JOBS.fanout]) {
      const def = webhooks?.get(name);
      expect(def?.attempts).toBeGreaterThanOrEqual(10);
      // Sum of the exponential series: the total retry window spans several hours.
      const windowMs = (def?.backoffMs ?? 0) * (2 ** ((def?.attempts ?? 1) - 1) - 1);
      expect(windowMs).toBeGreaterThan(4 * 3_600_000);
    }
  });
});
