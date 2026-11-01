// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The batch 6 contract step's API seams: the W2 route files are mounted (stubs answer 501, not
 * 404), `/.well-known/commonair-attestation` is served under the OpenAPI `/api` prefix (Caddy
 * rewrites the bare path to it), group appeals reach `createGroupAppeal`, and the analytics test
 * hooks enqueue on `QUEUES.analytics` (a BullMQ worker on a private prefix stands in for the
 * worker) and set the display bypass.
 */
import { Worker } from "bullmq";
import { Valkey } from "iovalkey";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { ANALYTICS_JOBS, INTERNAL_ROUTES, INTERNAL_SECRET_HEADER, KEYS, QUEUES } from "@commonair/contracts/internal";
import { uuidv7 } from "@commonair/db";
import { analyticsDisplayBypassed } from "../src/ops/analytics-hooks.ts";
import { client, signUpAndSignIn, startApi, VALKEY_URL, type TestApi } from "./harness.ts";

let api: TestApi;
type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
let u: User;
const prefix = `test-w2-${crypto.randomUUID()}`;
const conns: Valkey[] = [];
const workers: Worker[] = [];

beforeAll(async () => {
  api = await startApi({ env: { OPS_TEST_HOOKS: "true", WORKER_BULL_PREFIX: prefix } });
  u = await signUpAndSignIn(api);
}, 120_000);
afterAll(async () => {
  for (const w of workers) await w.close();
  for (const c of conns) c.disconnect();
  await api?.stop();
});

describe("well-known attestation keys", () => {
  test("GET /api/.well-known/commonair-attestation reaches integrity.keys.list (stub: 501, not 404)", async () => {
    const res = await fetch(`${api.url}/api/.well-known/commonair-attestation`);
    expect(res.status).toBe(501);
    expect(((await res.json()) as { code: string }).code).toBe("NOT_IMPLEMENTED");
    // A neighbouring unknown path is still a plain 404, so the 501 above is the route matching.
    expect((await fetch(`${api.url}/api/.well-known/commonair-nothing`)).status).toBe(404);
  });

  test("the public verifier is mounted too", async () => {
    const res = await fetch(`${api.url}/api/attestations/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envelope: { payload: "e30", signature: "AA" } }),
    });
    expect(res.status).toBe(501);
  });
});

describe("W2 route files are mounted", () => {
  test("public enforcement report and owner procedures answer 501", async () => {
    expect((await fetch(`${api.url}/api/transparency/enforcement`)).status).toBe(501);
    const c = u.client;
    expect((await c.call("GET", `/api/channels/${u.username}/rehearsal`)).status).toBe(501);
    expect((await c.call("POST", `/api/channels/${u.username}/rehearsal`)).status).toBe(501);
  });

  test("an exclusion_group appeal goes to createGroupAppeal (stub: 501), never the generic check", async () => {
    const r = await u.client.call("POST", "/api/appeals", {
      kind: "integrity",
      subjectType: "exclusion_group",
      subjectId: uuidv7(),
      category: "datacenter",
      body: "These were students on the school network.",
    });
    expect(r.status).toBe(501);
    // Without a category the contract refuses it before any handler runs.
    const bad = await u.client.call("POST", "/api/appeals", {
      kind: "integrity",
      subjectType: "exclusion_group",
      subjectId: uuidv7(),
      body: "These were students on the school network.",
    });
    expect(bad.status).toBe(400);
  });

  test("signed out, the owner procedures stay closed", async () => {
    expect((await client(api).call("GET", `/api/channels/${u.username}/rehearsal`)).status).toBe(401);
  });
});

describe("analytics test hooks", () => {
  const call = (path: string, method: string, body: unknown, secret: string | null = api.internalSecret) =>
    fetch(`${api.url}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(secret ? { [INTERNAL_SECRET_HEADER]: secret } : {}) },
      body: JSON.stringify(body),
    });

  test("404 while off (before the secret check), 401 without the secret, 405 and 400 otherwise", async () => {
    const env = api.deps.env as { OPS_TEST_HOOKS: boolean };
    const broadcastId = uuidv7();
    env.OPS_TEST_HOOKS = false;
    try {
      expect((await call(INTERNAL_ROUTES.analyticsTick, "POST", { job: "broadcast-rollup", broadcastId })).status).toBe(
        404,
      );
      expect((await call(INTERNAL_ROUTES.analyticsDisplayBypass, "PUT", {}, null)).status).toBe(404);
    } finally {
      env.OPS_TEST_HOOKS = true;
    }
    expect(
      (await call(INTERNAL_ROUTES.analyticsTick, "POST", { job: "broadcast-rollup", broadcastId }, null)).status,
    ).toBe(401);
    expect((await call(INTERNAL_ROUTES.analyticsTick, "PUT", { job: "broadcast-rollup", broadcastId })).status).toBe(
      405,
    );
    expect(
      (await call(INTERNAL_ROUTES.analyticsTick, "POST", { job: "attestation-reconcile", broadcastId })).status,
    ).toBe(400);
    expect(
      (await call(INTERNAL_ROUTES.analyticsDisplayBypass, "POST", { channelId: broadcastId, enabled: true })).status,
    ).toBe(405);
    expect((await call(INTERNAL_ROUTES.analyticsDisplayBypass, "PUT", { channelId: "x" })).status).toBe(400);
  });

  test("the tick runs the job now on QUEUES.analytics with reason test and the settle override", async () => {
    const seen: { name: string; data: unknown }[] = [];
    const conn = new Valkey(VALKEY_URL, { maxRetriesPerRequest: null });
    conns.push(conn);
    workers.push(
      new Worker(
        QUEUES.analytics,
        async (job) => {
          seen.push({ name: job.name, data: job.data });
          return { minutes: 3 };
        },
        { connection: conn, prefix },
      ),
    );
    const broadcastId = uuidv7();
    const rollup = await call(INTERNAL_ROUTES.analyticsTick, "POST", {
      job: ANALYTICS_JOBS.broadcastRollup,
      broadcastId,
    });
    expect(rollup.status).toBe(200);
    expect(await rollup.json()).toEqual({ minutes: 3 });
    const attest = await call(INTERNAL_ROUTES.analyticsTick, "POST", {
      job: ANALYTICS_JOBS.integrityAttestation,
      broadcastId,
    });
    expect(attest.status).toBe(200);
    expect(seen).toEqual([
      { name: ANALYTICS_JOBS.broadcastRollup, data: { broadcastId, reason: "test", settleSeconds: 0 } },
      { name: ANALYTICS_JOBS.integrityAttestation, data: { broadcastId, reason: "test" } },
    ]);
  });

  test("the display bypass is set and cleared, and reads false while the hooks are off", async () => {
    const channelId = uuidv7();
    const on = await call(INTERNAL_ROUTES.analyticsDisplayBypass, "PUT", { channelId, enabled: true });
    expect(on.status).toBe(200);
    expect(await analyticsDisplayBypassed(api.deps, channelId)).toBe(true);
    expect(await api.deps.valkey.ttl(KEYS.analyticsDisplayBypass(channelId))).toBeGreaterThan(0);
    const env = api.deps.env as { OPS_TEST_HOOKS: boolean };
    env.OPS_TEST_HOOKS = false;
    try {
      expect(await analyticsDisplayBypassed(api.deps, channelId)).toBe(false);
    } finally {
      env.OPS_TEST_HOOKS = true;
    }
    expect((await call(INTERNAL_ROUTES.analyticsDisplayBypass, "PUT", { channelId, enabled: false })).status).toBe(200);
    expect(await analyticsDisplayBypassed(api.deps, channelId)).toBe(false);
  });
});
