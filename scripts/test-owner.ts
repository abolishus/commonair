// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Ties the containers, volumes, images and compose projects that integration tests create to the
 * process that created them, so `infra.ts test` can remove them as soon as that process is gone
 * (a killed or crashed run skips its own cleanup) instead of waiting out an age cutoff.
 */

export const TEST_OWNER_LABEL = "io.commonair.test-owner";

/** `podman run` / `volume create` / `build` arguments that mark the resource as this process's. */
export function testOwnerArgs(pid = process.pid): string[] {
  return ["--label", `${TEST_OWNER_LABEL}=${pid}`];
}

/**
 * A compose project name carrying this process's pid (`<prefix>-<pid>-<8 hex>`). Compose labels
 * every container, volume and network with the project, which is how the sweep finds the owner.
 */
export function ownedProjectName(prefix: string, pid = process.pid): string {
  return `${prefix}-${pid}-${crypto.randomUUID().slice(0, 8)}`;
}

const OWNED_PROJECT = /^commonair-it-(\d+)-[0-9a-f]{8}$/;

/** The pid that owns a resource with these labels, if it is a test resource at all. */
export function testOwnerPid(labels: Readonly<Record<string, string>> | null | undefined): number | undefined {
  const raw = labels?.[TEST_OWNER_LABEL] ?? labels?.["com.docker.compose.project"]?.match(OWNED_PROJECT)?.[1];
  const pid = Number(raw);
  return raw && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to another user, so it is alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
