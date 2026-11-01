// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The chat replay panel's model (W2-vod-watch; ADR 0012 amendment 1 decisions 5 to 8), free of
 * React so it can be tested with fake time. `vods.chat` / `clips.chat` pages are fetched forward
 * with `nextCursor` and kept in `(at, id)` order; the lines shown are those placed at or before
 * the playhead's wall clock. The model keeps about two minutes loaded ahead of the playhead.
 *
 * Seeking back is a binary search over what is loaded. Seeking forward pages on; a seek far past
 * what is loaded starts again at the target (`from`), so a jump deep into a long VOD is one
 * request. A server that ignores `from` answers from the start: the model notices and pages on
 * from there instead. A failed fetch is retried with backoff (or at once with `retry()`).
 *
 * The server already leaves out what the live room could no longer see and the caller's blocks;
 * blocks made during the visit are applied here (`setBlocked`).
 */
import type * as D from "@commonair/contracts/dto";
import type { z } from "zod";
import { isoToMicros, MICROS_PER_SECOND } from "./time.ts";

export type ReplayPage = z.output<typeof D.ChatReplayPage>;
export type ReplayItem = ReplayPage["items"][number];

export interface ReplayFetchInput {
  cursor?: string;
  /** ISO 8601: start at the first line at or after this instant (ignored with `cursor`). */
  from?: string;
  limit: number;
}
export type ReplayFetch = (input: ReplayFetchInput) => Promise<ReplayPage>;

export interface ReplayClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: ReplayClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface ReplayModelOptions {
  fetch: ReplayFetch;
  /** Lines per request (contract: 1 to 500). */
  pageSize?: number;
  /** How far ahead of the playhead to keep loaded (microseconds). */
  aheadMicros?: number;
  /** A seek more than this far past what is loaded starts again at the target (microseconds). */
  jumpMicros?: number;
  /** When starting again at a target, also load this much before it (microseconds). */
  backfillMicros?: number;
  /** Most lines rendered at once (the newest shown ones). */
  maxRows?: number;
  /** Retry delays after a failed fetch (ms); the last repeats. */
  retryDelaysMs?: readonly number[];
  clock?: ReplayClock;
}

export const REPLAY_PAGE_SIZE = 200;
export const REPLAY_AHEAD_MICROS = 120 * MICROS_PER_SECOND;
export const REPLAY_JUMP_MICROS = 10 * 60 * MICROS_PER_SECOND;
export const REPLAY_BACKFILL_MICROS = 60 * MICROS_PER_SECOND;
export const REPLAY_MAX_ROWS = 300;
export const REPLAY_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000];

export interface ReplayLine {
  item: ReplayItem;
  /** `item.at` in epoch microseconds. */
  atMicros: number;
  /** The quoted line's author is blocked during this visit: show no quote. */
  quoteHidden: boolean;
}

/** `empty`: the video has no chat; `not-retained`: its chat aged out (decision 6). */
export type ReplayStatus = "starting" | "ready" | "empty" | "not-retained";

export interface ReplaySnapshot {
  status: ReplayStatus;
  /** Lines at or before the playhead, oldest first (at most `maxRows`, the newest ones). */
  lines: readonly ReplayLine[];
  /** Pages the playhead already needs are being fetched (the loading row). */
  loading: boolean;
  /** The last fetch failed; a retry is scheduled. */
  error: boolean;
}

export interface BlockedSet {
  ids: ReadonlySet<string>;
  usernames: ReadonlySet<string>;
}

const NO_BLOCKS: BlockedSet = { ids: new Set(), usernames: new Set() };
const STARTING: ReplaySnapshot = Object.freeze({ status: "starting", lines: [], loading: true, error: false });

/** `(at, id)` order. */
function compare(a: ReplayLine, b: ReplayLine): number {
  return a.atMicros - b.atMicros || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0);
}

