// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The interactivity test hook (`POST /internal/interact/tick`, docs/testing/e8-selectors.md
 * "Rules"): run one `INTERACT_JOBS` job now and return its result. It exists only while
 * `INTERACT_TEST_HOOKS=true`; otherwise it answers 404 like any unknown internal path, so a public
 * instance cannot drive the jobs. The worker runs the job (its schedules keep running either way);
 * the API only enqueues it on `QUEUES.interact` in the worker's BullMQ prefix and waits.
 */
import { Queue, QueueEvents } from "bullmq";
import { Valkey } from "iovalkey";
import {
  type InteractJobName,
  InteractJobResult,
  InteractTickBody,
  INTERNAL_ROUTES,
  QUEUES,
} from "@commonair/contracts/internal";
import type { Deps } from "../deps.ts";

const TICK_TIMEOUT_MS = 30_000;

export interface InteractTickRunner {
  run(job: InteractJobName, timeoutMs?: number): Promise<InteractJobResult>;
  close(): Promise<void>;
}

export function createInteractTickRunner(valkeyUrl: string, prefix: string): InteractTickRunner {
  // BullMQ refuses ioredis key prefixes and needs maxRetriesPerRequest: null.
  const conn = new Valkey(valkeyUrl, { maxRetriesPerRequest: null, connectionName: "api-interact-queue" });
  const queue = new Queue(QUEUES.interact, { connection: conn, prefix });
  let events: { ev: QueueEvents; conn: InstanceType<typeof Valkey> } | null = null;
  const queueEvents = async () => {
    if (!events) {
      const c = new Valkey(valkeyUrl, { maxRetriesPerRequest: null, connectionName: "api-interact-events" });
      const ev = new QueueEvents(QUEUES.interact, { connection: c, prefix });
      await ev.waitUntilReady();
      events = { ev, conn: c };
    }
    return events.ev;
  };
  return {
    async run(name, timeoutMs = TICK_TIMEOUT_MS) {
      const ev = await queueEvents();
      const job = await queue.add(name, {}, { removeOnComplete: 100, removeOnFail: 100 });
      return InteractJobResult.parse(await job.waitUntilFinished(ev, timeoutMs));
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

const runners = new WeakMap<Deps, InteractTickRunner>();

/** One runner per deps, created on the first tick (never while the hooks are off). */
export function interactTickRunner(deps: Deps): InteractTickRunner {
  let r = runners.get(deps);
  if (!r) {
    r = createInteractTickRunner(deps.env.VALKEY_URL, deps.env.WORKER_BULL_PREFIX);
    runners.set(deps, r);
  }
  return r;
}

export function setInteractTickRunner(deps: Deps, r: InteractTickRunner): void {
  runners.set(deps, r);
}

export async function closeInteractTickRunner(deps: Deps): Promise<void> {
  const r = runners.get(deps);
  runners.delete(deps);
  await r?.close();
}

/** For `/healthz`: whether the harness-only interactivity hook is on. */
export const interactHealth = (deps: Pick<Deps, "env">) => ({ interactTestHooks: deps.env.INTERACT_TEST_HOOKS });

export const isInteractHookPath = (path: string) => path === INTERNAL_ROUTES.interactTick;

/**
 * Serve the hook for a caller that already passed the internal-secret check. `body` is the parsed
 * JSON (null when missing, too large or malformed). The hooks-off 404 is repeated here so no other
 * caller can reach it on a public instance.
 */
export async function interactHook(deps: Deps, method: string, body: unknown): Promise<Response> {
  if (!deps.env.INTERACT_TEST_HOOKS) return new Response(null, { status: 404 });
  if (method !== "POST") return new Response(null, { status: 405 });
  const parsed = InteractTickBody.safeParse(body);
  if (!parsed.success) return new Response(null, { status: 400 });
  try {
    return Response.json(await interactTickRunner(deps).run(parsed.data.job), {
      headers: { "cache-control": "no-store" },
    });
  } catch (err) {
    deps.logger.warn("interact tick test hook failed", { job: parsed.data.job, err: (err as Error).name });
    return new Response(null, { status: 504 });
  }
}
