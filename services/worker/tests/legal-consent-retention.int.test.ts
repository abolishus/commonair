// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Consent retention: old anonymous rows go in batches; recent anonymous rows and signed-in rows stay. */
import { schema, uuidv7 } from "@commonair/db";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { JOBS } from "../src/jobs/index.ts";
import { ANONYMOUS_CONSENT_RETENTION_DAYS, deleteOldAnonymousConsent } from "../src/legal/consent-retention.ts";
import { makeUser, setup, type TestEnv } from "./fixtures.ts";

let env: TestEnv;
beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false });
});
afterAll(() => env.close());

const DAY = 86_400_000;
const ctx = () => env.worker.ctx;
const daysAgo = (d: number) => new Date(ctx().now().getTime() - d * DAY);
const OLD = ANONYMOUS_CONSENT_RETENTION_DAYS + 1;
const RECENT = ANONYMOUS_CONSENT_RETENTION_DAYS - 1;

async function consent(createdAt: Date, userId: string | null = null): Promise<string> {
  const id = uuidv7();
  await env.t.db.insert(schema.consentRecords).values({
    id,
    userId,
    anonymousId: userId ? null : crypto.randomUUID().replace(/-/g, ""),
    choices: { essential: true, preferences: false },
    policyVersion: "test",
    createdAt,
  });
  return id;
}

async function remaining(ids: readonly string[]): Promise<string[]> {
  const rows = await env.t.db
    .select({ id: schema.consentRecords.id })
    .from(schema.consentRecords)
    .where(inArray(schema.consentRecords.id, [...ids]));
  return rows.map((r) => r.id).sort();
}

beforeEach(async () => {
  await env.t.db.delete(schema.consentRecords);
});

describe("deleteOldAnonymousConsent", () => {
  test("deletes old anonymous rows; keeps recent anonymous rows and every signed-in row", async () => {
    const { user } = await makeUser(env.t.db);
    const old = [await consent(daysAgo(OLD)), await consent(daysAgo(OLD + 400))];
    const recent = [await consent(daysAgo(RECENT)), await consent(new Date())];
    const signedIn = [await consent(daysAgo(OLD + 400), user.id), await consent(daysAgo(1), user.id)];

    expect(await deleteOldAnonymousConsent(ctx())).toEqual({ deleted: 2 });
    expect(await remaining(old)).toEqual([]);
    expect(await remaining([...recent, ...signedIn])).toEqual([...recent, ...signedIn].sort());
  });

  test("works through every batch when the budget allows", async () => {
    const old = await Promise.all(Array.from({ length: 7 }, (_, i) => consent(daysAgo(OLD + i))));
    expect(await deleteOldAnonymousConsent(ctx(), { batchSize: 2 })).toEqual({ deleted: 7 });
    expect(await remaining(old)).toEqual([]);
  });

  test("stops after the batch that spends the budget, oldest first; the next run finishes", async () => {
    const old = await Promise.all(Array.from({ length: 5 }, (_, i) => consent(daysAgo(OLD + i))));
    // Each clock read moves 20 s: the first batch ends 20 s in, the second 40 s in (over 30 s).
    let t = 0;
    const clock = () => (t += 20_000) - 20_000;
    expect(await deleteOldAnonymousConsent(ctx(), { batchSize: 2, clock })).toEqual({ deleted: 4 });
    // The newest of the five (OLD + 0 days) is the one left.
    expect(await remaining(old)).toEqual([old[0]]);
    expect(await deleteOldAnonymousConsent(ctx(), { batchSize: 2 })).toEqual({ deleted: 1 });
    expect(await remaining(old)).toEqual([]);
  });

  test("idempotent: a second run deletes nothing", async () => {
    await consent(daysAgo(OLD));
    const keep = await consent(daysAgo(RECENT));
    expect(await deleteOldAnonymousConsent(ctx())).toEqual({ deleted: 1 });
    expect(await deleteOldAnonymousConsent(ctx())).toEqual({ deleted: 0 });
    expect(await remaining([keep])).toEqual([keep]);
  });

  test("the scheduled job runs it", async () => {
    const old = await consent(daysAgo(OLD));
    const job = JOBS.find((j) => j.name === "legal-consent-retention");
    expect(job?.schedule).toEqual({ pattern: "23 3 * * *" });
    expect(await job?.handler({}, ctx(), { id: undefined, attemptsMade: 0 })).toEqual({ deleted: 1 });
    expect(await remaining([old])).toEqual([]);
  });
});
