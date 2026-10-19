// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Per-host cap on concurrent ladder transcodes. A ladder is one decode plus up to three
 * encodes; past a few of them the host drops frames for everyone, so further broadcasts wait
 * (their controllers retry every poll, in arrival order) and report a stream-health warning.
 */
import { availableParallelism } from "node:os";
import type { H264Encoder } from "../ffmpeg/args.ts";

/**
 * Slot count when TRANSCODE_MAX_LADDERS is unset.
 * NVENC: consumer GPUs allow a handful of sessions and each ladder opens up to three.
 * libx264 veryfast: roughly four cores per 1080p ladder.
 */
export function defaultTranscodeSlots(encoder: H264Encoder, cpus = availableParallelism()): number {
  if (encoder === "h264_nvenc") return 2;
  return Math.max(1, Math.floor(cpus / 4));
}

export class SlotLimiter {
  private readonly holders = new Set<string>();
  /** Waiting owners in arrival order: a slot goes to the longest waiter first. */
  private readonly waiting: string[] = [];

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 0) throw new Error("slot capacity must be a non-negative integer");
  }

  get inUse(): number {
    return this.holders.size;
  }

  holds(owner: string): boolean {
    return this.holders.has(owner);
  }

  /**
   * Take a slot for `owner` (idempotent). When none is free, or an earlier waiter is queued,
   * `owner` joins the queue and false is returned; call again on the next poll.
   */
  tryAcquire(owner: string): boolean {
    if (this.holders.has(owner)) return true;
    const free = this.holders.size < this.capacity;
    const first = this.waiting[0];
    if (free && (first === undefined || first === owner)) {
      if (first === owner) this.waiting.shift();
      this.holders.add(owner);
      return true;
    }
    if (!this.waiting.includes(owner)) this.waiting.push(owner);
    return false;
  }

  /** Give back a slot, or leave the queue (idempotent). */
  release(owner: string): void {
    this.holders.delete(owner);
    const i = this.waiting.indexOf(owner);
    if (i >= 0) this.waiting.splice(i, 1);
  }

  /** Position in the queue (0-based), or null when not waiting. */
  queuePosition(owner: string): number | null {
    const i = this.waiting.indexOf(owner);
    return i < 0 ? null : i;
  }
}
