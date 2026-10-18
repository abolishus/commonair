// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Structured JSON logger (one object per line on stdout, shipped to Loki).
 * Never log PII: fields named like secrets or personal data are redacted.
 */
import { trace } from "@opentelemetry/api";

export const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type Level = (typeof LEVELS)[number];
export type Fields = Record<string, unknown>;

const REDACT = /pass(word)?|secret|token|authorization|cookie|email|^ip$|ipaddress|stream_?key|api_?key/i;

export interface Logger {
  trace(msg: string, fields?: Fields): void;
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  fatal(msg: string, fields?: Fields): void;
  child(fields: Fields): Logger;
}

export interface LoggerOptions {
  service: string;
  level?: Level;
  /** Where lines go; defaults to stdout. Tests inject a collector. */
  write?: (line: string) => void;
  base?: Fields;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== "object") return value;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      REDACT.test(k) ? "[redacted]" : redact(v, depth + 1),
    ]),
  );
}

export function createLogger(opts: LoggerOptions): Logger {
  const min = LEVELS.indexOf(opts.level ?? (process.env.LOG_LEVEL as Level | undefined) ?? "info");
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const base = { service: opts.service, ...opts.base };

  const log = (level: Level, msg: string, fields?: Fields) => {
    if (LEVELS.indexOf(level) < min) return;
    const span = trace.getActiveSpan()?.spanContext();
    const entry = {
      time: new Date().toISOString(),
      level,
      msg,
      ...(redact(base) as Fields),
      ...(fields ? (redact(fields) as Fields) : {}),
      ...(span ? { trace_id: span.traceId, span_id: span.spanId } : {}),
    };
    write(JSON.stringify(entry));
  };

  return {
    trace: (m, f) => log("trace", m, f),
    debug: (m, f) => log("debug", m, f),
    info: (m, f) => log("info", m, f),
    warn: (m, f) => log("warn", m, f),
    error: (m, f) => log("error", m, f),
    fatal: (m, f) => log("fatal", m, f),
    child: (fields) => createLogger({ ...opts, base: { ...opts.base, ...fields } }),
  };
}
