// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Data exports, the deletion-scheduled email and the ops test hook (docs/testing/e6-selectors.md
 * "Data export", "Stack and test hooks"; ADR 0021). The worker side (building archives, running the
 * jobs) is services/worker's; here a BullMQ worker on a private prefix stands in for it.
 */
import { Queue, Worker } from "bullmq";
import { Valkey } from "iovalkey";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  EXPORT_COOLDOWN_SECONDS,
  EXPORT_JOBS,
  EXPORT_TTL_SECONDS,
  INTERNAL_ROUTES,
  INTERNAL_SECRET_HEADER,
  QUEUES,
  exportObjectKey,
} from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import { setOpsTickRunner, createOpsTickRunner } from "../src/ops/hooks.ts";
import { client, mailTo, signUpAndSignIn, startApi, uniqueName, VALKEY_URL, waitFor, type TestApi } from "./harness.ts";

let api: TestApi;
type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
let u: User;
let v: User;
const prefix = `test-ops-${crypto.randomUUID()}`;
const conns: Valkey[] = [];
const workers: Worker[] = [];

beforeAll(async () => {
  api = await startApi({ env: { OPS_TEST_HOOKS: "true", WORKER_BULL_PREFIX: prefix } });
  [u, v] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
}, 120_000);
afterAll(async () => {
  for (const w of workers) await w.close();
  for (const c of conns) c.disconnect();
  await api?.stop();
});

const db = () => api.db.db;
type Job = {
  id: string;
  kind: string;
  status: string;
  downloadUrl: string | null;
  expiresAt: string | null;
  completedAt: string | null;
};

const connection = () => {
  const c = new Valkey(VALKEY_URL, { maxRetriesPerRequest: null });
  conns.push(c);
  return c;
};

/** A user who owns no channel: their signup channel is handed to a placeholder account. */
async function withoutChannel(user: User) {
  const name = uniqueName("p");
  const [parked] = await db()
    .insert(schema.users)
    .values({ name, email: `${name}@test.invalid`, username: name, emailVerified: true })
    .returning({ id: schema.users.id });
  if (!parked) throw new Error("no user");
  await db().update(schema.channels).set({ ownerId: parked.id }).where(eq(schema.channels.ownerId, user.userId));
}

