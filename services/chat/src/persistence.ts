// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Batched persistence of chat messages. Rows are flushed every `intervalMs` or as soon as
 * `batchSize` rows are queued, with at most one flush in flight. A failed batch is retried row
 * by row so one bad row (say, a user deleted mid-flight) cannot sink its neighbours. When the
 * database is unreachable the rows stay queued and retries back off exponentially.
 */
import { schema, type Database } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import { errorCode, errorFields } from "./errors.ts";
import type { Metrics } from "./metrics.ts";

export type MessageRow = typeof schema.chatMessages.$inferInsert;

export interface WriterOptions {
  intervalMs?: number;
  batchSize?: number;
  /** Queue bound; beyond it the oldest rows are dropped (and counted) rather than exhausting memory. */
  maxQueue?: number;
  /** First retry delay after an outage; doubles up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** How long `close()` keeps trying to drain before giving up. */
  closeTimeoutMs?: number;
  clock?: () => number;
}

const OUTAGE_LOG_INTERVAL_MS = 30_000;

export class MessageWriter {
  private queue: MessageRow[] = [];
  private inflight: Promise<void> | null = null;
  private rerun: Promise<void> | null = null;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly batchSize: number;
  private readonly maxQueue: number;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly closeTimeoutMs: number;
  private readonly clock: () => number;
  private backoff = 0;
  private retryAt = 0;
  private lastOutageLog = Number.NEGATIVE_INFINITY;
  private suppressedOutageLogs = 0;
  private closed = false;

  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
    private readonly metrics: Metrics,
    opts: WriterOptions = {},
  ) {
    this.batchSize = opts.batchSize ?? 200;
    this.maxQueue = opts.maxQueue ?? 50_000;
    this.backoffMs = opts.backoffMs ?? 250;
    this.maxBackoffMs = opts.maxBackoffMs ?? 10_000;
    this.closeTimeoutMs = opts.closeTimeoutMs ?? 5_000;
    this.clock = opts.clock ?? Date.now;
    this.timer = setInterval(() => void this.flush(), opts.intervalMs ?? 250);
    this.timer.unref?.();
  }

  get pending(): number {
    return this.queue.length;
  }

  /** True while retries are backing off after a database failure. */
  get degraded(): boolean {
    return this.retryAt > this.clock();
  }

  enqueue(row: MessageRow): void {
    if (this.closed) {
      this.metrics.dropped("persist_failed");
      this.logger.warn("chat message after writer close", { messageId: row.id });
      return;
    }
    this.queue.push(row);
    this.trim();
    if (this.queue.length >= this.batchSize) void this.flush();
  }

  /**
   * Flush what is queued. At most one drain runs at a time; callers arriving meanwhile share a
   * single follow-up drain, so the promise chain never grows with the number of callers.
   */
  flush(): Promise<void> {
    if (this.inflight) {
      this.rerun ??= this.inflight.then(() => {
        this.rerun = null;
        return this.flush();
      });
      return this.rerun;
    }
    this.inflight = this.drain().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Flush, but stop waiting after `ms` (the rows stay queued). Resolves true when fully flushed. */
  async flushWithin(ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = await Promise.race([
      this.flush().then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
    clearTimeout(timer);
    return done && this.queue.length === 0;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    // Shutdown gets one more attempt even while backing off, bounded in time.
    this.retryAt = 0;
    await this.flushWithin(this.closeTimeoutMs);
    if (this.queue.length > 0) {
      this.logger.error("chat messages lost at shutdown", { rows: this.queue.length });
      for (let i = 0; i < this.queue.length; i++) this.metrics.dropped("persist_failed");
    }
  }

  private trim(): void {
    while (this.queue.length > this.maxQueue) {
      this.queue.shift();
      this.metrics.dropped("persist_overflow");
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      if (this.retryAt > this.clock()) return;
      const batch = this.queue.splice(0, this.batchSize);
      try {
        await this.db.insert(schema.chatMessages).values(batch).onConflictDoNothing();
        this.recovered();
        continue;
      } catch (err) {
        if (!isDataError(err)) return this.requeue(batch, err);
        this.logger.warn("chat batch insert failed; retrying row by row", { ...errorFields(err), rows: batch.length });
      }
      for (const [i, row] of batch.entries()) {
        try {
          await this.db.insert(schema.chatMessages).values(row).onConflictDoNothing();
        } catch (err) {
          if (!isDataError(err)) return this.requeue(batch.slice(i), err);
          this.metrics.dropped("persist_failed");
          this.logger.error("chat message not persisted", { ...errorFields(err), messageId: row.id });
        }
      }
      this.recovered();
    }
  }

  private recovered(): void {
    if (this.backoff === 0) return;
    this.logger.info("chat persistence recovered", { suppressedLogs: this.suppressedOutageLogs });
    this.backoff = 0;
    this.retryAt = 0;
    this.suppressedOutageLogs = 0;
    this.lastOutageLog = Number.NEGATIVE_INFINITY;
  }

  /** Database unavailable: keep the rows (at the front, in order) and retry after a backoff. */
  private requeue(rows: MessageRow[], err: unknown): void {
    this.queue = rows.concat(this.queue);
    this.trim();
    this.backoff = this.backoff === 0 ? this.backoffMs : Math.min(this.backoff * 2, this.maxBackoffMs);
    const now = this.clock();
    this.retryAt = now + this.backoff;
    if (now - this.lastOutageLog >= OUTAGE_LOG_INTERVAL_MS) {
      this.logger.error("chat persistence unavailable; will retry", {
        ...errorFields(err),
        rows: this.queue.length,
        retryInMs: this.backoff,
        suppressedLogs: this.suppressedOutageLogs,
      });
      this.lastOutageLog = now;
      this.suppressedOutageLogs = 0;
    } else this.suppressedOutageLogs++;
  }
}

/** SQLSTATE classes 22 (data exception) and 23 (integrity violation) are row problems, not outages. */
const isDataError = (err: unknown): boolean => /^2[23][0-9A-Z]{3}$/.test(errorCode(err) ?? "");
