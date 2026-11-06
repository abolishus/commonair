// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `settledPool`: at most `limit` calls in flight, each next item starting as soon as one ends (no
 * batch waits for its slowest member). After a failure nothing more starts, the calls in flight
 * finish, and then the first error is thrown, so a failed recording never leaves another one's
 * publisher running in the background. Results keep the input order.
 */
export async function settledPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`pool limit must be a positive integer (${limit})`);
  const out: R[] = [];
  const state: { failure: { err: unknown } | null } = { failure: null };
  let next = 0;
  const worker = async () => {
    while (next < items.length && !state.failure) {
      if (signal?.aborted) {
        state.failure ??= { err: signal.reason };
        return;
      }
      const i = next++;
      try {
        out[i] = await fn(items[i] as T, i);
      } catch (err) {
        state.failure ??= { err };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (state.failure) throw state.failure.err;
  return out;
}

/**
 * Wall time of running `seconds` (in order) through a pool of `limit`, each item taking its slot
 * as soon as one frees. Pure: what `settledPool` takes for the recordings (the shard estimate).
 */
export function poolSeconds(seconds: readonly number[], limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`pool limit must be a positive integer (${limit})`);
  const slots: number[] = Array.from({ length: Math.min(limit, seconds.length) }, () => 0);
  for (const s of seconds) {
    let i = 0;
    for (let j = 1; j < slots.length; j++) if ((slots[j] as number) < (slots[i] as number)) i = j;
    slots[i] = (slots[i] as number) + s;
  }
  return Math.max(0, ...slots);
}
