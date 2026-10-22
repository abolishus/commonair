// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The operations test hook (docs/testing/e6-selectors.md, "Stack and test hooks"):
 * `POST /internal/ops/tick` behind `INTERNAL_API_SECRET`, served only while the stack runs with
 * `OPS_TEST_HOOKS=true` (harness/compose.e6.yaml). The API enqueues the job, waits up to 60 s and
 * returns its counts; a job whose run lock was busy answers `{ skipped: 1 }` and is ticked again.
 * The worker's schedules keep running either way, so every wait here is on state, never on a
 * tick alone.
 */
import {
  INTERNAL_ROUTES,
  INTERNAL_SECRET_HEADER,
  OpsJobResult,
  type OPS_TICK_JOBS,
} from "@commonair/contracts/internal";
import { sleep } from "../wait.ts";

export type OpsJob = (typeof OPS_TICK_JOBS)[number];

export class OpsHooksOff extends Error {
  constructor() {
    super(
      `${INTERNAL_ROUTES.opsTick} answered 404: the ops test hooks are off (start the stack with harness/compose.e6.yaml, OPS_TEST_HOOKS=true for api and worker)`,
    );
    this.name = "OpsHooksOff";
  }
}

/** True when a job answered that its run lock was busy (nothing ran; tick again). */
export function isSkipped(result: OpsJobResult): boolean {
  return (result.skipped ?? 0) > 0;
}

export interface OpsTickRecord {
  job: OpsJob;
  result: OpsJobResult | null;
  ms: number;
  error?: string;
}

export class OpsHooks {
  /** Every tick made: job, counts and how long the API took (report data; counts only). */
  readonly ticks: OpsTickRecord[] = [];

  constructor(
    private readonly apiUrl: string,
    private readonly secret: string,
    private readonly signal?: AbortSignal,
    private readonly requestTimeoutMs = 75_000,
  ) {}

  /** Run `job` once through the hook. */
  async tick(job: OpsJob): Promise<OpsJobResult> {
    const started = performance.now();
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    try {
      const res = await fetch(new URL(INTERNAL_ROUTES.opsTick, this.apiUrl), {
        method: "POST",
        headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: this.secret },
        body: JSON.stringify({ job }),
        signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout,
      });
      if (res.status === 404) throw new OpsHooksOff();
      if (!res.ok) throw new Error(`${INTERNAL_ROUTES.opsTick} (${job}) answered HTTP ${res.status}`);
      const result = OpsJobResult.parse(await res.json());
      this.ticks.push({ job, result, ms: Math.round(performance.now() - started) });
      return result;
    } catch (err) {
      this.ticks.push({
        job,
        result: null,
        ms: Math.round(performance.now() - started),
        error: err instanceof Error ? err.name : "error",
      });
      throw err;
    }
  }

  /** Tick until the job really ran (not `{ skipped: 1 }`), at most `attempts` times. */
  async tickRan(job: OpsJob, attempts = 10, pauseMs = 1_000): Promise<OpsJobResult> {
    let last: OpsJobResult = {};
    for (let i = 0; i < attempts; i++) {
      last = await this.tick(job);
      if (!isSkipped(last)) return last;
      await sleep(pauseMs, this.signal);
    }
    throw new Error(`${job}: the run lock stayed busy for ${attempts} ticks (last ${JSON.stringify(last)})`);
  }

  /**
   * Tick `job` and read `probe` until it returns a value, within `timeoutMs`. Skipped ticks, slow
   * ticks (504) and ticks that ran before the state changed are repeated: the state decides.
   * Returns the value and every non-skipped result seen (for `held` counts and the like).
   */
  async tickUntil<T>(
    job: OpsJob,
    what: string,
    probe: () => Promise<T | null>,
    opts: { timeoutMs: number; intervalMs?: number },
  ): Promise<{ value: T; results: OpsJobResult[] }> {
    const deadline = Date.now() + opts.timeoutMs;
    const interval = opts.intervalMs ?? 1_500;
    const results: OpsJobResult[] = [];
    let tickError: string | null = null;
    for (;;) {
      try {
        const r = await this.tick(job);
        if (!isSkipped(r)) results.push(r);
        tickError = null;
      } catch (err) {
        if (err instanceof OpsHooksOff) throw err;
        tickError = err instanceof Error ? err.message : String(err);
      }
      const value = await probe();
      if (value !== null) return { value, results };
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out after ${opts.timeoutMs} ms waiting for ${what}${tickError ? ` (last tick: ${tickError})` : ""}`,
        );
      }
      await sleep(interval, this.signal);
    }
  }
}

/** Sum of one counter over several job results (a missing counter counts 0). */
export function sumCounter(results: readonly OpsJobResult[], key: string): number {
  return results.reduce((n, r) => n + (r[key] ?? 0), 0);
}
