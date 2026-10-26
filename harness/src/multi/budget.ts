// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Time for each claim of a scenario that must finish inside its hard timeout. Every claim gets
 * its weighted share of what is left (minus a reserve for teardown), so a claim that runs to its
 * worst case cannot starve the claims after it into the scenario timeout, and one slow finding
 * never hides the others. Waits inside a claim are capped to the claim's end. Pure apart from
 * the injected clock.
 */
export class ClaimBudget {
  private end = Number.POSITIVE_INFINITY;
  private readonly now: () => number;

  constructor(
    private readonly opts: {
      /** Epoch ms by which every claim must be done. */
      deadline: number;
      /** Each claim's nominal worst-case duration (ms), in run order. */
      weights: readonly number[];
      /** Kept back for teardown (restores, defers). */
      reserveMs?: number;
      now?: () => number;
    },
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** Start claim `index`; returns the ms it may use. */
  begin(index: number): number {
    const { weights } = this.opts;
    if (index < 0 || index >= weights.length) throw new RangeError(`no claim ${index}`);
    const rest = weights.slice(index).reduce((a, b) => a + b, 0);
    const left = Math.max(0, this.opts.deadline - (this.opts.reserveMs ?? 0) - this.now());
    const share = rest > 0 ? Math.floor((left * (weights[index] ?? 0)) / rest) : left;
    this.end = this.now() + share;
    return share;
  }

  /** What is left of the current claim (ms, never negative). */
  remaining(): number {
    return Math.max(0, this.end - this.now());
  }

  /** `ms`, capped to the current claim's end, but at least `floorMs`. */
  cap(ms: number, floorMs = 0): number {
    return Math.max(floorMs, Math.min(ms, this.remaining()));
  }

  /** An absolute deadline `ms` from now, capped like `cap`. */
  until(ms: number, floorMs = 0): number {
    return this.now() + this.cap(ms, floorMs);
  }
}
