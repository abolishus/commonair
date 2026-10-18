// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Per-connection token bucket. It protects the gateway and the upstream from a
 * single flooding socket; the chat rate limits users actually see (20 msgs/30 s)
 * are enforced upstream.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly burst: number,
    private readonly perSecond: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.tokens = burst;
    this.last = now();
  }

  /** Take one token; false when the bucket is empty. */
  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.perSecond);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
