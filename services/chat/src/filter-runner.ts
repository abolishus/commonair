// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where word filters run. `applyFilters` checks its time budget between filters, but cannot
 * interrupt a single `RegExp` call. The worker runner runs regex filter sets in a small pool of
 * Bun workers and terminates a worker that runs past the hard timeout; the message is held for
 * moderators, never passed. Filter sets without regex patterns (escaped literals, always linear)
 * and empty sets run inline.
 *
 * `terminate()` takes effect only when the running regex call returns, so a timed-out worker
 * keeps a core busy for a while (a "zombie"). To keep one bad filter set from burning CPU:
 * - the set is quarantined after a timeout: its messages are held without running for a while;
 * - live plus zombie threads are capped, and respawns are rate limited (token bucket);
 * - a message waits at most `maxQueueWaitMs` for a worker, and each set has a queued-job cap,
 *   so one busy channel cannot starve the others.
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

export type HoldReason = "timeout" | "crash" | "queue_full" | "queue_wait" | "quarantined" | "closed";

export interface FilterRunnerHooks {
  /** A message was held without a filter verdict. */
  held?(reason: HoldReason): void;
  /** A filter set was quarantined after a timeout (once per quarantine). */
  quarantined?(): void;
  /** Change in the number of terminated workers still running their last regex call. */
  zombies?(delta: number): void;
}

export interface WorkerFilterRunnerOptions {
  /** Worker threads in the pool (default 2). */
  workers?: number;
  /** Soft budget across all filters, checked between filters (default FILTER_BUDGET_MS). */
  budgetMs?: number;
  /** Wall time from dispatch after which the worker is terminated (default budget + 25 ms). */
  hardTimeoutMs?: number;
  /** Longest a message waits for a free worker before it is held (default 250 ms). */
  maxQueueWaitMs?: number;
  /** Messages waiting for a worker beyond this are held at once (default 10 000). */
  maxQueue?: number;
  /** Messages of one filter set waiting for a worker beyond this are held (default 50). */
  maxQueuedPerSet?: number;
  /** How long a filter set that timed out is held without running (default 5 min). */
  quarantineMs?: number;
  /** Terminated workers counted against the thread cap until they exit (default 2). */
  maxZombies?: number;
  /** A zombie that has not reported its exit stops counting after this long (default 3 s). */
  zombieGraceMs?: number;
  /** Respawn token bucket: burst size (default 4) and refill interval (default 10 s). */
  respawnBurst?: number;
  respawnRefillMs?: number;
  logger?: Logger;
  hooks?: FilterRunnerHooks;
}

interface Job {
  id: number;
  key: string;
  body: string;
  filters: readonly CompiledFilter[];
  resolve: (outcome: FilterOutcome) => void;
  waitTimer: ReturnType<typeof setTimeout> | null;
}

interface Slot {
  worker: Worker;
  ready: boolean;
  dead: boolean;
  job: Job | null;
  timer: ReturnType<typeof setTimeout> | null;
  known: Set<string>;
}

/** The worker caches this many filter sets; the runner's record of what it sent is pruned to match. */
const KNOWN_CAP = 256;

const held = (body: string): FilterOutcome => ({ action: "hold", body, filterId: null, timedOut: true });

const WORKER_URL = new URL("./filter-worker.ts", import.meta.url).href;

export class WorkerFilterRunner implements FilterRunner {
  private readonly slots: (Slot | null)[] = [];
  private readonly queue: Job[] = [];
  private readonly queuedPerKey = new Map<string, number>();
  private readonly keys = new WeakMap<readonly CompiledFilter[], string>();
  private readonly quarantine = new Map<string, number>();
  private zombieCount = 0;
  private tokens: number;
  private tokensAt = Date.now();
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 0;
  private closed = false;
  private readonly o: Required<Omit<WorkerFilterRunnerOptions, "logger" | "hooks">>;

