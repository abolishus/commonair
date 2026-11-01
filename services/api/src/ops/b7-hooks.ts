// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The batch 7 test hooks (harness only, served while `OPS_TEST_HOOKS=true`, otherwise 404 like any
 * unknown internal path; contract step §2.6):
 *
 * - `POST INTERNAL_ROUTES.b7Tick` (`B7TickBody`): enqueue one `B7_TICK_JOBS` job on its queue now,
 *   wait for it (60 s) and return its `B7JobResult`. The worker runs the job.
 * - `POST INTERNAL_ROUTES.watchRoomAge` (`WatchRoomAgeBody`): end the room if it is open
 *   (`host_closed`, its open memberships left now) and move its times `days` back, so the
 *   retention job sees it as old. Membership times never move (the 0046 trigger refuses it).
 * - `PUT INTERNAL_ROUTES.relayPurgeHold` (`RelayPurgeHoldBody`): set or clear
 *   `KEYS.relayPurgeHold`, the purge feed's empty long-poll hold.
 */
import { Queue, QueueEvents } from "bullmq";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Valkey } from "iovalkey";
import {
  B7JobResult,
  B7TickBody,
  FEDERATION_JOBS,
  GIVEAWAY_JOBS,
  INTERNAL_ROUTES,
  JURY_JOBS,
  KEYS,
  QUEUES,
  RelayPurgeHoldBody,
  WATCH_ROOM_JOBS,
  WatchRoomAgeBody,
} from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";

const TICK_TIMEOUT_MS = 60_000;
const NO_STORE = { "cache-control": "no-store" };

/** The queue each tickable job runs on (the giveaway close shares the interact queue). */
export const B7_TICK_QUEUES: Record<B7TickBody["job"], string> = {
  [WATCH_ROOM_JOBS.retention]: QUEUES.watchRooms,
  [JURY_JOBS.draw]: QUEUES.jury,
  [JURY_JOBS.close]: QUEUES.jury,
  [GIVEAWAY_JOBS.close]: QUEUES.interact,
  [FEDERATION_JOBS.rotate]: QUEUES.federation,
  [FEDERATION_JOBS.sweep]: QUEUES.federation,
};

export interface B7TickRunner {
  run(body: B7TickBody, timeoutMs?: number): Promise<B7JobResult>;
  close(): Promise<void>;
}

interface QueuePair {
  queue: Queue;
  events: QueueEvents;
  conns: Valkey[];
}

export function createB7TickRunner(valkeyUrl: string, prefix: string): B7TickRunner {
  const pairs = new Map<string, Promise<QueuePair>>();
  const pair = (name: string) => {
    let p = pairs.get(name);
    if (!p) {
      p = (async () => {
        // BullMQ refuses ioredis key prefixes and needs maxRetriesPerRequest: null.
        const qc = new Valkey(valkeyUrl, { maxRetriesPerRequest: null, connectionName: `api-b7-${name}` });
        const ec = new Valkey(valkeyUrl, { maxRetriesPerRequest: null, connectionName: `api-b7-${name}-events` });
        const events = new QueueEvents(name, { connection: ec, prefix });
        await events.waitUntilReady();
        return { queue: new Queue(name, { connection: qc, prefix }), events, conns: [qc, ec] };
      })();
      pairs.set(name, p);
      p.catch(() => pairs.delete(name));
    }
    return p;
  };
  return {
    async run(body, timeoutMs = TICK_TIMEOUT_MS) {
      const { queue, events } = await pair(B7_TICK_QUEUES[body.job]);
      const job = await queue.add(body.job, body.data, { removeOnComplete: 100, removeOnFail: 100 });
      return B7JobResult.parse(await job.waitUntilFinished(events, timeoutMs));
    },
    async close() {
      const all = [...pairs.values()];
      pairs.clear();
      for (const p of all) {
        const r = await p.catch(() => null);
        if (!r) continue;
        await r.queue.close();
        await r.events.close();
        for (const c of r.conns) c.disconnect();
      }
    },
  };
}

