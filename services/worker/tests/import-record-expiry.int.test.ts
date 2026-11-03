// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `import-record-expiry` (batch 8 decision (j)) against a real database: 30 days after a Twitch
 * import finished its `preview` and `result` are cleared, while the status, source, times and
 * assertion fields stay; bundle imports and anything younger are left alone; an import still running
 * is skipped; each run writes one `audit_log` row with a count and no names.
 */
import { B8_JOBS, QUEUES } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import type { WorkerContext } from "../src/context.ts";
import { job } from "../src/jobs/import-record-expiry.ts";
import { expireImportRecords, IMPORT_RECORD_RETENTION_DAYS } from "../src/portability/record-expiry.ts";
import { makeUser, quietLogger } from "./fixtures.ts";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
}, 120_000);
afterAll(() => t?.drop());

const NOW = new Date("2026-12-10T04:19:00Z");
const DAY = 86_400_000;
const warns: unknown[] = [];
const ctx = () =>
  ({
    db: t.app.db,
    now: () => NOW,
    logger: { ...quietLogger, info: () => {}, warn: (...a: unknown[]) => warns.push(a) },
  }) as unknown as WorkerContext;

const TWITCH_LOGIN = "somebody_on_twitch";
const preview = { twitch: { user: { login: TWITCH_LOGIN, displayName: "Somebody" } } };
const result = [{ kind: "channel", ref: "channel", label: "My stream", outcome: "imported", reason: null }];

async function importRow(
  channel: { id: string; ownerId: string },
  o: {
    source?: "twitch" | "commonair";
    status: "previewed" | "queued" | "running" | "done" | "failed";
    finishedAt: Date | null;
    createdAt?: Date;
  },
) {
  const id = uuidv7();
  const source = o.source ?? "twitch";
  await t.db.insert(schema.portabilityImports).values({
    id,
    userId: channel.ownerId,
    channelId: channel.id,
    source,
    status: o.status,
    preview,
    choices: { channel: true, panels: false, emotes: [] },
    result,
    assertedAt: new Date(NOW.getTime() - 40 * DAY),
    assertionVersion: "2026-10-twitch-emotes-v1",
    createdAt: o.createdAt ?? new Date(NOW.getTime() - 40 * DAY),
    finishedAt: o.finishedAt,
  });
  return id;
}

const rowOf = async (id: string) =>
  (await t.db.select().from(schema.portabilityImports).where(eq(schema.portabilityImports.id, id)))[0]!;

const audits = () =>
  t.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, "portability.import.expire"), eq(schema.auditLog.actorType, "system")));

test("is the portability queue's daily job", () => {
  expect(job.queue).toBe(QUEUES.portability);
  expect(job.name).toBe(B8_JOBS.importRecordExpiry);
  expect(job.schedule).toEqual({ pattern: "19 4 * * *" });
  expect(IMPORT_RECORD_RETENTION_DAYS).toBe(30);
});

test("the 30-day boundary, the kept columns, bundles and running imports, and one audit row a run", async () => {
  const { channel } = await makeUser(t.db);
  const cutoff = new Date(NOW.getTime() - 30 * DAY);
  const due = await importRow(channel, { status: "done", finishedAt: cutoff });
  const failed = await importRow(channel, { status: "failed", finishedAt: new Date(cutoff.getTime() - DAY) });
  const young = await importRow(channel, { status: "done", finishedAt: new Date(cutoff.getTime() + 1) });
  const bundle = await importRow(channel, { source: "commonair", status: "done", finishedAt: cutoff });
  const running = await importRow(channel, { status: "running", finishedAt: null });
  const before = await rowOf(due);

  expect(await expireImportRecords(ctx())).toEqual({ cleared: 2, stuck: 1 });

  for (const id of [due, failed]) {
    const r = await rowOf(id);
    expect(r.preview).toEqual({});
    expect(r.result).toBeNull();
  }
  // The audit trail stays: status, source, times and the assertion.
  const after = await rowOf(due);
  expect(after).toMatchObject({
    status: "done",
    source: "twitch",
    createdAt: before.createdAt,
    finishedAt: before.finishedAt,
    assertedAt: before.assertedAt,
    assertionVersion: before.assertionVersion,
    choices: before.choices,
  });
  expect((await rowOf(failed)).status).toBe("failed");
  for (const id of [young, bundle, running]) {
    const r = await rowOf(id);
    expect(r.preview).toEqual(preview);
    expect(r.result).toEqual(result);
  }
  expect(warns).toHaveLength(1);

  const [a] = await audits();
  expect(a).toMatchObject({
    actorId: null,
    subjectType: "job_run",
    details: { source: "twitch", cleared: 2, stuck: 1 },
  });
  expect(JSON.stringify(a)).not.toContain(TWITCH_LOGIN);

  // The next run clears nothing more and still records that it ran.
  expect(await expireImportRecords(ctx())).toEqual({ cleared: 0, stuck: 1 });
  expect((await audits()).map((r) => (r.details as { cleared: number }).cleared).sort((a, b) => a - b)).toEqual([0, 2]);
});
