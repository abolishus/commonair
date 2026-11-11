// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * CPU profiles of Bun services on a test target (`load-cost --set profiles=media,worker`). The
 * target's quadlet drop-ins set `COMMONAIR_CPU_PROFILE` and mount a host directory per service
 * (docs/operators/capacity.md, "CPU profiles"); `infra/containers/entrypoint.sh` then starts the
 * service under `bun --cpu-prof`, which writes the profile when the service exits on SIGTERM.
 *
 * So a profile covers one process life: `load-cost` restarts each profiled service before its
 * first cell, stops it after the last (which writes the profile), starts it again, and copies
 * the new files into the report directory. Everything goes over the same SSH runner as the
 * samplers. `systemctl --user` calls use `--no-block` and are polled, so no single SSH call waits
 * on a health check longer than the runner's timeout. Command builders are pure.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { CommandRunner } from "./ssh.ts";
import { shellQuote } from "./ssh.ts";

export class ProfileError extends Error {
  override name = "ProfileError";
}

export const unitOf = (service: string): string => `commonair-${service}.service`;
export const containerOf = (service: string): string => `commonair-${service}`;

/** The container's own value of the switch (empty = profiling is off for it). */
export const profileEnvCommand = (service: string): string =>
  `podman exec ${shellQuote(containerOf(service))} printenv COMMONAIR_CPU_PROFILE`;

/** Marker whose mtime starts this run: only files newer than it are collected. */
export const markerPath = (dir: string, runId: string): string => `${dir}/.load-cost-${runId}`;

export const markCommand = (dir: string, runId: string): string =>
  `mkdir -p ${shellQuote(dir)} && touch ${shellQuote(markerPath(dir, runId))}`;

/** Profiles written since the marker, one path per line (relative to the home directory). */
export const listCommand = (dir: string, runId: string): string =>
  `find ${shellQuote(dir)} -type f -newer ${shellQuote(markerPath(dir, runId))} \\( -name '*.cpuprofile' -o -name '*.md' \\)`;

export const systemctl = (verb: "restart" | "stop" | "start", service: string): string =>
  `systemctl --user ${verb} --no-block ${shellQuote(unitOf(service))}`;

export const isActiveCommand = (service: string): string => `systemctl --user is-active ${shellQuote(unitOf(service))}`;

/** Collected files: where each landed locally. */
export interface CollectedProfile {
  service: string;
  remote: string;
  local: string;
  bytes: number;
}

export interface ProfileDeps {
  run: CommandRunner;
  target: string;
  sleep: (ms: number) => Promise<void>;
  /** Writes one collected file (tests capture it). */
  write?: (path: string, text: string) => void;
  /** Longest wait for a unit to reach a state. */
  timeoutMs?: number;
  pollMs?: number;
}

/** Poll `is-active` until it prints `want` (`active` = started and healthy, with Notify=healthy). */
async function waitFor(d: ProfileDeps, service: string, want: "active" | "inactive"): Promise<void> {
  const deadline = Date.now() + (d.timeoutMs ?? 300_000);
  let last = "";
  while (Date.now() < deadline) {
    const r = await d.run(d.target, isActiveCommand(service));
    last = r.stdout.trim();
    // A stopped unit prints `inactive` (or `failed` once Restart= gave up); either is not running.
    if (want === "active" ? last === "active" : last === "inactive" || last === "failed") return;
    await d.sleep(d.pollMs ?? 2_000);
  }
  throw new ProfileError(`${unitOf(service)} did not become ${want} (last: ${last || "no answer"})`);
}

/**
 * Check every service has the switch on, mark the run's start, and restart the services so each
 * profile starts now. Throws `ProfileError` naming the service whose drop-in is missing.
 */
export async function startProfiles(
  d: ProfileDeps,
  services: readonly string[],
  dir: string,
  runId: string,
): Promise<void> {
  for (const s of services) {
    const r = await d.run(d.target, profileEnvCommand(s));
    if (r.code !== 0 || r.stdout.trim() === "") {
      throw new ProfileError(
        `${containerOf(s)} has no COMMONAIR_CPU_PROFILE: add the profiling drop-in on the target first (capacity.md, "CPU profiles")`,
      );
    }
  }
  const mark = await d.run(d.target, markCommand(dir, runId));
  if (mark.code !== 0) throw new ProfileError(`could not write ${markerPath(dir, runId)} on the target`);
  for (const s of services) {
    await d.run(d.target, systemctl("restart", s));
    await waitFor(d, s, "active");
  }
}

/** Stop each service (it writes its profile on the way out), start it again, copy the profiles. */
export async function collectProfiles(
  d: ProfileDeps,
  services: readonly string[],
  dir: string,
  runId: string,
  localDir: string,
): Promise<CollectedProfile[]> {
  for (const s of services) {
    await d.run(d.target, systemctl("stop", s));
    await waitFor(d, s, "inactive");
    await d.run(d.target, systemctl("start", s));
    await waitFor(d, s, "active");
  }
  const listed = await d.run(d.target, listCommand(dir, runId));
  if (listed.code !== 0) throw new ProfileError("could not list the profiles on the target");
  const write =
    d.write ??
    ((path: string, text: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    });
  const out: CollectedProfile[] = [];
  for (const remote of profilePaths(listed.stdout, dir)) {
    const r = await d.run(d.target, `cat ${shellQuote(remote)}`);
    if (r.code !== 0) throw new ProfileError(`could not read ${remote} on the target`);
    const service = remote.slice(dir.length + 1).split("/")[0] ?? "unknown";
    const local = join(localDir, service, basename(remote));
    write(local, r.stdout);
    out.push({ service, remote, local, bytes: Buffer.byteLength(r.stdout) });
  }
  return out;
}

/** `find`'s output, kept to plain files under `dir/<service>/`. Pure. */
export function profilePaths(text: string, dir: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(`${dir}/`) && /^[A-Za-z0-9._/-]+$/.test(l) && !l.split("/").includes(".."))
    .filter((l) => l.slice(dir.length + 1).split("/").length === 2)
    .sort();
}
