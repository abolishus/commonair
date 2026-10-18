// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Waiters with timeouts. Every wait in the harness has a deadline and says what it waited for. */

export class TimeoutError extends Error {
  constructor(
    public readonly what: string,
    public readonly timeoutMs: number,
    public readonly lastError?: unknown,
  ) {
    const detail = lastError instanceof Error ? ` (last error: ${lastError.message})` : "";
    super(`timed out after ${timeoutMs} ms waiting for ${what}${detail}`);
    this.name = "TimeoutError";
  }
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Poll `probe` until it returns a value other than `false`/`null`/`undefined`, and return that
 * value. Probe errors are retried until the deadline and reported with the timeout.
 */
export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | false | null | undefined> | T | false | null | undefined,
  opts: WaitOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    if (opts.signal?.aborted) throw opts.signal.reason;
    try {
      const value = await probe();
      if (value !== false && value !== null && value !== undefined) return value;
      lastError = undefined;
    } catch (err) {
      lastError = err;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new TimeoutError(what, timeoutMs, lastError);
    await sleep(Math.min(intervalMs, remaining), opts.signal);
  }
}

/** Reject with TimeoutError if `promise` does not settle within `timeoutMs`. */
export async function withTimeout<T>(what: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(what, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
