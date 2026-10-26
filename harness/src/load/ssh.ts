// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * SSH to the target and the generator hosts. Every call is `ssh -o BatchMode=yes <dest> <command>`
 * over one shared control connection per destination (`ControlMaster=auto`), so sampling every
 * 5 s does not open a new TCP and key exchange each time. The runner is injected everywhere, so
 * unit tests never open a real connection.
 */
import { type ContainerCpuSample, parsePodmanStats } from "../metrics.ts";
import { SNAPSHOT_COMMAND, type SnapshotReader } from "./host.ts";

export interface CommandResult {
  code: number;
  stdout: string;
}

/** Runs one remote command on `dest`. Throws only for a failure to start; exit codes are returned. */
export type CommandRunner = (dest: string, command: string) => Promise<CommandResult>;

/** Shell-quote one argument for a POSIX shell (single quotes, `'` as `'\''`). Pure. */
export function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * The ssh options every call uses. `ControlPath` lives under /tmp with `%C` (a hash of host, port
 * and user) to stay under the 104-byte socket path limit on macOS.
 */
export function sshOptions(): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ControlMaster=auto",
    "-o",
    "ControlPath=/tmp/commonair-load-%C",
    "-o",
    "ControlPersist=120",
  ];
}

/** argv for running `command` on `dest`. Pure. */
export function sshArgv(dest: string, command: string): string[] {
  return ["ssh", ...sshOptions(), dest, command];
}

/** The real runner: `ssh` with a timeout. */
export function sshRunner(timeoutMs = 20_000): CommandRunner {
  return async (dest, command) => {
    const proc = Bun.spawn(sshArgv(dest, command), { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    try {
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return { code, stdout };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** `podman stats` on the target as the user that owns the rootless containers. */
export const REMOTE_PODMAN_STATS = "podman stats --no-stream --format json";

/**
 * A `CpuSampler` sample function for a remote host: `podman stats` over SSH, parsed by
 * `parsePodmanStats`, filtered by the container prefix. Null on any failure (the sampler then
 * reports itself unavailable), never a throw.
 */
export function remotePodmanStats(
  run: CommandRunner,
  dest: string,
): (prefix: string) => Promise<ContainerCpuSample[] | null> {
  return async (prefix) => {
    try {
      const r = await run(dest, REMOTE_PODMAN_STATS);
      if (r.code !== 0) return null;
      return parsePodmanStats(r.stdout).filter((s) => s.name.startsWith(prefix));
    } catch {
      return null;
    }
  };
}

/** A `HostSampler` reader for a remote host: the `/proc` snapshot over SSH. Null on failure. */
export function remoteSnapshot(run: CommandRunner, dest: string): SnapshotReader {
  return async () => {
    try {
      const r = await run(dest, `sh -c ${shellQuote(SNAPSHOT_COMMAND)}`);
      return r.code === 0 ? r.stdout : null;
    } catch {
      return null;
    }
  };
}
