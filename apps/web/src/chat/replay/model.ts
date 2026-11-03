// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The chat replay panel's model (W2-vod-watch; ADR 0012 amendment 1 decisions 5 to 8), free of
 * React so it can be tested with fake time. `vods.chat` / `clips.chat` pages are fetched forward
 * with `nextCursor` and kept in `(at, id)` order; the lines shown are those placed at or before
 * the playhead's wall clock. The model keeps about two minutes loaded ahead of the playhead.
 *
 * What is loaded is held as **spans**: runs of lines with no gap, each from a start instant (the
 * first span from the start of the video) to its last line, with its own cursor. Seeking within a
 * span is a binary search, with no request. Seeking a little past one pages it on. A seek far past
 * what is loaded (batch 8, B8-web) starts a second span at the target with `from`, and **keeps** the
 * first, so seeking back into it needs no request. Spans merge when one pages on into the next.
 * Lines are shown from the span that covers the playhead (the one with the latest start at or
 * before it).
 *
 * Memory is capped at `maxLines` (default 5,000; at well under 1 KB a line, a few MB at most):
 * past it, the span farthest from the playhead is dropped first, then the oldest lines of the
 * playhead's own span, never the ones it shows.
 *
 * A server that ignores `from` answers from the start: the model notices and pages on from the
 * first span instead, and never starts another. A failed fetch is retried with backoff (or at once
 * with `retry()`).
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
  /** A seek more than this far past what is loaded starts a new span at the target (microseconds). */
  jumpMicros?: number;
  /** When starting a span at a target, also load this much before it (microseconds). */
  backfillMicros?: number;
  /** Most lines rendered at once (the newest shown ones). */
  maxRows?: number;
  /** Most lines held in memory across every span. */
  maxLines?: number;
  /** Retry delays after a failed fetch (ms); the last repeats. */
  retryDelaysMs?: readonly number[];
  clock?: ReplayClock;
}

export const REPLAY_PAGE_SIZE = 200;
export const REPLAY_AHEAD_MICROS = 120 * MICROS_PER_SECOND;
export const REPLAY_JUMP_MICROS = 10 * 60 * MICROS_PER_SECOND;
export const REPLAY_BACKFILL_MICROS = 60 * MICROS_PER_SECOND;
export const REPLAY_MAX_ROWS = 300;
/** The memory cap: 25 pages, an hour of a busy chat; ADR 0012 amendment 1 keeps no other bound. */
export const REPLAY_MAX_LINES = 5_000;
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
  /** Spans held now (`replay-span-kept`'s `data-spans`). */
  spans: number;
  /** A deep seek started a span while an earlier one was kept (`replay-span-kept`). */
  kept: boolean;
}

export interface BlockedSet {
  ids: ReadonlySet<string>;
  usernames: ReadonlySet<string>;
}

const NO_BLOCKS: BlockedSet = { ids: new Set(), usernames: new Set() };
const STARTING: ReplaySnapshot = Object.freeze({
  status: "starting",
  lines: [],
  loading: true,
  error: false,
  spans: 1,
  kept: false,
});

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

/** A run of loaded lines with no gap: every line from `start` to the last one is here. */
interface Span {
  /** Where it starts (microseconds); null = the start of the video. */
  start: number | null;
  lines: ReplayLine[];
  cursor: string | null;
  /** Every line after `start` is loaded. */
  done: boolean;
  /** Its first page arrived. */
  fetched: boolean;
  retained: boolean;
}

const newSpan = (start: number | null): Span => ({
  start,
  lines: [],
  cursor: null,
  done: false,
  fetched: false,
  retained: true,
});

const startOf = (s: Span) => s.start ?? Number.NEGATIVE_INFINITY;

/** The newest instant up to which every line of `s` is loaded. */
function loadedEnd(s: Span): number {
  if (s.done) return Number.POSITIVE_INFINITY;
  const last = s.lines.at(-1);
  if (last) return last.atMicros;
  return startOf(s);
}

/** Sorted `(at, id)` union of two sorted runs, each line once. */
function mergeLines(a: readonly ReplayLine[], b: readonly ReplayLine[]): ReplayLine[] {
  const out: ReplayLine[] = [];
  let i = 0;
  let j = 0;
  for (;;) {
    const x = a[i];
    const y = b[j];
    let pick: ReplayLine;
    if (x && (!y || compare(x, y) <= 0)) {
      pick = x;
      i++;
    } else if (y) {
      pick = y;
      j++;
    } else break;
    const prev = out.at(-1);
    if (!prev || compare(prev, pick) !== 0) out.push(pick);
  }
  return out;
}