describe("me.exports", () => {
  test("create queues the export, audits it and enqueues the build with the export id as job id", async () => {
    const r = await u.client.call<Job>("POST", "/api/me/exports", { kind: "account" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kind: "account", status: "queued", downloadUrl: null, expiresAt: null });
    const [row] = await db().select().from(schema.dataExports).where(eq(schema.dataExports.id, r.body.id));
    expect(row?.userId).toBe(u.userId);
    const [a] = await db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, "export.request"), eq(schema.auditLog.subjectId, r.body.id)));
    expect(a?.actorId).toBe(u.userId);
    expect(a?.details).toEqual({ kind: "account" });
    const q = new Queue(QUEUES.exports, { connection: connection(), prefix });
    const job = await q.getJob(r.body.id);
    expect(job?.name).toBe(EXPORT_JOBS.build);
    expect(job?.data).toEqual({ exportId: r.body.id });
    await q.close();
  });

  test("a second request of the same kind within the cooldown is RATE_LIMITED; another kind is not", async () => {
    const again = await u.client.call<{ code: string; data: { retryAfterSeconds: number } }>(
      "POST",
      "/api/me/exports",
      {
        kind: "account",
      },
    );
    expect(again.status).toBe(429);
    expect(again.body.code).toBe("RATE_LIMITED");
    expect(again.body.data.retryAfterSeconds).toBeGreaterThan(EXPORT_COOLDOWN_SECONDS - 120);
    expect(again.body.data.retryAfterSeconds).toBeLessThanOrEqual(EXPORT_COOLDOWN_SECONDS);
    expect(Number(again.res.headers.get("retry-after"))).toBe(again.body.data.retryAfterSeconds);
    expect((await u.client.call("POST", "/api/me/exports", { kind: "channel" })).status).toBe(200);
    // A failed export does not hold the cooldown.
    await db()
      .update(schema.dataExports)
      .set({ status: "failed", error: "test" })
      .where(and(eq(schema.dataExports.userId, u.userId), eq(schema.dataExports.kind, "channel")));
    expect((await u.client.call("POST", "/api/me/exports", { kind: "channel" })).status).toBe(200);
    // Past the window: allowed again.
    await db()
      .update(schema.dataExports)
      .set({ createdAt: new Date(Date.now() - (EXPORT_COOLDOWN_SECONDS + 1) * 1000) })
      .where(and(eq(schema.dataExports.userId, u.userId), eq(schema.dataExports.kind, "account")));
    expect((await u.client.call("POST", "/api/me/exports", { kind: "account" })).status).toBe(200);
  });

  test("two concurrent requests: exactly one passes", async () => {
    const w = await signUpAndSignIn(api);
    const rs = await Promise.all([
      w.client.call("POST", "/api/me/exports", { kind: "account" }),
      w.client.call("POST", "/api/me/exports", { kind: "account" }),
      w.client.call("POST", "/api/me/exports", { kind: "account" }),
    ]);
    expect(rs.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 429, 429]);
    const rows = await db().select().from(schema.dataExports).where(eq(schema.dataExports.userId, w.userId));
    expect(rows).toHaveLength(1);
  });

  test("a channel export needs a channel the user owns", async () => {
    const w = await signUpAndSignIn(api);
    await withoutChannel(w);
    const r = await w.client.call<{ code: string }>("POST", "/api/me/exports", { kind: "channel" });
    expect(r.status).toBe(412);
    expect(r.body.code).toBe("PRECONDITION_FAILED");
    expect((await w.client.call("POST", "/api/me/exports", { kind: "account" })).status).toBe(200);
    expect((await client(api).call("POST", "/api/me/exports", { kind: "account" })).status).toBe(401);
  });

  test("list: own exports only; a link only while ready, unexpired and on the export's own key", async () => {
    const mine = await u.client.call<Job[]>("GET", "/api/me/exports");
    expect(mine.status).toBe(200);
    expect(mine.body.length).toBeGreaterThanOrEqual(3);
    expect(mine.body.every((j) => j.downloadUrl === null)).toBe(true);
    const theirs = await v.client.call<Job[]>("GET", "/api/me/exports");
    const mineIds = new Set(mine.body.map((j) => j.id));
    expect(theirs.body.some((j) => mineIds.has(j.id))).toBe(false);
    // Newest first.
    const created = mine.body.map((j) => j.id);
    expect([...created].sort().reverse()).toEqual(created);

    const target = mine.body[0];
    if (!target) throw new Error("no export");
    const key = exportObjectKey(u.userId, target.id);
    const completedAt = new Date();
    const expiresAt = new Date(completedAt.getTime() + EXPORT_TTL_SECONDS * 1000);
    const setRow = (set: Partial<typeof schema.dataExports.$inferInsert>) =>
      db().update(schema.dataExports).set(set).where(eq(schema.dataExports.id, target.id));
    await setRow({ status: "ready", storageKey: key, completedAt, expiresAt, sizeBytes: 1234 });
    const ready = (await u.client.call<Job[]>("GET", "/api/me/exports")).body.find((j) => j.id === target.id);
    expect(ready?.status).toBe("ready");
    expect(ready?.expiresAt).toBe(expiresAt.toISOString());
    const link = new URL(ready?.downloadUrl ?? "http://missing.invalid");
    expect(link.pathname).toBe(`/${api.deps.env.S3_BUCKET_EXPORTS}/${key}`);
    const ttl = Number(link.searchParams.get("X-Amz-Expires"));
    expect(ttl).toBeGreaterThan(EXPORT_TTL_SECONDS - 60);
    expect(ttl).toBeLessThanOrEqual(EXPORT_TTL_SECONDS);
    expect(link.searchParams.get("response-content-disposition")).toMatch(
      /^attachment; filename=".+-account-\d{4}-\d{2}-\d{2}\.zip"$/,
    );
    // Never listed for anyone else.
    expect((await v.client.call<Job[]>("GET", "/api/me/exports")).body.some((j) => j.id === target.id)).toBe(false);

    // The link expires with the export.
    await setRow({ expiresAt: new Date(Date.now() + 90_000) });
    const soon = (await u.client.call<Job[]>("GET", "/api/me/exports")).body.find((j) => j.id === target.id);
    const soonTtl = Number(new URL(soon?.downloadUrl ?? "http://x.invalid").searchParams.get("X-Amz-Expires"));
    expect(soonTtl).toBeGreaterThan(0);
    expect(soonTtl).toBeLessThanOrEqual(90);

    await setRow({ expiresAt: new Date(Date.now() - 1000) });
    const lapsed = (await u.client.call<Job[]>("GET", "/api/me/exports")).body.find((j) => j.id === target.id);
    expect(lapsed?.downloadUrl).toBeNull();
    expect(lapsed?.status).toBe("expired");

    // A key that is not the export's own is never signed.
    await setRow({ expiresAt, storageKey: exportObjectKey(v.userId, target.id) });
    expect(
      (await u.client.call<Job[]>("GET", "/api/me/exports")).body.find((j) => j.id === target.id)?.downloadUrl,
    ).toBeNull();
    await setRow({ storageKey: "exports/../secrets.zip" });
    expect(
      (await u.client.call<Job[]>("GET", "/api/me/exports")).body.find((j) => j.id === target.id)?.downloadUrl,
    ).toBeNull();

    // Not ready: no link even with the right key.
    await setRow({ status: "running", storageKey: key });
    expect(
      (await u.client.call<Job[]>("GET", "/api/me/exports")).body.find((j) => j.id === target.id)?.downloadUrl,
    ).toBeNull();
  });
});

