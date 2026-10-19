// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Child-process supervision. Every process the harness spawns (ffmpeg streamers, helper tools)
 * is tracked here so a crash, Ctrl-C or a failed assertion never leaves orphans publishing to
 * the stack: leftovers are killed on process exit, and `stopAll()` stops everything gracefully.
 */
import type { Subprocess } from "bun";

export interface SupervisedOptions {
  name: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Called with each complete stdout line. */
  onStdoutLine?: (line: string) => void;
  /** Called with each complete stderr line. */
  onStderrLine?: (line: string) => void;
  /** Lines of stderr kept for error reports. */
  stderrTail?: number;
  /** Signal `stop()` sends first (default SIGINT, which lets ffmpeg flush). */
  stopSignal?: "SIGINT" | "SIGTERM";
}

export interface Supervised {
  name: string;
  pid: number;
  /** Resolves with the exit code once the process has exited. */
  exited: Promise<number>;
  readonly running: boolean;
  /** Last stderr lines (most recent last). */
  stderr(): string[];
  /** `stopSignal` (SIGINT by default: lets ffmpeg flush and close the connection), then SIGKILL after `graceMs`. */
  stop(graceMs?: number): Promise<number>;
}

const live = new Set<Supervised>();
let hooksInstalled = false;

function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on("exit", () => {
    for (const p of live) {
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });
}

/**
 * For entry points without their own signal handling: stop children, then exit on SIGINT/SIGTERM.
 * The CLI handles signals itself (abort the run, write the report), so it does not call this.
 */
export function exitOnSignals(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void stopAll(1_000).finally(() => process.exit(130));
    });
  }
}

async function pumpLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl = buffer.search(/\r?\n|\r/);
    while (nl >= 0) {
      const line = buffer.slice(0, nl);
      const sepLength = buffer.startsWith("\r\n", nl) ? 2 : 1;
      buffer = buffer.slice(nl + sepLength);
      if (line.length > 0) onLine(line);
      nl = buffer.search(/\r?\n|\r/);
    }
  }
  if (buffer.length > 0) onLine(buffer);
}

export function spawnSupervised(cmd: string[], opts: SupervisedOptions): Supervised {
  installHooks();
  const tailSize = opts.stderrTail ?? 40;
  const tail: string[] = [];
  const proc: Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let running = true;
  void pumpLines(proc.stdout, (line) => opts.onStdoutLine?.(line)).catch(() => undefined);
  void pumpLines(proc.stderr, (line) => {
    tail.push(line);
    if (tail.length > tailSize) tail.shift();
    opts.onStderrLine?.(line);
  }).catch(() => undefined);

  const handle: Supervised = {
    name: opts.name,
    pid: proc.pid,
    exited: proc.exited.then((code) => {
      running = false;
      live.delete(handle);
      return code;
    }),
    get running() {
      return running;
    },
    stderr: () => [...tail],
    async stop(graceMs = 3_000) {
      if (!running) return handle.exited;
      proc.kill(opts.stopSignal ?? "SIGINT");
      const timer = setTimeout(() => {
        if (running) proc.kill("SIGKILL");
      }, graceMs);
      try {
        return await handle.exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
  live.add(handle);
  return handle;
}

/** Stop every supervised process (used on shutdown and by the scenario runner between scenarios). */
export async function stopAll(graceMs = 3_000): Promise<void> {
  await Promise.all([...live].map((p) => p.stop(graceMs).catch(() => undefined)));
}

export function liveProcessCount(): number {
  return live.size;
}
