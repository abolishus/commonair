// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Publishing ports from test containers without racing parallel suites for them.
 *
 * Rootless podman chooses the host port of `-p 127.0.0.1::<port>` by binding port 0 and letting
 * it go, and rootlessport binds that port again only when the container (or pod) starts. Another
 * suite's container, ffmpeg or Bun server can take it in between, and the start fails with
 * "address already in use" (CI run 41719827574). Podman offers no way to keep the port, so the
 * start is retried with a fresh choice; that failure is the only one retried.
 */

export const PORT_RACE_ATTEMPTS = 5;

/** True when podman output says a published port was taken before podman could bind it. */
export function isPortRace(output: string): boolean {
  return /address already in use/i.test(output);
}

/** The `--name <name>` (or `--name=<name>`) in podman arguments. */
export function podmanName(args: readonly string[]): string | undefined {
  for (const [i, a] of args.entries()) {
    if (a === "--name") return args[i + 1];
    if (a.startsWith("--name=")) return a.slice("--name=".length);
  }
  return undefined;
}

/** True for `podman run` arguments that publish a port (the only runs that can lose the race). */
export function publishesPorts(args: readonly string[]): boolean {
  return args[0] === "run" && args.some((a) => a === "-p" || a === "--publish" || /^(-p|--publish=)./.test(a));
}

/**
 * Runs `once` (podman with `args`, everything after `podman`) until it succeeds, fails for any
 * other reason, or has lost the port race PORT_RACE_ATTEMPTS times. Only a `run` that publishes
 * ports and carries `--name` is retried; anything else runs once. `failure` returns the output of
 * a failed attempt and undefined for a success. Before a retry the container is removed: a failed
 * start can leave it behind under the name (`remove` is replaceable for tests).
 */
export function retryPortRace<T>(
  args: readonly string[],
  once: () => T,
  failure: (r: T) => string | undefined,
  remove: (name: string) => void = removeContainer,
): T {
  const name = publishesPorts(args) ? podmanName(args) : undefined;
  for (let attempt = 1; ; attempt++) {
    const r = once();
    const err = failure(r);
    if (err === undefined || !isPortRace(err) || !name || attempt >= PORT_RACE_ATTEMPTS) return r;
    remove(name);
  }
}

function removeContainer(name: string): void {
  Bun.spawnSync(["podman", "rm", "-f", "-i", name], { stdout: "ignore", stderr: "ignore" });
}