/** How many of `lines` (sorted) are placed at or before `us`. */
export function countAtOrBefore(lines: readonly { atMicros: number }[], us: number): number {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((lines[mid]?.atMicros ?? Number.POSITIVE_INFINITY) <= us) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class ReplayModel {
  private readonly opts: Required<Omit<ReplayModelOptions, "clock">> & { clock: ReplayClock };
  private lines: ReplayLine[] = [];
  /** Where the loaded span starts (microseconds); null = the start of the video. */
  private spanStart: number | null = null;
  private cursor: string | null = null;
  /** Every line after the span start is loaded. */
  private done = false;
  /** The first page of the current span arrived. */
  private fetched = false;
  private retained = true;
  /** The server answered a `from` request from the start: never start again at a target. */
  private fromIgnored = false;
  private playhead: number | null = null;
  private blocked: BlockedSet = NO_BLOCKS;
  private inflight = false;
  private generation = 0;
  private failures = 0;
  private retryTimer: unknown = null;
  /** Between `start()` and `stop()`: only then does the model fetch. */
  private active = false;
  private snap: ReplaySnapshot = STARTING;
  private readonly listeners = new Set<() => void>();

  constructor(options: ReplayModelOptions) {
    this.opts = {
      pageSize: REPLAY_PAGE_SIZE,
      aheadMicros: REPLAY_AHEAD_MICROS,
      jumpMicros: REPLAY_JUMP_MICROS,
      backfillMicros: REPLAY_BACKFILL_MICROS,
      maxRows: REPLAY_MAX_ROWS,
      retryDelaysMs: REPLAY_RETRY_DELAYS_MS,
      ...options,
      clock: options.clock ?? realClock,
    };
  }

  /** Begin (or resume) fetching. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.pump();
    this.publish();
  }

  /** Stop fetching: a request in flight is dropped and no retry is pending; loaded lines stay. */
  stop(): void {
    this.active = false;
    this.generation++;
    this.inflight = false;
    this.clearRetry();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): ReplaySnapshot {
    return this.snap;
  }

  /** The playhead's wall clock in epoch microseconds; null before the first frame. */
  setPlayhead(us: number | null): void {
    const next = us !== null && Number.isFinite(us) ? us : null;
    if (next === this.playhead) return;
    this.playhead = next;
    this.jumpIfAway();
    this.pump();
    this.publish();
  }

  /** Blocks the viewer made during the visit (the store in `chat/blocks.ts`). */
  setBlocked(blocked: BlockedSet): void {
    if (blocked === this.blocked) return;
    this.blocked = blocked;
    this.publish();
  }

  /** Fetch again now after a failure. */
  retry(): void {
    if (this.inflight) return;
    this.clearRetry();
    this.failures = 0;
    this.pump();
    this.publish();
  }

  /** Start over from the beginning (the signed-in viewer changed, so the server's filter did). */
  reset(): void {
    this.fromIgnored = false;
    this.restart(null);
    this.pump();
    this.publish();
  }

  // ------------------------------------------------------------------ internals

  private restart(spanStart: number | null): void {
    this.generation++;
    this.inflight = false;
    this.clearRetry();
    this.failures = 0;
    this.lines = [];
    this.spanStart = spanStart;
    this.cursor = null;
    this.done = false;
    this.fetched = false;
    this.retained = true;
  }

  /**
   * Start again at the playhead when it sits before the loaded span or far past it. Checked on
   * every playhead move and once the first page lands: a paused video seeked while that page was
   * in flight sends no further playhead event.
   */
  private jumpIfAway(): void {
    const at = this.playhead;
    if (at === null || !this.fetched || this.fromIgnored) return;
    const behind = this.spanStart !== null && at < this.spanStart;
    const far = !this.done && at - this.loadedEnd() > this.opts.jumpMicros;
    if (behind || far) this.restart(at - this.opts.backfillMicros);
  }

  /** The newest instant up to which every line is loaded. */
  private loadedEnd(): number {
    if (this.done) return Number.POSITIVE_INFINITY;
    const last = this.lines.at(-1);
    if (last) return last.atMicros;
    return this.spanStart ?? Number.NEGATIVE_INFINITY;
  }

  private wanted(): boolean {
    if (!this.fetched) return true;
    if (this.done || this.playhead === null) return false;
    return this.loadedEnd() < this.playhead + this.opts.aheadMicros;
  }

  private pump(): void {
    if (!this.active || this.inflight || this.retryTimer !== null || !this.wanted()) return;
    const gen = this.generation;
    const input: ReplayFetchInput = { limit: this.opts.pageSize };
    if (this.cursor !== null) input.cursor = this.cursor;
    else if (this.spanStart !== null) input.from = new Date(Math.floor(this.spanStart / 1000)).toISOString();
    this.inflight = true;
    let request: Promise<ReplayPage>;
    try {
      request = this.opts.fetch(input);
    } catch (err) {
      request = Promise.reject(err);
    }
    request.then(
      (page) => {
        if (gen !== this.generation) return;
        this.inflight = false;
        this.failures = 0;
        this.accept(page, input);
        this.pump();
        this.publish();
      },
      () => {
        if (gen !== this.generation) return;
        this.inflight = false;
        const delays = this.opts.retryDelaysMs;
        const delay = delays[Math.min(this.failures, delays.length - 1)] ?? 1_000;
        this.failures++;
        this.retryTimer = this.opts.clock.setTimeout(() => {
          this.retryTimer = null;
          this.pump();
          this.publish();
        }, delay);
        this.publish();
      },
    );
  }

  private accept(page: ReplayPage, input: ReplayFetchInput): void {
    const incoming: ReplayLine[] = [];
    for (const item of page.items) {
      const atMicros = isoToMicros(item.at);
      if (Number.isFinite(atMicros)) incoming.push({ item, atMicros, quoteHidden: false });
    }
    if (input.from !== undefined && this.spanStart !== null) {
      // A server that ignores `from` starts at the beginning: take the span from there.
      const first = incoming[0];
      if (first && first.atMicros < this.spanStart - MICROS_PER_SECOND) {
        this.fromIgnored = true;
        this.spanStart = null;
      }
    }
    const last = this.lines.at(-1);
    const fresh = last ? incoming.filter((l) => compare(l, last) > 0) : incoming;
    this.lines.push(...fresh);
    // Pages arrive in order; a server that does not keep it still renders in order.
    for (let i = 1; i < fresh.length; i++) {
      const a = fresh[i - 1];
      const b = fresh[i];
      if (a && b && compare(a, b) > 0) {
        this.lines.sort(compare);
        break;
      }
    }
    const first = !this.fetched;
    if (first) this.retained = page.retained;
    this.fetched = true;
    this.cursor = page.nextCursor;
    this.done = page.nextCursor === null;
    if (first) this.jumpIfAway();
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) this.opts.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private publish(): void {
    this.snap = this.compute();
    for (const fn of this.listeners) fn();
  }

  private compute(): ReplaySnapshot {
    const error = this.retryTimer !== null;
    if (!this.fetched) return { status: "starting", lines: [], loading: !error, error };
    const { ids, usernames } = this.blocked;
    const unblocked = (l: ReplayLine) => !ids.has(l.item.user.id);
    const fromStart = this.spanStart === null;
    if (fromStart && this.done && !this.lines.some(unblocked))
      return { status: this.retained ? "empty" : "not-retained", lines: [], loading: false, error };
    const shown: ReplayLine[] = [];
    if (this.playhead !== null) {
      const n = countAtOrBefore(this.lines, this.playhead);
      for (let i = n - 1; i >= 0 && shown.length < this.opts.maxRows; i--) {
        const l = this.lines[i];
        if (!l || !unblocked(l)) continue;
        const quoted = l.item.replyTo?.username;
        const quoteHidden = quoted !== undefined && usernames.has(quoted);
        shown.push(quoteHidden === l.quoteHidden ? l : { ...l, quoteHidden });
      }
      shown.reverse();
    }
    const loading = this.inflight && this.playhead !== null && this.loadedEnd() < this.playhead;
    return { status: "ready", lines: shown, loading, error };
  }
}
