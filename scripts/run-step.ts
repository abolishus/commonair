// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Runs one verify step with a hard deadline. The child gets its own process group so a
 * timeout (or Ctrl-C on verify) kills the whole tree: vp → bun → vitest workers → podman.
 * Killing only the direct child leaves grandchildren holding the terminal and the gate
 * never exits.
 */
import { closeSync, openSync } from "node:fs";

export interface StepResult {
  ok: boolean;
  timedOut: boolean;
  /** Killed through `signal` (another step failed), not by its own doing. */
  cancelled: boolean;
  exitCode: number | null;
  ms: number;
}

export interface RunStepOptions {
  cwd?: string;
  timeoutMs: number;
  /** Prints a "still running" line at this interval so a slow step is not mistaken for a hang. */
  heartbeatMs?: number;
  /** Grace period between SIGTERM and SIGKILL. */
  killGraceMs?: number;
  stdio?: "inherit" | "ignore";
  /** Writes stdout and stderr, interleaved, to this file instead (for steps running side by side). */
  logFile?: string;
  /** Aborting kills the step's process tree. */
  signal?: AbortSignal;
  log?: (line: string) => void;
}

const running = new Set<number>();

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Group already gone.
  }
}

/** Kills every running step's process group; for verify's own SIGINT/SIGTERM handler. */
export function killCurrentStep(): void {
  for (const pid of running) killGroup(pid, "SIGKILL");
}

export async function runStep(cmd: string[], opts: RunStepOptions): Promise<StepResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const grace = opts.killGraceMs ?? 10_000;
  const started = performance.now();
  if (opts.signal?.aborted) return { ok: false, timedOut: false, cancelled: true, exitCode: null, ms: 0 };
  // One descriptor for both streams keeps their order, as a terminal shows it.
  const fd = opts.logFile ? openSync(opts.logFile, "w") : undefined;
  const io = fd ?? opts.stdio ?? "inherit";
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      env: process.env,
      // A background process group that reads the terminal gets SIGTTIN and stops; no step needs stdin.
      stdio: ["ignore", io, io],
      detached: true,
    });
  } catch (e) {
    if (fd !== undefined) closeSync(fd);
    throw e;
  }
  running.add(proc.pid);
  let timedOut = false;
  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
    killGroup(proc.pid, "SIGKILL");
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const heartbeat = opts.heartbeatMs
    ? setInterval(() => {
        log(`  … still running (${Math.round((performance.now() - started) / 1000)}s)`);
      }, opts.heartbeatMs)
    : undefined;
  let hardKill: Timer | undefined;
  const deadline = setTimeout(() => {
    timedOut = true;
    log(`  ✗ timed out after ${Math.round(opts.timeoutMs / 1000)}s; killing the process tree`);
    killGroup(proc.pid, "SIGTERM");
    hardKill = setTimeout(() => killGroup(proc.pid, "SIGKILL"), grace);
  }, opts.timeoutMs);
  try {
    const exitCode = await proc.exited;
    // The leader can exit while children it spawned linger in the group; reap them too.
    killGroup(proc.pid, "SIGKILL");
    return {
      ok: exitCode === 0 && !timedOut && !cancelled,
      timedOut,
      cancelled,
      exitCode,
      ms: performance.now() - started,
    };
  } finally {
    clearTimeout(deadline);
    if (hardKill) clearTimeout(hardKill);
    if (heartbeat) clearInterval(heartbeat);
    opts.signal?.removeEventListener("abort", onAbort);
    if (fd !== undefined) closeSync(fd);
    running.delete(proc.pid);
  }
}
