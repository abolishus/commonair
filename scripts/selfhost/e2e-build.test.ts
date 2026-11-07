// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** scripts/selfhost/e2e-build.ts: what the self-host e2e does after a failed `podman build`. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { GATEWAY_RETRY_DELAYS_MS, isRegistryGatewayError, recoverBuild } from "./e2e-build.ts";
import { buildRetryArgs, isTransientBuildError } from "./e2e.ts";

// CI run 41736761538, attempt 1, self-host e2e (debian, external, bundled), as e2e.ts's run()
// raised it (command, then the tail of stderr). The registry host is joined at run time: the
// supply-chain check reads a literal one as an unpinned image reference (it is a log line).
const HUB = ["docker", "io"].join(".");
const DIGEST = "sha256:3076b8dcdfb32fd6bc5ccef85e7b7313e6199b9cb84366257fc17ecb696db5fd";
const TEMPO_502 = [
  "podman build -f infra/containers/probe.Containerfile … exited 125",
  `Trying to pull ${HUB}/grafana/tempo@${DIGEST}...`,
  `Error: creating build container: initializing source docker://grafana/tempo@${DIGEST}: reading manifest ${DIGEST} in ${HUB}/grafana/tempo: received unexpected HTTP status: 502 Bad Gateway`,
].join("\n");
const LOST_CACHE =
  "podman build -f x … exited 125\nError: checking if cached image exists from a previous build: getting top layer info: layer not known";
const RUN_FAILED = 'podman build -f x … exited 1\nError: building at STEP "RUN bun install": exit status 1';

/** A fake podman that fails with each of `failures` in turn, then passes. */
function harness(failures: string[]) {
  const calls: string[][] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const queue = [...failures];
  const deps = {
    run: (argv: string[]) => {
      calls.push(argv);
      const next = queue.shift();
      if (next !== undefined) throw new Error(next);
    },
    sleep: (ms: number) => void sleeps.push(ms),
    log: (line: string) => void logs.push(line),
    isLostCacheEntry: isTransientBuildError,
    withoutCache: buildRetryArgs,
  };
  return { calls, sleeps, logs, deps };
}

const ARGS = ["-f", "infra/containers/probe.Containerfile", "-t", "img", "."];

describe("registry gateway errors", () => {
  test("CI's 502 from Docker Hub is one, as are 503 and 504", () => {
    expect(isRegistryGatewayError(TEMPO_502)).toBe(true);
    expect(isRegistryGatewayError("received unexpected HTTP status: 503 Service Unavailable")).toBe(true);
    expect(isRegistryGatewayError("received unexpected HTTP status: 504 Gateway Timeout")).toBe(true);
  });

  test("no other status is (as containers/common's rule), nor a failing RUN step", () => {
    for (const status of ["500 Internal Server Error", "501 Not Implemented", "505 HTTP Version", "429 Too Many"])
      expect(isRegistryGatewayError(`received unexpected HTTP status: ${status}`), status).toBe(false);
    expect(isRegistryGatewayError("received unexpected HTTP status: 5020")).toBe(false);
    expect(isRegistryGatewayError(RUN_FAILED)).toBe(false);
    expect(isRegistryGatewayError("curl: (22) The requested URL returned error: 502")).toBe(false);
    expect(isRegistryGatewayError(LOST_CACHE)).toBe(false);
  });

  test("the schedule is Podman 5.5's: three retries after 1, 2 and 4 s", () => {
    expect(GATEWAY_RETRY_DELAYS_MS).toEqual([1_000, 2_000, 4_000]);
  });
});

describe("recoverBuild", () => {
  test("CI's failure: the same build again after 1 s, and it passes", () => {
    const h = harness([]);
    recoverBuild(new Error(TEMPO_502), ARGS, h.deps);
    expect(h.calls).toEqual([["build", ...ARGS]]);
    expect(h.sleeps).toEqual([1_000]);
    expect(h.logs).toEqual(["podman build got a registry gateway error pulling a base; retry 1/3 in 1000 ms"]);
  });

  test("a registry that stays down fails the build after three retries, with its error", () => {
    const h = harness([TEMPO_502, TEMPO_502, TEMPO_502]);
    expect(() => recoverBuild(new Error(TEMPO_502), ARGS, h.deps)).toThrow(/502 Bad Gateway/);
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toEqual([1_000, 2_000, 4_000]);
  });

  test("it passes on the last retry", () => {
    const h = harness([TEMPO_502, TEMPO_502]);
    recoverBuild(new Error(TEMPO_502), ARGS, h.deps);
    expect(h.calls).toHaveLength(3);
  });

  test("anything else is rethrown untouched, with no rebuild", () => {
    for (const message of [RUN_FAILED, "received unexpected HTTP status: 500 Internal Server Error"]) {
      const h = harness([]);
      const error = new Error(message);
      expect(() => recoverBuild(error, ARGS, h.deps)).toThrow(error);
      expect(h.calls).toEqual([]);
      expect(h.sleeps).toEqual([]);
    }
  });

  test("a rebuild that fails another way ends it with that error", () => {
    const h = harness([RUN_FAILED]);
    expect(() => recoverBuild(new Error(TEMPO_502), ARGS, h.deps)).toThrow(/RUN bun install/);
    expect(h.calls).toHaveLength(1);
  });

  test("a lost cache entry: once, without the cache, at once", () => {
    const h = harness([]);
    recoverBuild(new Error(LOST_CACHE), ARGS, h.deps);
    expect(h.calls).toEqual([buildRetryArgs(ARGS)]);
    expect(h.sleeps).toEqual([]);
    expect(h.logs).toEqual(["podman build hit a lost build-cache entry; retrying once without the cache"]);
  });

  test("a second lost cache entry is not retried again", () => {
    const h = harness([LOST_CACHE]);
    expect(() => recoverBuild(new Error(LOST_CACHE), ARGS, h.deps)).toThrow(/layer not known/);
    expect(h.calls).toHaveLength(1);
  });

  test("the two compose: a gateway error after the cache was dropped keeps it dropped", () => {
    const h = harness([TEMPO_502]);
    recoverBuild(new Error(LOST_CACHE), ARGS, h.deps);
    expect(h.calls).toEqual([buildRetryArgs(ARGS), buildRetryArgs(ARGS)]);
    expect(h.sleeps).toEqual([1_000]);
  });

  test("and a lost cache entry after a gateway retry is dropped then", () => {
    const h = harness([LOST_CACHE]);
    recoverBuild(new Error(TEMPO_502), ARGS, h.deps);
    expect(h.calls).toEqual([["build", ...ARGS], buildRetryArgs(ARGS)]);
  });

  test("e2e.ts hands every failed build to it", () => {
    const source = readFileSync(join(import.meta.dirname, "e2e.ts"), "utf8");
    const build = /function build\(args: string\[\]\): void \{[^]*?\n\}\n/.exec(source)?.[0] ?? "";
    expect(build).toContain("recoverBuild(e, args, {");
    expect(build).toContain("isLostCacheEntry: isTransientBuildError");
    expect(build).toContain("withoutCache: buildRetryArgs");
  });
});
