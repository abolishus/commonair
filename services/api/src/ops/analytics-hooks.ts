// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The W2 analytics and attestation test hooks (harness only, served while `OPS_TEST_HOOKS=true`,
 * otherwise 404 like any unknown internal path; batch 6 contract step §1.4):
 *
 * - `POST INTERNAL_ROUTES.analyticsTick` (`AnalyticsTickBody`): enqueue `broadcast-rollup` (with
 *   the settle delay overridden, `reason: "test"`) or `integrity-attestation` (`reason: "test"`)
 *   for one broadcast on the worker's `QUEUES.analytics`, wait for it and return its counts.
 * - `PUT INTERNAL_ROUTES.analyticsDisplayBypass` (`AnalyticsDisplayBypassBody`): set or clear
 *   `KEYS.analyticsDisplayBypass(channelId)`; the analytics, share-link and attestation reads ask
 *   `analyticsDisplayBypassed` before applying the 24 h display delay.
 *
 * The worker runs the jobs (the API never signs); this module only enqueues and waits.
 */
import { Queue, QueueEvents } from "bullmq";
import { Valkey } from "iovalkey";
import { valkeyTls } from "@commonair/service";
import {
  ANALYTICS_DISPLAY_BYPASS_TTL_SECONDS,
  ANALYTICS_JOBS,
  AnalyticsDisplayBypassBody,
  AnalyticsJobResult,
  AnalyticsTickBody,
  INTERNAL_ROUTES,
  KEYS,
  QUEUES,
  type BroadcastRollupJob,
  type IntegrityAttestationJob,
} from "@commonair/contracts/internal";
import type { Deps } from "../deps.ts";

const TICK_TIMEOUT_MS = 60_000;

/** The job payload the tick enqueues: always `reason: "test"`, never deduplicated by job id. */
export function analyticsTickJob(body: AnalyticsTickBody): {
  name: AnalyticsTickBody["job"];
  data: BroadcastRollupJob | IntegrityAttestationJob;
} {
  return body.job === ANALYTICS_JOBS.broadcastRollup
    ? { name: body.job, data: { broadcastId: body.broadcastId, reason: "test", settleSeconds: body.settleSeconds } }
    : { name: body.job, data: { broadcastId: body.broadcastId, reason: "test" } };
}

export interface AnalyticsTickRunner {
  run(body: AnalyticsTickBody, timeoutMs?: number): Promise<AnalyticsJobResult>;
  close(): Promise<void>;
}

export function createAnalyticsTickRunner(valkeyUrl: string, prefix: string): AnalyticsTickRunner {
  // BullMQ refuses ioredis key prefixes and needs maxRetriesPerRequest: null.
  const conn = new Valkey(valkeyUrl, {
    ...valkeyTls(valkeyUrl),
    maxRetriesPerRequest: null,
    connectionName: "api-analytics-queue",
  });
  const queue = new Queue(QUEUES.analytics, { connection: conn, prefix });
  let events: { ev: QueueEvents; conn: Valkey } | null = null;
  const queueEvents = async () => {
    if (!events) {
      const c = new Valkey(valkeyUrl, {
        ...valkeyTls(valkeyUrl),
        maxRetriesPerRequest: null,
        connectionName: "api-analytics-events",
      });
      const ev = new QueueEvents(QUEUES.analytics, { connection: c, prefix });
      await ev.waitUntilReady();
      events = { ev, conn: c };
    }
    return events.ev;
  };
  return {
    async run(body, timeoutMs = TICK_TIMEOUT_MS) {
      const ev = await queueEvents();
      const { name, data } = analyticsTickJob(body);
      const job = await queue.add(name, data, { removeOnComplete: 100, removeOnFail: 100 });
      return AnalyticsJobResult.parse(await job.waitUntilFinished(ev, timeoutMs));
    },
    async close() {
      await queue.close();
      conn.disconnect();
      const e = events as { ev: QueueEvents; conn: Valkey } | null;
      events = null;
      if (e) {
        await e.ev.close();
        e.conn.disconnect();
      }
    },
  };
}

const runners = new WeakMap<Deps, AnalyticsTickRunner>();

/** One runner per deps, created on the first tick (never while the hooks are off). */
export function analyticsTickRunner(deps: Deps): AnalyticsTickRunner {
  let r = runners.get(deps);
  if (!r) {
    r = createAnalyticsTickRunner(deps.env.VALKEY_URL, deps.env.WORKER_BULL_PREFIX);
    runners.set(deps, r);
  }
  return r;
}

export function setAnalyticsTickRunner(deps: Deps, r: AnalyticsTickRunner): void {
  runners.set(deps, r);
}

export async function closeAnalyticsTickRunner(deps: Deps): Promise<void> {
  const r = runners.get(deps);
  runners.delete(deps);
  await r?.close();
}

/**
 * Whether the 24 h analytics display delay is bypassed for `channelId`. Always false while the
 * hooks are off, so a leftover key can never publish early on a public instance.
 */
export async function analyticsDisplayBypassed(
  deps: Pick<Deps, "env" | "valkey">,
  channelId: string,
): Promise<boolean> {
  if (!deps.env.OPS_TEST_HOOKS) return false;
  return (await deps.valkey.exists(KEYS.analyticsDisplayBypass(channelId))) === 1;
}

export const isAnalyticsHookPath = (path: string) =>
  path === INTERNAL_ROUTES.analyticsTick || path === INTERNAL_ROUTES.analyticsDisplayBypass;

/**
 * Serve the hooks for a caller that already passed the internal-secret check. `body` is the parsed
 * JSON (null when missing, too large or malformed). The hooks-off 404 is repeated here so no other
 * caller can reach them on a public instance.
 */
export async function analyticsHook(deps: Deps, path: string, method: string, body: unknown): Promise<Response> {
  if (!deps.env.OPS_TEST_HOOKS) return new Response(null, { status: 404 });
  const headers = { "cache-control": "no-store" };
  if (path === INTERNAL_ROUTES.analyticsDisplayBypass) {
    if (method !== "PUT") return new Response(null, { status: 405 });
    const parsed = AnalyticsDisplayBypassBody.safeParse(body);
    if (!parsed.success) return new Response(null, { status: 400 });
    const key = KEYS.analyticsDisplayBypass(parsed.data.channelId);
    if (parsed.data.enabled) await deps.valkey.set(key, "1", "EX", ANALYTICS_DISPLAY_BYPASS_TTL_SECONDS);
    else await deps.valkey.del(key);
    return Response.json({ ok: true }, { headers });
  }
  if (path !== INTERNAL_ROUTES.analyticsTick) return new Response(null, { status: 404 });
  if (method !== "POST") return new Response(null, { status: 405 });
  const parsed = AnalyticsTickBody.safeParse(body);
  if (!parsed.success) return new Response(null, { status: 400 });
  try {
    return Response.json(await analyticsTickRunner(deps).run(parsed.data), { headers });
  } catch (err) {
    deps.logger.warn("analytics tick test hook failed", { job: parsed.data.job, err: (err as Error).name });
    return new Response(null, { status: 504 });
  }
}
