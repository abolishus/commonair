// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Runs one verify step with a hard deadline. The child gets its own process group so a
 * timeout (or Ctrl-C on verify) kills the whole tree: vp → bun → vitest workers → podman.
 * Killing only the direct child leaves grandchildren holding the terminal and the gate
 * never exits.
 */
export interface StepResult {
  ok: boolean;
  timedOut: boolean;
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
  log?: (line: string) => void;
}

let current: { pid: number } | undefined;

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Group already gone.
  }
}

/** Kills the running step's process group; for verify's own SIGINT/SIGTERM handler. */
export function killCurrentStep(): void {
  if (current) killGroup(current.pid, "SIGKILL");
}

export async function runStep(cmd: string[], opts: RunStepOptions): Promise<StepResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const grace = opts.killGraceMs ?? 10_000;
  const started = performance.now();
  const io = opts.stdio ?? "inherit";
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: process.env,
    // A background process group that reads the terminal gets SIGTTIN and stops; no step needs stdin.
    stdio: ["ignore", io, io],
    detached: true,
  });
  current = { pid: proc.pid };
  let timedOut = false;
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
    return { ok: exitCode === 0 && !timedOut, timedOut, exitCode, ms: performance.now() - started };
  } finally {
    clearTimeout(deadline);
    if (hardKill) clearTimeout(hardKill);
    if (heartbeat) clearInterval(heartbeat);
    current = undefined;
  }
}
