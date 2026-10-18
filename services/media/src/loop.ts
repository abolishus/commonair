// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Logger } from "@commonair/observability";

export interface Loop {
  stop(): Promise<void>;
}

/**
 * Run `fn` every `intervalMs`, never overlapping (the next run is scheduled after the previous
 * one settles) and never letting one failure end the loop. `stop` waits for an in-flight run.
 */
export function every(
  intervalMs: number,
  fn: () => Promise<void>,
  opts: { logger: Logger; name: string; initialDelayMs?: number },
): Loop {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let current: Promise<void> = Promise.resolve();
  const tick = () => {
    timer = null;
    if (stopped) return;
    current = fn()
      .catch((err: unknown) => opts.logger.warn("periodic task failed", { task: opts.name, err }))
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, intervalMs);
      });
  };
  timer = setTimeout(tick, opts.initialDelayMs ?? intervalMs);
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current;
    },
  };
}
