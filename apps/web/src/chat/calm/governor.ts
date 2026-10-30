// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Calm Chat's rate governor (feature-wins §4.2): at most `rowsPerSecond` new rows in any one-second
 * window. Candidates wait for the next `flush`, which lets the most important through first:
 * mentions of the viewer, the broadcaster, moderators, replies to the viewer, first-time chatters,
 * subscribers when that setting is on, then everyone else. What does not fit is dropped from view
 * (never from the log) and counted for the digest. Mentions of the viewer are never dropped: they
 * pass even over the limit (and still use it up). Pure apart from the injected clock.
 */
import type { ChatMessageFrame } from "../connection.ts";
import { isForMe, isOwn } from "./reducer.ts";
import { mentions } from "./normalize.ts";

export const RATE_MIN = 1;
export const RATE_MAX = 10;
export const RATE_DEFAULT = 3;
const WINDOW_MS = 1_000;

/** Lower is more important. */
export const PRIORITY = {
  mention: 0,
  broadcaster: 1,
  moderator: 2,
  reply: 3,
  firstTime: 4,
  subscriber: 5,
  rest: 6,
} as const;
export type Priority = (typeof PRIORITY)[keyof typeof PRIORITY];

export interface PriorityContext {
  /** The viewer's username; null signed out. */
  self: string | null;
  /** The sender's first message this session (as far as this page has seen). */
  firstTime: boolean;
  subscriberPriority: boolean;
}

export function priorityOf(m: ChatMessageFrame, ctx: PriorityContext): Priority {
  const badges = new Set(m.user.badges.map((b) => b.type));
  // The viewer's own lines are never governed away either.
  if (mentions(m.body, ctx.self) || isOwn(m, ctx.self)) return PRIORITY.mention;
  if (badges.has("broadcaster")) return PRIORITY.broadcaster;
  if (badges.has("moderator")) return PRIORITY.moderator;
  if (isForMe(m, ctx.self)) return PRIORITY.reply;
  if (ctx.firstTime) return PRIORITY.firstTime;
  if (ctx.subscriberPriority && badges.has("subscriber")) return PRIORITY.subscriber;
  return PRIORITY.rest;
}

export const clampRate = (n: number): number =>
  Number.isFinite(n) ? Math.min(RATE_MAX, Math.max(RATE_MIN, Math.round(n))) : RATE_DEFAULT;

export interface Candidate {
  id: string;
  priority: Priority;
}

export interface FlushResult {
  admitted: string[];
  dropped: string[];
}

export class RateGovernor {
  private queue: { c: Candidate; seq: number }[] = [];
  private shownAt: number[] = [];
  private seq = 0;
  private readonly now: () => number;
  rowsPerSecond: number;

  constructor(opts: { rowsPerSecond?: number; now: () => number }) {
    this.rowsPerSecond = clampRate(opts.rowsPerSecond ?? RATE_DEFAULT);
    this.now = opts.now;
  }

  setRate(rowsPerSecond: number): void {
    this.rowsPerSecond = clampRate(rowsPerSecond);
  }

  /** Queue a new row for the next flush. */
  offer(c: Candidate): void {
    this.queue.push({ c, seq: this.seq++ });
  }

  /** Whether `id` waits for the next flush. */
  isQueued(id: string): boolean {
    return this.queue.some((q) => q.c.id === id);
  }

  /** Rows still allowed in the current one-second window. */
  budget(): number {
    const t = this.now();
    this.shownAt = this.shownAt.filter((at) => t - at < WINDOW_MS);
    return Math.max(0, this.rowsPerSecond - this.shownAt.length);
  }

  /** Let the most important queued rows through, within the budget; drop the rest. */
  flush(): FlushResult {
    if (this.queue.length === 0) return { admitted: [], dropped: [] };
    let budget = this.budget();
    const t = this.now();
    const ordered = this.queue.sort((a, b) => a.c.priority - b.c.priority || a.seq - b.seq);
    this.queue = [];
    const admitted: string[] = [];
    const dropped: string[] = [];
    for (const { c } of ordered) {
      if (c.priority === PRIORITY.mention || budget > 0) {
        admitted.push(c.id);
        this.shownAt.push(t);
        budget = Math.max(0, budget - 1);
      } else dropped.push(c.id);
    }
    return { admitted, dropped };
  }

  reset(): void {
    this.queue = [];
    this.shownAt = [];
  }
}