const runners = new WeakMap<Deps, B7TickRunner>();

/** One runner per deps, created on the first tick (never while the hooks are off). */
export function b7TickRunner(deps: Deps): B7TickRunner {
  let r = runners.get(deps);
  if (!r) {
    r = createB7TickRunner(deps.env.VALKEY_URL, deps.env.WORKER_BULL_PREFIX);
    runners.set(deps, r);
  }
  return r;
}

export function setB7TickRunner(deps: Deps, r: B7TickRunner): void {
  runners.set(deps, r);
}

export async function closeB7TickRunner(deps: Deps): Promise<void> {
  const r = runners.get(deps);
  runners.delete(deps);
  await r?.close();
}

export const isB7HookPath = (path: string) =>
  path === INTERNAL_ROUTES.b7Tick || path === INTERNAL_ROUTES.watchRoomAge || path === INTERNAL_ROUTES.relayPurgeHold;

async function ageRoom(deps: Deps, body: WatchRoomAgeBody): Promise<boolean> {
  const { watchRooms, watchRoomMembers } = schema;
  const now = deps.now();
  const shift = sql`make_interval(days => ${body.days})`;
  return deps.db.transaction(async (tx) => {
    const [room] = await tx
      .select({ id: watchRooms.id })
      .from(watchRooms)
      .where(eq(watchRooms.id, body.roomId))
      .for("update");
    if (!room) return false;
    await tx
      .update(watchRoomMembers)
      .set({ leftAt: now })
      .where(and(eq(watchRoomMembers.roomId, room.id), isNull(watchRoomMembers.leftAt)));
    await tx
      .update(watchRooms)
      .set({
        createdAt: sql`${watchRooms.createdAt} - ${shift}`,
        endedAt: sql`coalesce(${watchRooms.endedAt}, ${now.toISOString()}::timestamptz) - ${shift}`,
        endReason: sql`coalesce(${watchRooms.endReason}, 'host_closed')`,
        inviteHash: null,
      })
      .where(eq(watchRooms.id, room.id));
    return true;
  });
}

/**
 * Serve the hooks for a caller that already passed the internal-secret check. `body` is the parsed
 * JSON (null when missing, too large or malformed). The hooks-off 404 is repeated here so no other
 * caller can reach them on a public instance.
 */
export async function b7Hook(deps: Deps, path: string, method: string, body: unknown): Promise<Response> {
  if (!deps.env.OPS_TEST_HOOKS) return new Response(null, { status: 404 });
  if (path === INTERNAL_ROUTES.relayPurgeHold) {
    if (method !== "PUT") return new Response(null, { status: 405 });
    const parsed = RelayPurgeHoldBody.safeParse(body);
    if (!parsed.success) return new Response(null, { status: 400 });
    if (parsed.data.seconds === null) await deps.valkey.del(KEYS.relayPurgeHold);
    else await deps.valkey.set(KEYS.relayPurgeHold, String(parsed.data.seconds));
    return Response.json({ ok: true }, { headers: NO_STORE });
  }
  if (method !== "POST") return new Response(null, { status: 405 });
  if (path === INTERNAL_ROUTES.watchRoomAge) {
    const parsed = WatchRoomAgeBody.safeParse(body);
    if (!parsed.success) return new Response(null, { status: 400 });
    if (!(await ageRoom(deps, parsed.data))) return new Response(null, { status: 404 });
    return Response.json({ ok: true }, { headers: NO_STORE });
  }
  if (path !== INTERNAL_ROUTES.b7Tick) return new Response(null, { status: 404 });
  const parsed = B7TickBody.safeParse(body);
  if (!parsed.success) return new Response(null, { status: 400 });
  try {
    return Response.json(await b7TickRunner(deps).run(parsed.data), { headers: NO_STORE });
  } catch (err) {
    deps.logger.warn("b7 tick test hook failed", { job: parsed.data.job, err: (err as Error).name });
    return new Response(null, { status: 504 });
  }
}