  constructor(private readonly opts: WorkerFilterRunnerOptions = {}) {
    const budgetMs = opts.budgetMs ?? FILTER_BUDGET_MS;
    this.o = {
      workers: Math.max(1, opts.workers ?? 2),
      budgetMs,
      hardTimeoutMs: opts.hardTimeoutMs ?? budgetMs + 25,
      maxQueueWaitMs: opts.maxQueueWaitMs ?? 250,
      maxQueue: opts.maxQueue ?? 10_000,
      maxQueuedPerSet: opts.maxQueuedPerSet ?? 50,
      quarantineMs: opts.quarantineMs ?? 5 * 60_000,
      maxZombies: opts.maxZombies ?? 2,
      zombieGraceMs: opts.zombieGraceMs ?? 3_000,
      respawnBurst: opts.respawnBurst ?? 4,
      respawnRefillMs: opts.respawnRefillMs ?? 10_000,
    };
    this.tokens = this.o.respawnBurst;
    for (let i = 0; i < this.o.workers; i++) this.slots.push(this.spawn());
  }

  /** Live workers plus zombies; never above `workers + maxZombies`. */
  threads(): number {
    return this.slots.filter((s) => s !== null).length + this.zombieCount;
  }

  run(body: string, filters: readonly CompiledFilter[]): Promise<FilterOutcome> {
    if (!filters.some((f) => f.def.isRegex)) return Promise.resolve(applyFilters(body, filters, this.o.budgetMs));
    if (this.closed) return this.hold(body, "closed");
    const key = this.keyOf(filters);
    if (this.isQuarantined(key)) return this.hold(body, "quarantined");
    const queuedForKey = this.queuedPerKey.get(key) ?? 0;
    if (this.queue.length >= this.o.maxQueue || queuedForKey >= this.o.maxQueuedPerSet)
      return this.hold(body, "queue_full");
    return new Promise((resolve) => {
      const job: Job = { id: ++this.nextId, key, body, filters, resolve, waitTimer: null };
      job.waitTimer = setTimeout(() => this.expire(job), this.o.maxQueueWaitMs);
      this.queue.push(job);
      this.queuedPerKey.set(key, queuedForKey + 1);
      this.pump();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    this.queuedPerKey.clear();
    for (const job of this.queue.splice(0)) this.finish(job, held(job.body), "closed");
    for (const slot of this.slots) {
      if (!slot) continue;
      slot.dead = true;
      if (slot.timer) clearTimeout(slot.timer);
      if (slot.job) this.finish(slot.job, held(slot.job.body), "closed");
      slot.job = null;
      slot.worker.terminate();
    }
    await Promise.resolve();
  }

  private isQuarantined(key: string): boolean {
    const until = this.quarantine.get(key);
    if (until === undefined) return false;
    if (Date.now() < until) return true;
    this.quarantine.delete(key);
    return false;
  }

  private hold(body: string, reason: HoldReason): Promise<FilterOutcome> {
    this.opts.hooks?.held?.(reason);
    return Promise.resolve(held(body));
  }

  private finish(job: Job, outcome: FilterOutcome, reason?: HoldReason): void {
    if (job.waitTimer) clearTimeout(job.waitTimer);
    job.waitTimer = null;
    if (reason) this.opts.hooks?.held?.(reason);
    job.resolve(outcome);
  }

  /** Content-addressed, so a reloaded channel with the same filters keeps its quarantine. */
  private keyOf(filters: readonly CompiledFilter[]): string {
    let key = this.keys.get(filters);
    if (!key) {
      const content = JSON.stringify(filters.map((f) => [f.def.id, f.def.action, f.def.replacement, f.re.source]));
      key = Bun.hash(content).toString(36);
      this.keys.set(filters, key);
    }
    return key;
  }

  private dequeue(job: Job): boolean {
    const i = this.queue.indexOf(job);
    if (i < 0) return false;
    this.queue.splice(i, 1);
    const n = (this.queuedPerKey.get(job.key) ?? 1) - 1;
    if (n > 0) this.queuedPerKey.set(job.key, n);
    else this.queuedPerKey.delete(job.key);
    return true;
  }

  private expire(job: Job): void {
    if (this.dequeue(job)) this.finish(job, held(job.body), "queue_wait");
  }

  private spawn(): Slot {
    const worker = new Worker(WORKER_URL);
    const slot: Slot = { worker, ready: false, dead: false, job: null, timer: null, known: new Set() };
    worker.addEventListener("message", (event: MessageEvent<WorkerReply>) => this.onReply(slot, event.data));
    worker.addEventListener("error", () => this.fail(slot, "crash"));
    worker.addEventListener("close", () => this.fail(slot, "crash"));
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
    this.finish(job, msg.outcome);
    this.pump();
  }

  private pump(): void {
    for (const slot of this.slots) {
      if (this.queue.length === 0) return;
      if (!slot || !slot.ready || slot.dead || slot.job) continue;
      const job = this.queue[0];
      if (!job) return;
      this.dequeue(job);
      if (job.waitTimer) clearTimeout(job.waitTimer);
      job.waitTimer = null;
      // A set quarantined while this message waited is not run again.
      if (this.isQuarantined(job.key)) {
        this.finish(job, held(job.body), "quarantined");
        continue;
      }
      slot.job = job;
      slot.timer = setTimeout(() => this.fail(slot, "timeout"), this.o.hardTimeoutMs);
      this.post(slot, job);
    }
  }

  private post(slot: Slot, job: Job): void {
    const req: RunRequest = { type: "run", id: job.id, key: job.key, body: job.body, budgetMs: this.o.budgetMs };
    if (!slot.known.has(job.key)) {
      req.filters = job.filters.map((f): WireFilter => ({ def: f.def, source: f.re.source, flags: f.re.flags }));
      // Beyond the worker's cache size the record is useless; a stale entry only costs a resend.
      if (slot.known.size >= KNOWN_CAP) slot.known.clear();
      slot.known.add(job.key);
    }
    slot.worker.postMessage(req);
  }

  /** A worker that timed out or died: hold its message, retire it, and replace it when allowed. */
  private fail(slot: Slot, reason: "timeout" | "crash"): void {
    if (slot.dead) return;
    slot.dead = true;
    if (slot.timer) clearTimeout(slot.timer);
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots[index] = null;
    const job = slot.job;
    slot.job = null;
    if (reason === "timeout") {
      this.trackZombie(slot.worker);
      if (job) this.quarantineKey(job.key);
    }
    slot.worker.terminate();
    if (job) {
      this.opts.logger?.warn("word filter worker replaced; message held", { reason });
      this.finish(job, held(job.body), reason);
    }
    if (reason === "crash" && !slot.ready) {
      // Died before it ever started: do not let the respawn budget spin on a broken worker file.
      this.opts.logger?.error("word filter worker failed to start");
      this.refill();
      this.tokens = 0;
      this.tokensAt = Date.now();
    }
    this.respawn();
  }

  private quarantineKey(key: string): void {
    if (this.quarantine.has(key)) return;
    this.quarantine.set(key, Date.now() + this.o.quarantineMs);
    this.opts.hooks?.quarantined?.();
    this.opts.logger?.warn("word filter set quarantined after a timeout", {
      filterSet: key,
      minutes: this.o.quarantineMs / 60_000,
    });
    // Messages of this set already waiting would most likely time out too.
    for (const job of this.queue.filter((j) => j.key === key)) {
      this.dequeue(job);
      this.finish(job, held(job.body), "quarantined");
    }
  }

  private trackZombie(worker: Worker): void {
    this.zombieCount++;
    this.opts.hooks?.zombies?.(1);
    let counted = true;
    const release = () => {
      if (!counted) return;
      counted = false;
      clearTimeout(grace);
      this.zombieCount--;
      this.opts.hooks?.zombies?.(-1);
      this.respawn();
    };
    const grace = setTimeout(release, this.o.zombieGraceMs);
    grace.unref();
    worker.addEventListener("close", release);
  }

  private refill(): void {
    const now = Date.now();
    const earned = Math.floor((now - this.tokensAt) / this.o.respawnRefillMs);
    if (earned > 0) {
      this.tokens = Math.min(this.o.respawnBurst, this.tokens + earned);
      this.tokensAt += earned * this.o.respawnRefillMs;
    }
  }

  /** Fill empty slots while the thread cap and the respawn budget allow; retry later otherwise. */
  private respawn(): void {
    if (this.closed) return;
    const cap = this.o.workers + this.o.maxZombies;
    this.refill();
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i] !== null) continue;
      if (this.threads() >= cap || this.tokens < 1) break;
      this.tokens--;
      this.slots[i] = this.spawn();
    }
    if (this.slots.includes(null) && !this.respawnTimer) {
      // Zombie exits call respawn() themselves; this covers the token refill.
      this.respawnTimer = setTimeout(() => {
        this.respawnTimer = null;
        this.respawn();
      }, this.o.respawnRefillMs);
      this.respawnTimer.unref();
    }
  }
}
