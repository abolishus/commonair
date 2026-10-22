// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The operations test hook (`POST /internal/ops/tick`, docs/testing/e6-selectors.md "Stack and test
 * hooks"): run account deletion, export cleanup or VOD retention now and return the job's counts.
 * It exists only while `OPS_TEST_HOOKS=true`; otherwise it answers 404 like any unknown internal
 * path. The worker runs the job (its schedules keep running either way); the API only enqueues it
 * on that job's queue in the worker's BullMQ prefix and waits.
 */
import { Queue, QueueEvents } from "bullmq";
import { Valkey } from "iovalkey";
import {
  EXPORT_JOBS,
  INTERNAL_ROUTES,
  OpsJobResult,
  OpsTickBody,
  QUEUES,
  type OPS_TICK_JOBS,
} from "@commonair/contracts/internal";
import type { Deps } from "../deps.ts";

export type OpsJobName = (typeof OPS_TICK_JOBS)[number];

const TICK_TIMEOUT_MS = 60_000;

/** Which queue each job runs on, and the job name the worker expects there. */
export const OPS_JOB_QUEUES: Record<OpsJobName, { queue: string; name: string }> = {
  "account-deletion": { queue: QUEUES.deletions, name: "account-deletion" },
  "export-cleanup": { queue: QUEUES.exports, name: EXPORT_JOBS.cleanup },
  "vod-retention": { queue: QUEUES.retention, name: "vod-retention" },
};

export interface OpsTickRunner {
  run(job: OpsJobName, timeoutMs?: number): Promise<OpsJobResult>;
  close(): Promise<void>;
}

export function createOpsTickRunner(valkeyUrl: string, prefix: string): OpsTickRunner {
  // BullMQ refuses ioredis key prefixes and needs maxRetriesPerRequest: null.
  const conn = new Valkey(valkeyUrl, { maxRetriesPerRequest: null, connectionName: "api-ops-queue" });
  const queues = new Map<string, Queue>();
  const events = new Map<string, { ev: QueueEvents; conn: Valkey }>();
  const queueOf = (name: string) => {
    let q = queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: conn, prefix });
      queues.set(name, q);
    }
    return q;
  };
  const eventsOf = async (name: string) => {
    let e = events.get(name);
    if (!e) {
      const c = new Valkey(valkeyUrl, { maxRetriesPerRequest: null, connectionName: "api-ops-events" });
      const ev = new QueueEvents(name, { connection: c, prefix });
      e = { ev, conn: c };
      events.set(name, e);
      await ev.waitUntilReady();
    }
    return e.ev;
  };
  return {
    async run(job, timeoutMs = TICK_TIMEOUT_MS) {
      const { queue, name } = OPS_JOB_QUEUES[job];
      const ev = await eventsOf(queue);
      const added = await queueOf(queue).add(name, {}, { removeOnComplete: 100, removeOnFail: 100 });
      return OpsJobResult.parse(await added.waitUntilFinished(ev, timeoutMs));
    },
    async close() {
      for (const q of queues.values()) await q.close();
      queues.clear();
      conn.disconnect();
      for (const e of events.values()) {
        await e.ev.close();
        e.conn.disconnect();
      }
      events.clear();
    },
  };
}

const runners = new WeakMap<Deps, OpsTickRunner>();

/** One runner per deps, created on the first tick (never while the hooks are off). */
export function opsTickRunner(deps: Deps): OpsTickRunner {
  let r = runners.get(deps);
  if (!r) {
    r = createOpsTickRunner(deps.env.VALKEY_URL, deps.env.WORKER_BULL_PREFIX);
    runners.set(deps, r);
  }
  return r;
}

export function setOpsTickRunner(deps: Deps, r: OpsTickRunner): void {
  runners.set(deps, r);
}

export async function closeOpsTickRunner(deps: Deps): Promise<void> {
  const r = runners.get(deps);
  runners.delete(deps);
  await r?.close();
}

/** A worker job that lost its run lock may fail with a lock error instead of returning `skipped`. */
const BUSY = /\block\b|\bbusy\b/i;

export const isOpsHookPath = (path: string) => path === INTERNAL_ROUTES.opsTick;

/**
 * Serve the hook for a caller that already passed the internal-secret check. The hooks-off 404 is
 * repeated here so no other caller can reach it on a public instance.
 */
export async function opsHook(deps: Deps, method: string, body: unknown): Promise<Response> {
  if (!deps.env.OPS_TEST_HOOKS) return new Response(null, { status: 404 });
  if (method !== "POST") return new Response(null, { status: 405 });
  const parsed = OpsTickBody.safeParse(body);
  if (!parsed.success) return new Response(null, { status: 400 });
  const headers = { "cache-control": "no-store" };
  try {
    return Response.json(await opsTickRunner(deps).run(parsed.data.job), { headers });
  } catch (err) {
    if (BUSY.test((err as Error).message ?? "")) return Response.json({ skipped: 1 }, { headers });
    deps.logger.warn("ops tick test hook failed", { job: parsed.data.job, err: (err as Error).name });
    return new Response(null, { status: 504 });
  }
}

/**
 * For `/healthz`: the harness-only hook, and whether any proprietary adapter is configured (the
 * `no-proprietary` profile of `full` requires all three false).
 */
export function opsHealth(deps: Pick<Deps, "env">) {
  const { env } = deps;
  const oauth = [
    [env.OAUTH_DISCORD_CLIENT_ID, env.OAUTH_DISCORD_CLIENT_SECRET],
    [env.OAUTH_TWITCH_CLIENT_ID, env.OAUTH_TWITCH_CLIENT_SECRET],
    [env.OAUTH_GITHUB_CLIENT_ID, env.OAUTH_GITHUB_CLIENT_SECRET],
  ].some(([id, secret]) => Boolean(id && secret));
  return {
    opsTestHooks: env.OPS_TEST_HOOKS,
    stripe: env.PAYMENTS_PROVIDER === "stripe",
    oauth,
    // Media and playback are served by our own origin unless a burst CDN is configured.
    cdn: env.CDN_PROVIDER !== "none" && Boolean(env.CDN_BASE_URL),
  };
}
