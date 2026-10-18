// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Log-safe error fields. Driver errors embed what they were working on: Postgres messages
 * quote parameter values and iovalkey attaches the command with its arguments, which here
 * are users' chat messages and moderation reasons. Only the name and code are logged.
 */
export function errorCode(err: unknown): string | null {
  const e = typeof err === "object" && err !== null ? (err as { code?: unknown; cause?: { code?: unknown } }) : null;
  const value = e?.code ?? e?.cause?.code;
  return typeof value === "string" ? value : null;
}

export function errorFields(err: unknown): { errorName: string; errorCode: string | null } {
  return { errorName: err instanceof Error ? err.name : "Error", errorCode: errorCode(err) };
}
