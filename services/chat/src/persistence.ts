// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Batched persistence of chat messages. Rows are flushed every `intervalMs` or as soon as
 * `batchSize` rows are queued, one flush at a time. A failed batch is retried row by row so
 * one bad row (say, a user deleted mid-flight) cannot sink its neighbours.
 */
import { schema, type Database } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { Metrics } from "./metrics.ts";

export type MessageRow = typeof schema.chatMessages.$inferInsert;

export interface WriterOptions {
  intervalMs?: number;
  batchSize?: number;
  /** Queue bound; beyond it the oldest rows are dropped (and counted) rather than exhausting memory. */
  maxQueue?: number;
}

export class MessageWriter {
  private queue: MessageRow[] = [];
  private flushing: Promise<void> = Promise.resolve();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly batchSize: number;
  private readonly maxQueue: number;
  private closed = false;

  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    opts: WriterOptions = {},
  ) {
    this.batchSize = opts.batchSize ?? 200;
    this.maxQueue = opts.maxQueue ?? 50_000;
    this.timer = setInterval(() => void this.flush(), opts.intervalMs ?? 250);
    this.timer.unref?.();
  }

  get pending(): number {
    return this.queue.length;
  }

  enqueue(row: MessageRow): void {
    if (this.closed) {
      this.metrics.dropped("persist_failed");
      this.logger.warn("chat message after writer close", { messageId: row.id });
      return;
    }
    this.queue.push(row);
    if (this.queue.length > this.maxQueue) {
      this.queue.shift();
      this.metrics.dropped("persist_overflow");
    }
    if (this.queue.length >= this.batchSize) void this.flush();
  }

  /** Flush everything queued so far; resolves once those rows are committed (or given up on). */
  flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.drain());
    return this.flushing;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.flush();
    if (this.queue.length > 0) {
      this.logger.error("chat messages lost at shutdown", { rows: this.queue.length });
      for (let i = 0; i < this.queue.length; i++) this.metrics.dropped("persist_failed");
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.batchSize);
      try {
        await this.db.insert(schema.chatMessages).values(batch).onConflictDoNothing();
        continue;
      } catch (err) {
        if (!isDataError(err)) return this.requeue(batch, err);
        this.logger.warn("chat batch insert failed; retrying row by row", {
          ...dbErrorFields(err),
          rows: batch.length,
        });
      }
      for (const [i, row] of batch.entries()) {
        try {
          await this.db.insert(schema.chatMessages).values(row).onConflictDoNothing();
        } catch (err) {
          if (!isDataError(err)) return this.requeue(batch.slice(i), err);
          this.metrics.dropped("persist_failed");
          this.logger.error("chat message not persisted", { ...dbErrorFields(err), messageId: row.id });
        }
      }
    }
  }

  /** Database unavailable: keep the rows (at the front, in order) and retry on the next tick. */
  private requeue(rows: MessageRow[], err: unknown): void {
    this.logger.error("chat persistence unavailable; will retry", { ...dbErrorFields(err), rows: rows.length });
    this.queue = rows.concat(this.queue);
    while (this.queue.length > this.maxQueue) {
      this.queue.shift();
      this.metrics.dropped("persist_overflow");
    }
  }
}

const errorCode = (err: unknown): string | null => {
  const e = typeof err === "object" && err !== null ? (err as { code?: unknown; cause?: { code?: unknown } }) : null;
  const value = e?.code ?? e?.cause?.code;
  return typeof value === "string" ? value : null;
};

/** SQLSTATE classes 22 (data exception) and 23 (integrity violation) are row problems, not outages. */
const isDataError = (err: unknown): boolean => /^2[23][0-9A-Z]{3}$/.test(errorCode(err) ?? "");

/**
 * Log fields for a database error without its message: driver messages embed the query
 * parameters, which here are users' chat messages.
 */
export function dbErrorFields(err: unknown): { errorName: string; errorCode: string | null } {
  const name = err instanceof Error ? err.name : "Error";
  return { errorName: name, errorCode: errorCode(err) };
}
