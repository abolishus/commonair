// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where word filters run. `applyFilters` checks its time budget between filters, but cannot
 * interrupt a single `RegExp` call. The worker runner runs regex filter sets in a small pool of
 * Bun workers and terminates (then respawns) a worker that runs past the hard timeout; the
 * message is held for moderators, never passed. Filter sets without regex patterns (escaped
 * literals, always linear) and empty sets run inline.
 */
import type { Logger } from "@commonair/observability";
import { applyFilters, type CompiledFilter, FILTER_BUDGET_MS, type FilterOutcome } from "./content.ts";
import type { RunRequest, WireFilter, WorkerReply } from "./filter-protocol.ts";

export interface FilterRunner {
  run(body: string, filters: readonly CompiledFilter[]): Promise<FilterOutcome>;
  close(): Promise<void>;
}

/** Runs filters on the calling thread, bounded only by the per-message budget between filters. */
export const inlineFilterRunner: FilterRunner = {
  run: (body, filters) => Promise.resolve(applyFilters(body, filters)),
  close: () => Promise.resolve(),
};

export interface WorkerFilterRunnerOptions {
  /** Worker threads in the pool (default 2). */
  workers?: number;
  /** Soft budget across all filters, checked between filters (default FILTER_BUDGET_MS). */
  budgetMs?: number;
  /** Wall time from dispatch after which the worker is terminated (default budget + 25 ms). */
  hardTimeoutMs?: number;
  /** Messages waiting for a worker beyond this are held at once (default 10 000). */
  maxQueue?: number;
  logger?: Logger;
  /** Called when a message is held because its worker timed out, crashed or the queue was full. */
  onTimeout?: (reason: "timeout" | "crash" | "queue_full") => void;
}

interface Job {
  id: number;
  key: string;
  body: string;
  filters: readonly CompiledFilter[];
  resolve: (outcome: FilterOutcome) => void;
}

interface Slot {
  worker: Worker;
  ready: boolean;
  dead: boolean;
  job: Job | null;
  timer: ReturnType<typeof setTimeout> | null;
  known: Set<string>;
}

const held = (body: string): FilterOutcome => ({ action: "hold", body, filterId: null, timedOut: true });

const WORKER_URL = new URL("./filter-worker.ts", import.meta.url).href;

export class WorkerFilterRunner implements FilterRunner {
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private readonly keys = new WeakMap<readonly CompiledFilter[], string>();
  private nextKey = 0;
  private nextId = 0;
  private closed = false;
  private readonly budgetMs: number;
  private readonly hardTimeoutMs: number;
  private readonly maxQueue: number;

  constructor(private readonly opts: WorkerFilterRunnerOptions = {}) {
    this.budgetMs = opts.budgetMs ?? FILTER_BUDGET_MS;
    this.hardTimeoutMs = opts.hardTimeoutMs ?? this.budgetMs + 25;
    this.maxQueue = opts.maxQueue ?? 10_000;
    for (let i = 0; i < Math.max(1, opts.workers ?? 2); i++) this.slots.push(this.spawn());
  }

  run(body: string, filters: readonly CompiledFilter[]): Promise<FilterOutcome> {
    if (!filters.some((f) => f.def.isRegex)) return Promise.resolve(applyFilters(body, filters, this.budgetMs));
    if (this.closed) return Promise.resolve(held(body));
    if (this.queue.length >= this.maxQueue) {
      this.opts.onTimeout?.("queue_full");
      return Promise.resolve(held(body));
    }
    return new Promise((resolve) => {
      this.queue.push({ id: ++this.nextId, key: this.keyOf(filters), body, filters, resolve });
      this.pump();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) job.resolve(held(job.body));
    for (const slot of this.slots) {
      slot.dead = true;
      if (slot.timer) clearTimeout(slot.timer);
      slot.job?.resolve(held(slot.job.body));
      slot.job = null;
      slot.worker.terminate();
    }
    await Promise.resolve();
  }

  private keyOf(filters: readonly CompiledFilter[]): string {
    let key = this.keys.get(filters);
    if (!key) {
      key = String(++this.nextKey);
      this.keys.set(filters, key);
    }
    return key;
  }

  private spawn(): Slot {
    const worker = new Worker(WORKER_URL);
    const slot: Slot = { worker, ready: false, dead: false, job: null, timer: null, known: new Set() };
    worker.addEventListener("message", (event: MessageEvent<WorkerReply>) => this.onReply(slot, event.data));
    worker.addEventListener("error", () => this.fail(slot, "crash"));
    worker.addEventListener("close", () => this.fail(slot, "crash"));
    // The pool must not keep the process alive on its own.
    // Bun's Worker has unref(); the DOM lib typing in this project does not declare it.
    (worker as Worker & { unref?: () => void }).unref?.();
    return slot;
  }

  private onReply(slot: Slot, msg: WorkerReply): void {
    if (slot.dead) return;
    if (msg.type === "ready") {
      slot.ready = true;
      this.pump();
      return;
    }
    const job = slot.job;
    if (!job || job.id !== msg.id) return;
    if (msg.type === "missing") {
      // The worker evicted this set from its cache: send it again, same deadline.
      slot.known.delete(job.key);
      this.post(slot, job);
      return;
    }
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.job = null;
    job.resolve(msg.outcome);
    this.pump();
  }

  private pump(): void {
    for (const slot of this.slots) {
      if (this.queue.length === 0) return;
      if (!slot.ready || slot.dead || slot.job) continue;
      const job = this.queue.shift();
      if (!job) return;
      slot.job = job;
      // The deadline starts at dispatch, so time spent queued behind other messages never counts.
      slot.timer = setTimeout(() => this.fail(slot, "timeout"), this.hardTimeoutMs);
      this.post(slot, job);
    }
  }

  private post(slot: Slot, job: Job): void {
    const req: RunRequest = { type: "run", id: job.id, key: job.key, body: job.body, budgetMs: this.budgetMs };
    if (!slot.known.has(job.key)) {
      req.filters = job.filters.map((f): WireFilter => ({ def: f.def, source: f.re.source, flags: f.re.flags }));
      slot.known.add(job.key);
    }
    slot.worker.postMessage(req);
  }

  /** A worker that timed out or died: hold its message, replace it, and carry on with the queue. */
  private fail(slot: Slot, reason: "timeout" | "crash"): void {
    if (slot.dead) return;
    slot.dead = true;
    if (slot.timer) clearTimeout(slot.timer);
    slot.worker.terminate();
    const job = slot.job;
    slot.job = null;
    if (job) {
      this.opts.onTimeout?.(reason);
      this.opts.logger?.warn("word filter worker replaced; message held", { reason });
      job.resolve(held(job.body));
    }
    if (this.closed) return;
    const index = this.slots.indexOf(slot);
    if (index < 0) return;
    if (slot.ready) {
      this.slots[index] = this.spawn();
      return;
    }
    // Died before it ever started: back off instead of respawning in a tight loop, and do not
    // leave messages waiting on a pool that cannot start.
    this.opts.logger?.error("word filter worker failed to start", { reason });
    if (!this.slots.some((s) => s.ready && !s.dead))
      for (const queued of this.queue.splice(0)) queued.resolve(held(queued.body));
    const retry = setTimeout(() => {
      if (!this.closed && this.slots[index] === slot) this.slots[index] = this.spawn();
    }, 1_000);
    retry.unref();
  }
}