export class ReplayModel {
  private readonly opts: Required<Omit<ReplayModelOptions, "clock">> & { clock: ReplayClock };
  /** Sorted by start; never overlapping once `merge()` has run. */
  private spans: Span[] = [newSpan(null)];
  /** The span the playhead is in (or will be once its first page lands): the one fetched for and shown. */
  private active: Span = this.spans[0] as Span;
  /** The server answered a `from` request from the start: never start another span. */
  private fromIgnored = false;
  private kept = false;
  private playhead: number | null = null;
  private blocked: BlockedSet = NO_BLOCKS;
  private inflight = false;
  private generation = 0;
  private failures = 0;
  private retryTimer: unknown = null;
  /** Between `start()` and `stop()`: only then does the model fetch. */
  private running = false;
  private snap: ReplaySnapshot = STARTING;
  private readonly listeners = new Set<() => void>();

  constructor(options: ReplayModelOptions) {
    this.opts = {
      pageSize: REPLAY_PAGE_SIZE,
      aheadMicros: REPLAY_AHEAD_MICROS,
      jumpMicros: REPLAY_JUMP_MICROS,
      backfillMicros: REPLAY_BACKFILL_MICROS,
      maxRows: REPLAY_MAX_ROWS,
      maxLines: REPLAY_MAX_LINES,
      retryDelaysMs: REPLAY_RETRY_DELAYS_MS,
      ...options,
      clock: options.clock ?? realClock,
    };
  }

