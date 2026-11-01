// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Timestamps on `createDb`'s raw `sql` client. Drizzle swaps postgres.js's timestamp serializers
 * and parsers for pass-throughs, so a Date parameter reaches the wire as-is (postgres.js throws
 * "Received an instance of Date") and timestamptz columns come back as Postgres text. Raw queries
 * send `${tsParam(d)}::timestamptz` and read columns through `toDate`.
 */
export const tsParam = (d: Date): string => d.toISOString();

export function toDate(v: Date | string): Date;
export function toDate(v: Date | string | null | undefined): Date | null;
export function toDate(v: Date | string | null | undefined): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`not a timestamp: ${String(v)}`);
  return d;
}