describe("me.deletion.request", () => {
  test("emails the scheduled date to the account's address, once", async () => {
    const w = await signUpAndSignIn(api);
    const r = await w.client.call<{ status: string }>("POST", "/api/me/deletion", { confirmUsername: w.username });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("scheduled");
    const mail = await waitFor(async () => {
      const m = await mailTo(w.email);
      return m && m.text.includes("/settings/privacy") ? m : null;
    }, 10_000);
    expect(mail.text).toContain(`${api.url}/settings/privacy`);
  });
});

describe("ops test hook", () => {
  const tick = (body: unknown, secret: string | null = api.internalSecret) =>
    fetch(`${api.url}${INTERNAL_ROUTES.opsTick}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret ? { [INTERNAL_SECRET_HEADER]: secret } : {}) },
      body: JSON.stringify(body),
    });

  test("404 while off (before the secret check); 401 without the secret; 400 for an unknown job", async () => {
    const env = api.deps.env as { OPS_TEST_HOOKS: boolean };
    env.OPS_TEST_HOOKS = false;
    try {
      expect((await tick({ job: "vod-retention" })).status).toBe(404);
      expect((await tick({ job: "vod-retention" }, null)).status).toBe(404);
    } finally {
      env.OPS_TEST_HOOKS = true;
    }
    expect((await tick({ job: "vod-retention" }, null)).status).toBe(401);
    expect((await tick({ job: "vod-retention" }, "wrong")).status).toBe(401);
    expect((await tick({ job: "nope" })).status).toBe(400);
    expect(
      (
        await fetch(`${api.url}${INTERNAL_ROUTES.opsTick}`, {
          headers: { [INTERNAL_SECRET_HEADER]: api.internalSecret },
        })
      ).status,
    ).toBe(405);
  });

  test("enqueues each job on its queue under the worker prefix and returns its counts", async () => {
    const seen: string[] = [];
    const answers: Record<string, Record<string, number>> = {
      [QUEUES.retention]: { deleted: 2, held: 1 },
      [QUEUES.deletions]: { completed: 1 },
      [QUEUES.exports]: { expired: 3 },
    };
    for (const queue of [QUEUES.retention, QUEUES.deletions, QUEUES.exports])
      workers.push(
        new Worker(
          queue,
          async (job) => {
            seen.push(`${queue}:${job.name}`);
            return answers[queue];
          },
          { connection: connection(), prefix },
        ),
      );
    const vod = await tick({ job: "vod-retention" });
    expect(vod.status).toBe(200);
    expect(await vod.json()).toEqual({ deleted: 2, held: 1 });
    expect(await (await tick({ job: "account-deletion" })).json()).toEqual({ completed: 1 });
    expect(await (await tick({ job: "export-cleanup" })).json()).toEqual({ expired: 3 });
    // The exports queue also holds the build jobs the tests above enqueued.
    expect(seen.filter((s) => !s.endsWith(`:${EXPORT_JOBS.build}`)).sort()).toEqual(
      [
        `${QUEUES.deletions}:account-deletion`,
        `${QUEUES.exports}:${EXPORT_JOBS.cleanup}`,
        `${QUEUES.retention}:vod-retention`,
      ].sort(),
    );
  });

  test("a job that lost its run lock reports skipped", async () => {
    const lockedPrefix = `${prefix}-locked`;
    const runner = createOpsTickRunner(VALKEY_URL, lockedPrefix);
    setOpsTickRunner(api.deps, runner);
    workers.push(
      new Worker(
        QUEUES.retention,
        async (): Promise<Record<string, number>> => {
          throw new Error("run lock busy");
        },
        { connection: connection(), prefix: lockedPrefix },
      ),
    );
    const r = await tick({ job: "vod-retention" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ skipped: 1 });
    await runner.close();
  });
});