  /** Begin (or resume) fetching. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.pump();
    this.publish();
  }

  /** Stop fetching: a request in flight is dropped and no retry is pending; loaded lines stay. */
  stop(): void {
    this.running = false;
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

  /** Lines held in memory, across every span. */
  heldLines(): number {
    return this.spans.reduce((n, s) => n + s.lines.length, 0);
  }

  /** The playhead's wall clock in epoch microseconds; null before the first frame. */
  setPlayhead(us: number | null): void {
    const next = us !== null && Number.isFinite(us) ? us : null;
    if (next === this.playhead) return;
    this.playhead = next;
    this.retarget();
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
    this.kept = false;
    this.spans = [newSpan(null)];
    this.switchTo(this.spans[0] as Span);
    this.pump();
    this.publish();
  }

  // ------------------------------------------------------------------ internals

  /** Fetch for `span` from now on: a request in flight for another span is dropped. */
  private switchTo(span: Span): void {
    this.generation++;
    this.inflight = false;
    this.clearRetry();
    this.failures = 0;
    // A span whose first page never arrived holds nothing worth keeping.
    this.spans = this.spans.filter((s) => s === span || s.fetched);
    this.active = span;
  }

  /** The span with the latest start at or before `at`, if any. */
  private spanAt(at: number): Span | undefined {
    let found: Span | undefined;
    for (const s of this.spans) if (startOf(s) <= at) found = s;
    return found;
  }

  /**
   * Pick the span for the playhead: the one it is in, or the one it can page on to; otherwise a
   * new span at the target, keeping the others. Checked on every playhead move and after every
   * page: a paused video seeked while a first page was in flight sends no further playhead event.
   */
  private retarget(): void {
    const at = this.playhead;
    if (at === null) return;
    const here = this.spanAt(at);
    let next: Span;
    if (this.fromIgnored) next = this.spans[0] as Span;
    else if (here && (!here.fetched || at - loadedEnd(here) <= this.opts.jumpMicros)) next = here;
    else {
      // Far past the span before it (or before every span, once the first was dropped by the cap).
      next = newSpan(at - this.opts.backfillMicros);
      this.spans.push(next);
      this.spans.sort((a, b) => startOf(a) - startOf(b));
      if (this.spans.some((s) => s !== next && s.lines.length > 0)) this.kept = true;
    }
    if (next !== this.active) this.switchTo(next);
  }

  private wanted(): boolean {
    const s = this.active;
    if (!s.fetched) return true;
    if (s.done || this.playhead === null) return false;
    return loadedEnd(s) < this.playhead + this.opts.aheadMicros;
  }

  private pump(): void {
    if (!this.running || this.inflight || this.retryTimer !== null || !this.wanted()) return;
    const gen = this.generation;
    const span = this.active;
    const input: ReplayFetchInput = { limit: this.opts.pageSize };
    if (span.cursor !== null) input.cursor = span.cursor;
    else if (span.start !== null) input.from = new Date(Math.floor(span.start / 1000)).toISOString();
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
        this.accept(span, page, input);
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

  private accept(span: Span, page: ReplayPage, input: ReplayFetchInput): void {
    const incoming: ReplayLine[] = [];
    for (const item of page.items) {
      const atMicros = isoToMicros(item.at);
      if (Number.isFinite(atMicros)) incoming.push({ item, atMicros, quoteHidden: false });
    }
    if (input.from !== undefined && span.start !== null) {
      // A server that ignores `from` starts at the beginning: page on from the first span instead.
      const first = incoming[0];
      if (first && first.atMicros < span.start - MICROS_PER_SECOND) {
        this.fromIgnored = true;
        this.kept = false;
        const base = this.spans.find((s) => s.start === null && s !== span);
        if (base) {
          this.spans = this.spans.filter((s) => s !== span);
          this.switchTo(base);
          return;
        }
        span.start = null;
      }
    }
    const last = span.lines.at(-1);
    const fresh = last ? incoming.filter((l) => compare(l, last) > 0) : incoming;
    span.lines.push(...fresh);
    // Pages arrive in order; a server that does not keep it still renders in order.
    for (let i = 1; i < fresh.length; i++) {
      const a = fresh[i - 1];
      const b = fresh[i];
      if (a && b && compare(a, b) > 0) {
        span.lines.sort(compare);
        break;
      }
    }
    const first = !span.fetched;
    if (first) span.retained = page.retained;
    span.fetched = true;
    span.cursor = page.nextCursor;
    span.done = page.nextCursor === null;
    this.merge();
    this.cap();
    this.retarget();
  }

  /** Join spans that touch: one paged on to (or past) the next one's start. */
  private merge(): void {
    const out: Span[] = [];
    for (const s of this.spans) {
      const prev = out.at(-1);
      if (prev && prev.fetched && s.fetched && loadedEnd(prev) >= startOf(s)) {
        // The joined span continues from whichever of the two reaches further.
        const further = loadedEnd(s) > loadedEnd(prev) ? s : prev;
        prev.lines = mergeLines(prev.lines, s.lines);
        prev.cursor = further.cursor;
        prev.done = further.done;
        if (this.active === s) this.active = prev;
        continue;
      }
      out.push(s);
    }
    this.spans = out;
  }

  /** Distance from the playhead to what `s` holds (0 inside it). */
  private distance(s: Span): number {
    const at = this.playhead ?? Number.NEGATIVE_INFINITY;
    const from = s.lines[0]?.atMicros ?? startOf(s);
    const to = s.lines.at(-1)?.atMicros ?? from;
    if (at < from) return from - at;
    if (at > to) return at - to;
    return 0;
  }

  /** Keep at most `maxLines`: drop the farthest spans, then the oldest unshown lines of the active one. */
  private cap(): void {
    const max = this.opts.maxLines;
    while (this.heldLines() > max && this.spans.length > 1) {
      let far: Span | undefined;
      for (const s of this.spans) if (s !== this.active && (!far || this.distance(s) > this.distance(far))) far = s;
      if (!far) break;
      this.spans = this.spans.filter((s) => s !== far);
    }
    const over = this.heldLines() - max;
    // With `from` ignored there is no way back to a trimmed start: keep everything.
    if (over <= 0 || this.fromIgnored) return;
    const s = this.active;
    const shown = this.playhead === null ? 0 : countAtOrBefore(s.lines, this.playhead);
    let n = Math.min(over, Math.max(0, shown - this.opts.maxRows));
    // Cut between two instants, so the new start covers every line at and after it.
    while (n > 0 && s.lines[n]?.atMicros === s.lines[n - 1]?.atMicros) n--;
    const head = s.lines[n];
    if (n === 0 || !head) return;
    s.lines = s.lines.slice(n);
    s.start = head.atMicros;
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
    const spans = this.spans.length;
    const kept = this.kept;
    if (!this.spans.some((s) => s.fetched))
      return { status: "starting", lines: [], loading: !error, error, spans, kept };
    const { ids, usernames } = this.blocked;
    const unblocked = (l: ReplayLine) => !ids.has(l.item.user.id);
    const base = this.spans.find((s) => s.start === null);
    if (base && base.fetched && base.done && !base.lines.some(unblocked))
      return { status: base.retained ? "empty" : "not-retained", lines: [], loading: false, error, spans, kept };
    const shown: ReplayLine[] = [];
    const s = this.active;
    if (this.playhead !== null) {
      const n = countAtOrBefore(s.lines, this.playhead);
      for (let i = n - 1; i >= 0 && shown.length < this.opts.maxRows; i--) {
        const l = s.lines[i];
        if (!l || !unblocked(l)) continue;
        const quoted = l.item.replyTo?.username;
        const quoteHidden = quoted !== undefined && usernames.has(quoted);
        shown.push(quoteHidden === l.quoteHidden ? l : { ...l, quoteHidden });
      }
      shown.reverse();
    }
    const loading =
      this.playhead !== null && ((!s.fetched && !error) || (this.inflight && loadedEnd(s) < this.playhead));
    return { status: "ready", lines: shown, loading, error, spans, kept };
  }
}
