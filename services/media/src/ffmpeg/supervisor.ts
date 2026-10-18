// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Supervises one long-running ffmpeg process: restarts it with exponential backoff when it
 * exits, parses `-progress` output, keeps the last stderr line (redacted) for status reports,
 * and on stop asks ffmpeg to finish cleanly (SIGINT flushes the last segment) before SIGKILL.
 */
import type { Subprocess } from "bun";
import type { Logger } from "@commonair/observability";
import { ProgressParser, type Progress } from "./progress.ts";
import { redact, redactArgs } from "./redact.ts";

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  /** Last non-empty stderr line, secrets redacted. */
  lastError: string | null;
  ranMs: number;
}

export interface BackoffPolicy {
  initialMs: number;
  maxMs: number;
  /** A run at least this long resets the backoff to `initialMs`. */
  stableAfterMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { initialMs: 1_000, maxMs: 60_000, stableAfterMs: 30_000 };

/** Delay before restart number `attempt` (0-based): initial · 2^attempt, capped. */
export function backoffDelay(attempt: number, policy: Pick<BackoffPolicy, "initialMs" | "maxMs">): number {
  const exp = Math.min(attempt, 30);
  return Math.min(policy.maxMs, policy.initialMs * 2 ** exp);
}

export interface SupervisorOptions {
  name: string;
  /** Defaults to `ffmpeg` on PATH. */
  binary?: string;
  /** Called before every spawn, so each run can get fresh arguments (e.g. a new segment run id). */
  args: () => string[] | Promise<string[]>;
  secrets?: readonly string[];
  logger: Logger;
  onSpawn?: () => void;
  onProgress?: (p: Progress) => void;
  /** `restartInMs` is null when the supervisor will not restart (stopped or restart disabled). */
  onExit?: (info: ExitInfo, restartInMs: number | null) => void;
  restart?: boolean;
  backoff?: BackoffPolicy;
  /** How long ffmpeg gets to exit after SIGINT before it is killed. */
  stopGraceMs?: number;
}

const MAX_ERROR_LINE = 500;

export class Supervisor {
  private proc: Subprocess<"ignore", "pipe", "pipe"> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private attempt = 0;
  private exited: Promise<void> = Promise.resolve();
  private _restarts = 0;
  private _lastError: string | null = null;

  constructor(private readonly opts: SupervisorOptions) {}

  get running(): boolean {
    return this.proc !== null;
  }
  get restarts(): number {
    return this._restarts;
  }
  get lastError(): string | null {
    return this._lastError;
  }

  start(): void {
    if (this.stopped || this.proc || this.timer) return;
    void this.spawn();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const proc = this.proc;
    if (!proc) return this.exited;
    proc.kill("SIGINT");
    const grace = this.opts.stopGraceMs ?? 5_000;
    const killer = setTimeout(() => proc.kill("SIGKILL"), grace);
    try {
      await this.exited;
    } finally {
      clearTimeout(killer);
    }
  }

  private async spawn(): Promise<void> {
    this.timer = null;
    if (this.stopped) return;
    const secrets = this.opts.secrets ?? [];
    const log = this.opts.logger;
    let args: string[];
    try {
      args = await this.opts.args();
    } catch (err) {
      this.handleExit({ code: null, signal: null, lastError: redact(String(err), secrets), ranMs: 0 });
      return;
    }
    if (this.stopped) return;
    const started = Date.now();
    let proc: Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn([this.opts.binary ?? "ffmpeg", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (err) {
      this.handleExit({ code: null, signal: null, lastError: redact(String(err), secrets), ranMs: 0 });
      return;
    }
    let resolveExited: () => void = () => {};
    this.exited = new Promise((r) => (resolveExited = r));
    this.proc = proc;
    log.debug("process started", { process: this.opts.name, pid: proc.pid, args: redactArgs(args, secrets) });
    this.opts.onSpawn?.();

    let lastLine: string | null = null;
    const parser = new ProgressParser((p) => this.opts.onProgress?.(p));
    const readStdout = (async () => {
      const dec = new TextDecoder();
      for await (const chunk of proc.stdout) parser.push(dec.decode(chunk, { stream: true }));
    })();
    const readStderr = (async () => {
      const dec = new TextDecoder();
      let rest = "";
      for await (const chunk of proc.stderr) {
        rest += dec.decode(chunk, { stream: true });
        const lines = rest.split(/\r?\n|\r/);
        rest = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;
          lastLine = redact(line, secrets).slice(0, MAX_ERROR_LINE);
          log.debug("ffmpeg", { process: this.opts.name, line: lastLine });
        }
        if (rest.length > 16 * 1024) rest = "";
      }
      if (rest.trim()) lastLine = redact(rest.trim(), secrets).slice(0, MAX_ERROR_LINE);
    })();

    const code = await proc.exited;
    // Drain both pipes so the final progress block and error line are not lost.
    await Promise.allSettled([readStdout, readStderr]);
    this.proc = null;
    this._lastError = lastLine;
    this.handleExit({
      code,
      signal: proc.signalCode === null ? null : String(proc.signalCode),
      lastError: lastLine,
      ranMs: Date.now() - started,
    });
    resolveExited();
  }

  private handleExit(info: ExitInfo): void {
    const restart = !this.stopped && this.opts.restart !== false;
    const policy = this.opts.backoff ?? DEFAULT_BACKOFF;
    if (info.ranMs >= policy.stableAfterMs) this.attempt = 0;
    const delay = restart ? backoffDelay(this.attempt, policy) : null;
    if (info.lastError) this._lastError = info.lastError;
    this.opts.logger[this.stopped ? "debug" : "warn"]("process exited", {
      process: this.opts.name,
      code: info.code,
      signal: info.signal,
      ranMs: info.ranMs,
      lastError: info.lastError,
      restartInMs: delay,
    });
    this.opts.onExit?.(info, delay);
    if (delay === null) return;
    this.attempt++;
    this._restarts++;
    this.timer = setTimeout(() => void this.spawn(), delay);
  }
}
