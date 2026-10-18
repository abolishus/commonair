// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ffmpeg command lines carry secrets inside URLs (simulcast stream keys, the internal RTSP
 * password). Everything that leaves this process (logs, `lastError` columns, Valkey status)
 * goes through `redact` first.
 */
export const REDACTED = "[redacted]";

function variants(secret: string): string[] {
  const out = new Set([secret, encodeURIComponent(secret)]);
  return [...out].filter((s) => s.length > 0);
}

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  // Longest first so a secret that contains another is fully replaced.
  const all = secrets.flatMap(variants).sort((a, b) => b.length - a.length);
  for (const s of all) out = out.split(s).join(REDACTED);
  // URL userinfo passwords are never meant to be logged, even if not listed as secrets.
  return out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:/@\s]*:)[^@\s]+@/gi, `$1${REDACTED}@`);
}

export function redactArgs(args: readonly string[], secrets: readonly string[]): string[] {
  return args.map((a) => redact(a, secrets));
}
