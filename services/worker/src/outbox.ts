// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Outbox relay: unpublished `events` rows → validated BusEvent on Valkey
 * `BUS.events` → webhook fan-out jobs → `published_at`. Rows are claimed with
 * `FOR UPDATE SKIP LOCKED`, so replicas never claim the same row. Delivery is
 * at-least-once: if the commit fails after publishing, the batch is published
 * again (consumers dedupe by event id). Internal (trust & safety) events are validated and
 * marked published without ever reaching the bus or webhook fan-out.
 */
import { BusEvent, EVENTS, isInternalEvent, type EventType } from "@commonair/contracts/events";
import { QUEUES } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { WorkerContext } from "./context.ts";
import { WEBHOOK_JOBS } from "./jobs/names.ts";
import { metrics } from "./metrics.ts";
import { moderationMetrics } from "./moderation/metrics.ts";
import { AdaptiveDelay, startLoop, type LoopHandle } from "./runtime/loop.ts";

const { events, eventSubscriptions: subs } = schema;
type EventRow = typeof events.$inferSelect;

/** Validate an outbox row against the catalog; returns the bus message or the reason it is invalid. */
export function toBusEvent(row: EventRow): { ok: true; event: BusEvent } | { ok: false; reason: string } {
  if (!Object.hasOwn(EVENTS, row.type)) return { ok: false, reason: "unknown event type" };
  const def = EVENTS[row.type as EventType];
  if (row.version !== def.version) return { ok: false, reason: `unsupported version ${row.version}` };
  const parsed = def.payload.safeParse(row.payload);
  if (!parsed.success) return { ok: false, reason: parsed.error.issues.map((i) => i.path.join(".")).join(",") };
  return {
    ok: true,
    event: BusEvent.parse({
      id: row.id,
      type: row.type,
      version: row.version,
      channelId: row.channelId,
      payload: parsed.data,
      occurredAt: row.occurredAt.toISOString(),
    }),
  };
}

/** Validate an internal event row; it is never published, only marked as handled. */
export function checkInternalEvent(row: EventRow): { ok: true } | { ok: false; reason: string } {
  const def = EVENTS[row.type as EventType];
  if (row.version !== def.version) return { ok: false, reason: `unsupported version ${row.version}` };
  const parsed = def.payload.safeParse(row.payload);
  return parsed.success ? { ok: true } : { ok: false, reason: parsed.error.issues.map((i) => i.path.join(".")).join(",") };
}

/** Reject when `p` takes longer than `ms`; the caller treats it as a failed round trip. */
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Relay one batch. Returns how many rows were claimed. */
export async function relayOutboxBatch(ctx: WorkerContext, batchSize = 200, valkeyTimeoutMs = 2_000): Promise<number> {
  return ctx.db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(events)
      .where(isNull(events.publishedAt))
      .orderBy(asc(events.occurredAt), asc(events.id))
      .limit(batchSize)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return 0;

    const valid: BusEvent[] = [];
    for (const row of rows) {
      if (isInternalEvent(row.type)) {
        // Audit and service fan-out only: never on BUS.events, never offered to apps.
        const c = checkInternalEvent(row);
        if (c.ok) moderationMetrics.outboxInternal.add(1, { type: row.type });
        else {
          metrics.outboxInvalid.add(1, { type: row.type });
          ctx.logger.error("internal outbox event failed catalog validation", {
            eventId: row.id,
            type: row.type,
            reason: c.reason,
          });
        }
        continue;
      }
      const r = toBusEvent(row);
      if (r.ok) valid.push(r.event);
      else {
        // Marked published anyway: a poison row must not block the outbox forever.
        metrics.outboxInvalid.add(1, { type: row.type });
        ctx.logger.error("outbox event failed catalog validation; skipped", {
          eventId: row.id,
          type: row.type,
          reason: r.reason,
        });
      }
    }

    const types = [...new Set(valid.map((e) => e.type))];
    const hooked = new Set(
      types.length === 0
        ? []
        : (
            await tx
              .selectDistinct({ type: subs.type })
              .from(subs)
              .where(and(eq(subs.transport, "webhook"), eq(subs.status, "enabled"), inArray(subs.type, types)))
          ).map((r) => r.type),
    );

    // The claimed rows stay locked until commit, so each Valkey round trip is bounded: on a
    // timeout the transaction rolls back and the batch is retried (at-least-once; fan-out
    // job ids are idempotent and bus consumers dedupe by event id).
    const pipeline = ctx.valkey.pipeline();
    for (const e of valid) pipeline.publish(ctx.busChannel, JSON.stringify(e));
    const results = await withTimeout(pipeline.exec(), valkeyTimeoutMs, "bus publish");
    const failed = results?.find(([err]) => err);
    if (failed) throw failed[0];

    const fanouts = valid
      .filter((e) => hooked.has(e.type))
      .map((e) => ({ name: WEBHOOK_JOBS.fanout, data: { eventId: e.id }, opts: { jobId: `fanout-${e.id}` } }));
    await withTimeout(ctx.enqueueBulk(QUEUES.webhooks, fanouts), valkeyTimeoutMs, "fan-out enqueue");

    const now = ctx.now();
    await tx
      .update(events)
      .set({ publishedAt: now })
      .where(
        inArray(
          events.id,
          rows.map((r) => r.id),
        ),
      );
    for (const e of valid) {
      metrics.outboxLag.record(now.getTime() - Date.parse(e.occurredAt), { type: e.type });
      metrics.outboxPublished.add(1, { type: e.type });
    }
    return rows.length;
  });
}

/** The continuous relay loop: 50 ms → 1 s adaptive polling, no sleep while a backlog remains. */
export function startOutboxRelay(ctx: WorkerContext, opts: { batchSize?: number } = {}): LoopHandle {
  const batchSize = opts.batchSize ?? 200;
  const delay = new AdaptiveDelay(50, 1000);
  return startLoop("outbox relay", ctx.logger, async () => {
    try {
      const n = await relayOutboxBatch(ctx, batchSize);
      return delay.next(n >= batchSize ? "full" : n > 0 ? "some" : "none");
    } catch (err) {
      ctx.logger.error("outbox relay batch failed", { err });
      return delay.next("error");
    }
  });
}
