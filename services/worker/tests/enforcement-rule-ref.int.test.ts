// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `rule_ref` on the worker's live-classifier cases (batch 6 decision (d), ADR 0019): a T1 case
 * cites its category's clause and a T2 case the mature-label clause, the same clause the
 * statement built from the action cites. As the app role, against Postgres.
 */
import { schema, seedLegalDocuments, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, test, vi } from "vite-plus/test";
import type { WorkerContext } from "../src/context.ts";
import { applyT1, applyT2 } from "../src/moderation/scan.ts";
import { buildStatements } from "../src/moderation/sor-build.ts";
import { makeBroadcast, makeUser, quietLogger } from "./fixtures.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
  await seedLegalDocuments(t.db);
}, 60_000);
afterAll(() => t?.drop());

const ctx = (): WorkerContext =>
  ({ db: t.app.db, sql: t.app.sql, logger: quietLogger, now: () => new Date() }) as unknown as WorkerContext;

async function live() {
  const { channel } = await makeUser(t.db);
  const b = await makeBroadcast(t.db, channel.id);
  const job = {
    frameId: uuidv7(),
    broadcastId: b.id,
    channelId: channel.id,
    capturedAt: new Date().toISOString(),
    pdq: null,
    quality: 90,
  };
  const common = {
    job,
    channel,
    flagId: uuidv7(),
    frameKey: `moderation/frames/${uuidv7()}.jpg`,
    candidateCaseId: uuidv7(),
    capturedAt: new Date(job.capturedAt),
    provider: "test",
    providerVersion: "1",
  };
  return common;
}

const caseOf = async (id: string) =>
  (await t.db.select().from(schema.moderationCases).where(eq(schema.moderationCases.id, id)))[0];

test("a T1 case cites its category's clause; a second flag on it changes nothing", async () => {
  const input = await live();
  const out = await applyT1(ctx(), { ...input, category: "self_harm", score: 0.99 });
  expect((await caseOf(out.caseId))?.ruleRef).toBe("safety.self-harm@1");
  const again = await applyT1(ctx(), { ...input, flagId: uuidv7(), category: "weapons", score: 0.99 });
  expect(again.caseId).toBe(out.caseId);
  expect((await caseOf(out.caseId))?.ruleRef).toBe("safety.self-harm@1");
});

test("a T2 case cites the mature-label clause, as its statement does", async () => {
  const input = await live();
  const out = await applyT2(ctx(), { ...input, score: 0.85 });
  expect((await caseOf(out.caseId))?.ruleRef).toBe("mature.unlabelled@1");
  await buildStatements(ctx());
  const statements = await t.db
    .select()
    .from(schema.enforcementStatements)
    .where(eq(schema.enforcementStatements.sourceAction, "moderation.t2.label"));
  expect(statements.map((s) => `${s.clauseId}@${s.clauseVersion}`)).toContain("mature.unlabelled@1");
});
