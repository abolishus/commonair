// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Replay places lines at microsecond instants (`ChatReplayPage.items[].at` is Postgres's
 * microsecond text), and two lines in the same millisecond must still compare in order. Instants
 * are kept as integer microseconds since the epoch: about 1.8e15 today, well inside
 * `Number.MAX_SAFE_INTEGER` (9e15), so plain numbers compare exactly.
 */

const ISO = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/;

/** An ISO 8601 instant as epoch microseconds (fraction digits past the sixth are dropped); NaN when it does not parse. */
export function isoToMicros(iso: string): number {
  const m = ISO.exec(iso);
  if (!m) return Number.NaN;
  const base = Date.parse(`${m[1] ?? ""}${m[3] ?? ""}`);
  if (!Number.isFinite(base)) return Number.NaN;
  const frac = Number((m[2] ?? "").slice(0, 6).padEnd(6, "0"));
  return base * 1000 + frac;
}

/** A `Date` (millisecond precision) as epoch microseconds. */
export const dateToMicros = (d: Date): number => d.getTime() * 1000;

/** Epoch microseconds as a `Date` (rounded down to the millisecond). */
export const microsToDate = (us: number): Date => new Date(Math.floor(us / 1000));

export const MICROS_PER_SECOND = 1_000_000;
