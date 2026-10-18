// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Logger } from "@commonair/observability";

/**
 * Adaptive poll delay: run again immediately while there is a backlog, after
 * `min` when the last pass found some work, and back off by doubling to `max`
 * while idle. Errors back off to `max` so a dead dependency is not hammered.
 */
export class AdaptiveDelay {
  private current: number;
  constructor(
    private readonly min: number,
    private readonly max: number,
  ) {
    this.current = min;
  }
  next(outcome: "full" | "some" | "none" | "error"): number {
    if (outcome === "full") this.current = this.min;
    else if (outcome === "some") this.current = this.min;
    else if (outcome === "none") this.current = Math.min(this.max, this.current * 2);
    else this.current = this.max;
    return outcome === "full" ? 0 : this.current;
  }
}

export interface LoopHandle {
  stop(): Promise<void>;
}

/**
 * Run `pass` repeatedly until stopped. `pass` returns how long to sleep before
 * the next pass. Stop waits for the current pass to finish (in-flight work is
 * never cut off mid-transaction).
 */
export function startLoop(name: string, logger: Logger, pass: () => Promise<number>): LoopHandle {
  let stopping = false;
  let wake: (() => void) | undefined;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (ms <= 0) return resolve();
      const t = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  const done = (async () => {
    while (!stopping) {
      let delay: number;
      try {
        delay = await pass();
      } catch (err) {
        logger.error(`${name} pass failed`, { err });
        delay = 1000;
      }
      if (!stopping) await sleep(delay);
    }
  })();
  return {
    async stop() {
      stopping = true;
      wake?.();
      await done;
    },
  };
}
