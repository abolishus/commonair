// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Run a short-lived ffmpeg/ffprobe command with a hard timeout and bounded output. */
import { redact } from "./redact.ts";

export class CommandError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

export interface RunOptions {
  timeoutMs: number;
  secrets?: readonly string[];
  /** Larger stdout is an error (protects memory from a misbehaving process). */
  maxStdoutBytes?: number;
}

export interface RunResult {
  stdout: Uint8Array<ArrayBuffer>;
  stderr: string;
}

async function collect(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > max) throw new CommandError("output too large", null, "");
    parts.push(chunk);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

export async function runCommand(binary: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const secrets = opts.secrets ?? [];
  const proc = Bun.spawn([binary, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, opts.timeoutMs);
  try {
    const [stdout, stderrBytes, code] = await Promise.all([
      collect(proc.stdout, opts.maxStdoutBytes ?? 64 * 1024 * 1024).catch((err: unknown) => {
        proc.kill("SIGKILL");
        throw err;
      }),
      collect(proc.stderr, 1024 * 1024).catch(() => new Uint8Array()),
      proc.exited,
    ]);
    const stderr = redact(new TextDecoder().decode(stderrBytes), secrets).slice(-2000);
    if (timedOut) throw new CommandError(`${binary} timed out after ${opts.timeoutMs} ms`, null, stderr);
    if (code !== 0) {
      const last = stderr.trim().split("\n").pop() ?? "";
      throw new CommandError(`${binary} exited with ${code}: ${last}`, code, stderr);
    }
    return { stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
