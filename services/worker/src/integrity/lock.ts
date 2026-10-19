// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A run lock in Valkey so a recurring job never overlaps itself across replicas.
 * BullMQ job schedulers enqueue the next iteration when the current one starts, so a run
 * slower than its interval (or a retry racing the next tick) would otherwise run twice.
 *
 * The lock has a short TTL and is renewed while the run is alive, up to `maxHoldMs`: a
 * run stuck past that stops renewing, the lock expires and the next tick may run again,
 * so one hung run cannot stop a job forever. Either way (a renewal that fails, or that finds
 * the lock no longer ours, or reaching `maxHoldMs`) the lapse is logged and counted once per
 * run as `worker.integrity.runs{outcome:"lock_lapsed"}`, since an overlap may follow.
 */
import type { Logger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import { metrics } from "../metrics.ts";

const RENEW = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export interface LockOptions {
  /** Lock TTL; renewed every third of it while the run is alive. */
  ttlMs: number;
  /** Stop renewing after this long, so a stuck run eventually lets the next one through. */
  maxHoldMs: number;
  /** Job name and logger for lapse reporting (the name is the only field logged). */
  job: string;
  logger: Logger;
}

export type LapseReason = "renew_failed" | "lock_lost" | "max_hold";

export type LockResult<T> = { acquired: true; value: T } | { acquired: false };

export async function withRunLock<T>(
  valkey: ValkeyClient,
  key: string,
  opts: LockOptions,
  fn: () => Promise<T>,
): Promise<LockResult<T>> {
  const token = crypto.randomUUID();
  const ok = await valkey.set(key, token, "PX", opts.ttlMs, "NX");
  if (ok !== "OK") return { acquired: false };
  const started = Date.now();
  let lapsed = false;
  let finished = false;
  const lapse = (reason: LapseReason) => {
    // A renewal still in flight when the run releases the lock is not a lapse.
    if (lapsed || finished) return;
    lapsed = true;
    metrics.integrityRuns.add(1, { job: opts.job, outcome: "lock_lapsed" });
    opts.logger.warn("integrity run lock lapsed; the next tick may overlap this run", {
      job: opts.job,
      reason,
    });
  };
  const timer = setInterval(
    () => {
      if (Date.now() - started > opts.maxHoldMs) {
        clearInterval(timer);
        lapse("max_hold");
        return;
      }
      // Keep renewing after a failure: a transient error may still leave the lock ours.
      valkey.eval(RENEW, 1, key, token, String(opts.ttlMs)).then(
        (r) => {
          if (Number(r) !== 1) lapse("lock_lost");
        },
        () => lapse("renew_failed"),
      );
    },
    Math.max(100, Math.floor(opts.ttlMs / 3)),
  );
  timer.unref?.();
  try {
    return { acquired: true, value: await fn() };
  } finally {
    finished = true;
    clearInterval(timer);
    await valkey.eval(RELEASE, 1, key, token).catch(() => {});
  }
}
