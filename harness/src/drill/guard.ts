// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Makes the drill's cleanup authoritative. On a timeout or Ctrl-C the runner aborts the scenario
 * signal and runs the deferred cleanup while `runDrill` may still be mid-step. Every podman call
 * that creates or changes something goes through `run`: it is refused once the signal is aborted
 * or cleanup has started, and cleanup first waits for the calls already in flight (killed through
 * the same signal) so nothing they created appears after the removal.
 */
export class DrillGuard {
  private cleaned = false;
  private readonly inFlight = new Set<Promise<unknown>>();
  private cleanup: Promise<void> | undefined;

  constructor(
    readonly signal: AbortSignal,
    private readonly remove: () => Promise<void>,
  ) {}

  /** Throws if the drill may no longer create anything. */
  assertLive(what: string): void {
    if (this.cleaned) throw new Error(`drill already cleaned up; refusing to ${what}`);
    if (this.signal.aborted) {
      throw this.signal.reason instanceof Error ? this.signal.reason : new Error(`drill aborted before ${what}`);
    }
  }

  /** Run a podman operation that creates or changes drill resources; `fn` gets the abort signal. */
  async run<T>(what: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertLive(what);
    const p = fn(this.signal);
    this.inFlight.add(p);
    try {
      return await p;
    } finally {
      this.inFlight.delete(p);
    }
  }

  /** Idempotent: the first call refuses further work, drains in-flight calls, then removes. */
  cleanUp(): Promise<void> {
    if (!this.cleanup) {
      this.cleaned = true;
      this.cleanup = (async () => {
        await Promise.allSettled(this.inFlight);
        await this.remove();
      })();
    }
    return this.cleanup;
  }

  get cleanedUp(): boolean {
    return this.cleaned;
  }
}
