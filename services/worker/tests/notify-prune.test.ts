// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `notify-prune`'s pure parts: the cutoffs, the batch statement, the job definition. */
import { NOTIFY_JOBS, NotifyPruneJob, OPS_TICK_JOBS, QUEUES } from "@commonair/contracts/internal";
import { NOTIFY_RULES } from "@commonair/contracts/notify";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vite-plus/test";
import { JOBS } from "../src/jobs/index.ts";
import { job } from "../src/jobs/notify-prune.ts";
import { pruneBatch, pruneCutoffs, pruneRules } from "../src/notify/prune/prune.ts";

const NOW = new Date("2026-10-30T12:00:00.000Z");
const DAY = 86_400_000;

describe("pruneCutoffs", () => {
  test("defaults: 90 days for every row, 30 for read go_live rows", () => {
    expect(NOTIFY_RULES.retentionDays).toBe(90);
    expect(NOTIFY_RULES.readGoLiveRetentionDays).toBe(30);
    const c = pruneCutoffs(NOW);
    expect(c.all.toISOString()).toBe(new Date(NOW.getTime() - 90 * DAY).toISOString());
    expect(c.readGoLive.toISOString()).toBe(new Date(NOW.getTime() - 30 * DAY).toISOString());
  });

  test("overrides", () => {
    const c = pruneCutoffs(NOW, 1, 0);
    expect(c.all.getTime()).toBe(NOW.getTime() - DAY);
    expect(c.readGoLive.getTime()).toBe(NOW.getTime());
  });
});

describe("the statements", () => {
  const dialect = new PgDialect();
  const rules = pruneRules(pruneCutoffs(NOW));

  test("strict 'older than': created_at < cutoff", () => {
    const all = dialect.sqlToQuery(rules.all);
    expect(all.sql).toBe("created_at < $1::timestamptz");
    expect(all.params).toEqual([new Date(NOW.getTime() - 90 * DAY).toISOString()]);
    const read = dialect.sqlToQuery(rules.readGoLive);
    expect(read.sql).toBe("created_at < $1::timestamptz and type = 'go_live' and read_at is not null");
  });

  test("one batch is one DELETE of the oldest rows by id", () => {
    const q = dialect.sqlToQuery(pruneBatch(rules.all, 5_000));
    const flat = q.sql.replace(/\s+/g, " ").trim();
    expect(flat).toBe(
      "with d as ( delete from notifications where id in (select id from notifications where created_at < $1::timestamptz order by created_at limit $2) returning created_at) select count(*)::int as n, max(created_at)::text as last from d",
    );
    expect(q.params[1]).toBe(5_000);
  });

  test("a later batch starts at the previous batch's newest row, inclusive", () => {
    const from = "2026-08-01 11:00:00.123456+00";
    const q = dialect.sqlToQuery(pruneBatch(rules.readGoLive, 5_000, from));
    const flat = q.sql.replace(/\s+/g, " ").trim();
    expect(flat).toContain(
      "where created_at < $1::timestamptz and type = 'go_live' and read_at is not null and created_at >= $2::timestamptz order by created_at limit $3",
    );
    expect(q.params[1]).toBe(from);
    expect(q.params[2]).toBe(5_000);
  });
});

describe("the job", () => {
  test("is registered on the retention queue, scheduled, ops-tickable, with empty data", () => {
    expect(job.queue).toBe(QUEUES.retention);
    expect(job.name).toBe(NOTIFY_JOBS.prune);
    expect(job.data).toBe(NotifyPruneJob);
    expect(job.schedule).toEqual({ every: NOTIFY_RULES.pruneEveryMs });
    expect(job.attempts).toBe(1);
    expect(JOBS).toContain(job);
    expect(OPS_TICK_JOBS).toContain(NOTIFY_JOBS.prune);
    expect(job.data.safeParse({}).success).toBe(true);
  });
});
