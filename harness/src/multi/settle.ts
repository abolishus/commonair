// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Waiting for the network between containers to work again after a replica was killed and
 * restored. A restored container answering its own health URL from the host says nothing about
 * connections between the other containers: on CI run 42244605154 the restores were followed by
 * 15 s of timeouts on media → mediamtx, mediamtx → api and api → mailpit, and the next scenario's
 * signup timed out on the verification mail. The probes here make such connections from inside
 * the containers; every probe must pass, and keep passing for `stableMs`, before the wait ends.
 * Pure apart from the injected clock and sleep.
 */
import { sleep as realSleep } from "../wait.ts";

export interface NetworkProbe {
  /** What the probe connects, e.g. `media /readyz (mediamtx, postgres, valkey, s3)`. */
  name: string;
  /** Resolves to null when the connection works, else why not. A throw counts as a failure. */
  check(signal?: AbortSignal): Promise<string | null>;
}

export interface SettleOptions {
  timeoutMs: number;
  /** How long every probe must keep passing (default 3 s): one passing round can be a lull. */
  stableMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const DEFAULT_STABLE_MS = 3_000;
export const DEFAULT_SETTLE_INTERVAL_MS = 1_000;

export class NetworkNotSettledError extends Error {
  constructor(
    readonly timeoutMs: number,
    /** The probes that failed in the last round that had a failure, with their reasons. */
    readonly failing: readonly { name: string; reason: string }[],
    stableMs: number,
  ) {
    super(
      `the network between containers did not settle within ${timeoutMs} ms; ` +
        (failing.length > 0
          ? `still failing: ${failing.map((f) => `${f.name}: ${f.reason}`).join("; ")}`
          : `every probe passed, but not for ${stableMs} ms in a row`),
    );
    this.name = "NetworkNotSettledError";
  }
}

/** One round of every probe, side by side; the failures with their reasons. */
export async function failingProbes(
  probes: readonly NetworkProbe[],
  signal?: AbortSignal,
): Promise<{ name: string; reason: string }[]> {
  const results = await Promise.all(
    probes.map(async (p) => {
      try {
        return { name: p.name, reason: await p.check(signal) };
      } catch (err) {
        return { name: p.name, reason: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  return results.flatMap((r) => (r.reason === null ? [] : [{ name: r.name, reason: r.reason }]));
}

/**
 * Poll every probe until all of them have passed for `stableMs` in a row. Returns how long that
 * took; throws `NetworkNotSettledError`, naming the probes still failing, at the deadline.
 */
export async function waitForNetwork(probes: readonly NetworkProbe[], opts: SettleOptions): Promise<number> {
  const now = opts.now ?? Date.now;
  const pause = opts.sleep ?? realSleep;
  const stableMs = opts.stableMs ?? DEFAULT_STABLE_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_SETTLE_INTERVAL_MS;
  const started = now();
  if (probes.length === 0) return 0;
  let passingSince: number | null = null;
  let lastFailing: { name: string; reason: string }[] = [];
  for (;;) {
    if (opts.signal?.aborted) throw opts.signal.reason;
    const failing = await failingProbes(probes, opts.signal);
    const t = now();
    if (failing.length === 0) {
      passingSince ??= t;
      if (t - passingSince >= stableMs) return t - started;
    } else {
      passingSince = null;
      lastFailing = failing;
    }
    if (t - started >= opts.timeoutMs) {
      // Passing at the deadline but not yet for stableMs still fails, naming what failed last.
      throw new NetworkNotSettledError(opts.timeoutMs, lastFailing, stableMs);
    }
    await pause(intervalMs, opts.signal);
  }
}
