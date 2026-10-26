// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Killing and restoring replica containers. `podman kill` is an instance dying without a
 * shutdown (no drain, no final flush); `restoreContainer` brings it back and waits until its
 * health endpoint answers, so later scenarios find the stack whole. Modelled on the self-host
 * e2e's `checkRestart` (scripts/selfhost/e2e.ts).
 */
import { podman, podmanOk } from "../drill/podman.ts";
import { waitFor } from "../wait.ts";
import { type ReplicaContainer, parseReplicaContainers } from "./replicas.ts";

export async function listReplicaContainers(prefix: string): Promise<ReplicaContainer[]> {
  const out = await podmanOk(["ps", "-a", "--format", "{{.Names}}\t{{.State}}"], { timeoutMs: 30_000 });
  return parseReplicaContainers(out, prefix);
}

export async function containerRunning(name: string): Promise<boolean> {
  const r = await podman(["inspect", "--format", "{{.State.Running}}", name], { timeoutMs: 30_000 });
  return r.code === 0 && r.stdout.trim() === "true";
}

/** SIGKILL the container; resolves once podman reports it no longer running. Returns when that was. */
export async function killContainer(name: string): Promise<number> {
  await podmanOk(["kill", "--signal", "KILL", name], { timeoutMs: 30_000 });
  const killedAt = Date.now();
  // A restart policy may bring it straight back; "not running at least once" is all we need.
  await waitFor("container stopped", async () => !(await containerRunning(name)) || Date.now() - killedAt > 5_000, {
    timeoutMs: 10_000,
    intervalMs: 100,
  });
  return killedAt;
}

export async function healthy(url: string): Promise<boolean> {
  const res = await fetch(url, { signal: AbortSignal.timeout(3_000) }).catch(() => null);
  return res?.ok === true;
}

/**
 * Start the container if it is not running (the restart policy may already have), then wait for
 * its health endpoint. Returns how long the replica took to come back.
 */
export async function restoreContainer(name: string, healthUrl: string, timeoutMs = 120_000): Promise<number> {
  const started = Date.now();
  // Not podmanOk: the restart policy can win the race, and then the health wait decides.
  if (!(await containerRunning(name))) await podman(["start", name], { timeoutMs: 60_000 });
  await waitFor(`${name} healthy at ${healthUrl}`, () => healthy(healthUrl), { timeoutMs, intervalMs: 500 });
  return Date.now() - started;
}
