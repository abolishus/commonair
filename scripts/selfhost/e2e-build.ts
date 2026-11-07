// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the self-host e2e does after one of its `podman build`s fails (e2e.ts `build()`).
 *
 * Two failures are not the build's: Podman 4.9's lost build-cache entry (e2e.ts
 * `isTransientBuildError`, retried once without the cache), and a registry's gateway error while
 * a build pulls its pinned base. CI run 41736761538 (attempt 1, Debian external bundled) died on
 * the second: `podman build -f infra/containers/probe.Containerfile` got "reading manifest
 * sha256:3076b8dc… in docker.io/grafana/tempo: received unexpected HTTP status: 502 Bad Gateway"
 * on its first and only pull, 0.4 s after the build started; attempt 2 passed unchanged.
 *
 * Podman retries a failed pull itself (`--retry`, 3 by default) but only on errors its
 * containers/common `retry.IsErrorRetryable` names. Up to v0.62 (Podman 4.9, CI's runner) that
 * list has no HTTP status, so a 502 ends the build at once; v0.63 (Podman 5.5) added 502, 503
 * and 504 ("they appear to be quite common in the field", containers/common#2299). This applies
 * that same rule and schedule (3 retries, 1 s, 2 s, 4 s) to the runner's older Podman. The e2e
 * checks a self-host install, not a registry's uptime. Any other status (401, 404, 429, 500), a
 * download inside a RUN step (its own tool's message, not this one) and every other error still
 * fail the build.
 */

/** Podman ≥5.5's delays for a gateway error, before each retry (containers/common IfNecessary). */
export const GATEWAY_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];

/** containers/image's message for a registry's 502, 503 or 504 (docker.UnexpectedHTTPStatusError). */
export function isRegistryGatewayError(message: string): boolean {
  return /received unexpected HTTP status: 50[234]\b/.test(message);
}

export interface BuildRecovery {
  /** Runs `podman <argv>`, throwing on a non-zero exit. */
  run: (argv: string[]) => void;
  sleep: (ms: number) => void;
  log: (line: string) => void;
  /** Podman 4.9's lost build-cache entry (e2e.ts). */
  isLostCacheEntry: (message: string) => boolean;
  /** The arguments of a build without the cache (e2e.ts `buildRetryArgs`). */
  withoutCache: (args: readonly string[]) => string[];
}

/**
 * Called with the error of `podman build <args>`: rebuilds while the failure is one of the two
 * above (a lost cache entry once; a gateway error up to three times, after the delays), and
 * rethrows the first failure that is neither or has used up its retries. Returns once a rebuild
 * passes. Once the cache was dropped, later rebuilds keep it dropped.
 */
export function recoverBuild(failure: unknown, args: readonly string[], deps: BuildRecovery): void {
  let error = failure;
  let cacheDropped = false;
  let gatewayRetries = 0;
  for (;;) {
    const message = error instanceof Error ? error.message : String(error);
    if (!cacheDropped && deps.isLostCacheEntry(message)) {
      cacheDropped = true;
      deps.log("podman build hit a lost build-cache entry; retrying once without the cache");
    } else if (gatewayRetries < GATEWAY_RETRY_DELAYS_MS.length && isRegistryGatewayError(message)) {
      const delay = GATEWAY_RETRY_DELAYS_MS[gatewayRetries] ?? 0;
      gatewayRetries++;
      deps.log(
        `podman build got a registry gateway error pulling a base; retry ${gatewayRetries}/` +
          `${GATEWAY_RETRY_DELAYS_MS.length} in ${delay} ms`,
      );
      deps.sleep(delay);
    } else throw error;
    try {
      deps.run(cacheDropped ? deps.withoutCache(args) : ["build", ...args]);
      return;
    } catch (e) {
      error = e;
    }
  }
}
