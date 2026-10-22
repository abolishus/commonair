// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The co-op test hook (`POST /internal/coop/tick`, docs/testing/e5-selectors.md "Stack and test
 * hooks"): run one `COOP_JOBS` job now and return its result. It exists only while
 * `COOP_TEST_HOOKS=true`; otherwise it answers 404 like any unknown internal path, so a public
 * instance cannot drive the jobs. The worker runs the job (its schedules keep running either way);
 * the API only enqueues it on `QUEUES.coop` in the worker's BullMQ prefix and waits.
 */
import { Queue, QueueEvents } from "bullmq";
import { Valkey } from "iovalkey";
import { type CoopJobName, CoopJobResult, CoopTickBody, INTERNAL_ROUTES, QUEUES } from "@commonair/contracts/internal";
import type { Deps } from "../deps.ts";

const TICK_TIMEOUT_MS = 30_000;

export interface CoopTickRunner {
  run(job: CoopJobName, timeoutMs?: number): Promise<CoopJobResult>;
  close(): Promise<void>;
}

export function createCoopTickRunner(valkeyUrl: string, prefix: string): CoopTickRunner {
  // BullMQ refuses ioredis key prefixes and needs maxRetriesPerRequest: null.
  const conn = new Valkey(valkeyUrl, { maxRetriesPerRequest: null, connectionName: "api-coop-queue" });
  const queue = new Queue(QUEUES.coop, { connection: conn, prefix });
  let events: { ev: QueueEvents; conn: InstanceType<typeof Valkey> } | null = null;
  const queueEvents = async () => {
    if (!events) {
      const c = new Valkey(valkeyUrl, { maxRetriesPerRequest: null, connectionName: "api-coop-events" });
      const ev = new QueueEvents(QUEUES.coop, { connection: c, prefix });
      await ev.waitUntilReady();
      events = { ev, conn: c };
    }
    return events.ev;
  };
  return {
    async run(name, timeoutMs = TICK_TIMEOUT_MS) {
      const ev = await queueEvents();
      const job = await queue.add(name, {}, { removeOnComplete: 100, removeOnFail: 100 });
      return CoopJobResult.parse(await job.waitUntilFinished(ev, timeoutMs));
    },
    async close() {
      await queue.close();
      conn.disconnect();
      const e = events as { ev: QueueEvents; conn: InstanceType<typeof Valkey> } | null;
      if (e) {
        await e.ev.close();
        e.conn.disconnect();
      }
    },
  };
}

const runners = new WeakMap<Deps, CoopTickRunner>();

/** One runner per deps, created on the first tick (never while the hooks are off). */
export function coopTickRunner(deps: Deps): CoopTickRunner {
  let r = runners.get(deps);
  if (!r) {
    r = createCoopTickRunner(deps.env.VALKEY_URL, deps.env.WORKER_BULL_PREFIX);
    runners.set(deps, r);
  }
  return r;
}

export function setCoopTickRunner(deps: Deps, r: CoopTickRunner): void {
  runners.set(deps, r);
}

export async function closeCoopTickRunner(deps: Deps): Promise<void> {
  const r = runners.get(deps);
  runners.delete(deps);
  await r?.close();
}

/** For `/healthz`: whether the harness-only co-op hook is on. */
export const coopHealth = (deps: Deps) => ({ coopTestHooks: deps.env.COOP_TEST_HOOKS });

export const isCoopHookPath = (path: string) => path === INTERNAL_ROUTES.coopTick;

/**
 * Serve the hook for a caller that already passed the internal-secret check. `body` is the parsed
 * JSON (null when missing, too large or malformed). The hooks-off 404 is repeated here so no other
 * caller can reach it on a public instance.
 */
export async function coopHook(deps: Deps, method: string, body: unknown): Promise<Response> {
  if (!deps.env.COOP_TEST_HOOKS) return new Response(null, { status: 404 });
  if (method !== "POST") return new Response(null, { status: 405 });
  const parsed = CoopTickBody.safeParse(body);
  if (!parsed.success) return new Response(null, { status: 400 });
  try {
    return Response.json(await coopTickRunner(deps).run(parsed.data.job), {
      headers: { "cache-control": "no-store" },
    });
  } catch (err) {
    deps.logger.warn("coop tick test hook failed", { job: parsed.data.job, err: (err as Error).name });
    return new Response(null, { status: 504 });
  }
}
