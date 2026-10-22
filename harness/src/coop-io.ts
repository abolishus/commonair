// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The co-op test hook (docs/testing/e5-selectors.md, "Stack and test hooks"):
 * `POST /internal/coop/tick` behind `INTERNAL_API_SECRET`, served only while the stack runs with
 * `COOP_TEST_HOOKS=true` (harness/compose.e5-coop.yaml). The API enqueues the job, waits for it
 * (30 s) and returns its counts; a job whose run lock was busy answers `{ skipped: 1 }` and is
 * ticked again. The worker's own schedules keep running either way, so every wait here is on
 * state, never on a tick alone.
 */
import {
  type CoopJobName,
  CoopJobResult,
  INTERNAL_ROUTES,
  INTERNAL_SECRET_HEADER,
} from "@commonair/contracts/internal";
import { sleep } from "./wait.ts";

export class CoopHooksOff extends Error {
  constructor() {
    super(
      `${INTERNAL_ROUTES.coopTick} answered 404: the co-op test hooks are off (start the stack with harness/compose.e5-coop.yaml, COOP_TEST_HOOKS=true for api and worker)`,
    );
    this.name = "CoopHooksOff";
  }
}

/** True when a job answered that its run lock was busy (nothing ran; tick again). */
export function isSkipped(result: CoopJobResult): boolean {
  return (result.skipped ?? 0) > 0;
}

export class CoopHooks {
  /** Every tick the scenario made: job, counts and how long the API took (report data). */
  readonly ticks: { job: CoopJobName; result: CoopJobResult | null; ms: number; error?: string }[] = [];

  constructor(
    private readonly apiUrl: string,
    private readonly secret: string,
    private readonly signal?: AbortSignal,
  ) {}

  /** Run `job` once through the hook. */
  async tick(job: CoopJobName): Promise<CoopJobResult> {
    const started = performance.now();
    const timeout = AbortSignal.timeout(45_000);
    try {
      const res = await fetch(new URL(INTERNAL_ROUTES.coopTick, this.apiUrl), {
        method: "POST",
        headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: this.secret },
        body: JSON.stringify({ job }),
        signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout,
      });
      if (res.status === 404) throw new CoopHooksOff();
      if (!res.ok) throw new Error(`${INTERNAL_ROUTES.coopTick} (${job}) answered HTTP ${res.status}`);
      const result = CoopJobResult.parse(await res.json());
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
  async tickRan(job: CoopJobName, attempts = 10, pauseMs = 1_000): Promise<CoopJobResult> {
    let last: CoopJobResult = {};
    for (let i = 0; i < attempts; i++) {
      last = await this.tick(job);
      if (!isSkipped(last)) return last;
      await sleep(pauseMs, this.signal);
    }
    throw new Error(`${job}: the run lock stayed busy for ${attempts} ticks (last ${JSON.stringify(last)})`);
  }

  /**
   * Tick `job` and read `probe` until it returns a value, within `timeoutMs`. Ticks that were
   * skipped or ran without the state changing yet are simply repeated: the state decides.
   */
  async tickUntil<T>(
    job: CoopJobName,
    what: string,
    probe: () => Promise<T | null>,
    opts: { timeoutMs: number; intervalMs?: number },
  ): Promise<T> {
    const deadline = Date.now() + opts.timeoutMs;
    const interval = opts.intervalMs ?? 1_500;
    let tickError: string | null = null;
    for (;;) {
      const before = await probe();
      if (before !== null) return before;
      try {
        await this.tick(job);
        tickError = null;
      } catch (err) {
        if (err instanceof CoopHooksOff) throw err;
        // A slow tick (504) does not stop the wait: the schedules run too, the state decides.
        tickError = err instanceof Error ? err.message : String(err);
      }
      const after = await probe();
      if (after !== null) return after;
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out after ${opts.timeoutMs} ms waiting for ${what}${tickError ? ` (last tick: ${tickError})` : ""}`,
        );
      }
      await sleep(interval, this.signal);
    }
  }
}
