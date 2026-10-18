// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Opaque pagination cursors: base64url JSON. Malformed cursors are a client error. */
import { badRequest } from "./errors.ts";

export const encodeCursor = (v: Record<string, string | number>) =>
  Buffer.from(JSON.stringify(v)).toString("base64url");

export function decodeCursor<T extends Record<string, string | number>>(
  raw: string | undefined,
  check: (v: Record<string, unknown>) => v is T,
): T | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (v && typeof v === "object" && check(v as Record<string, unknown>)) return v as T;
  } catch {
    // fall through
  }
  throw badRequest("Invalid cursor");
}

export const isOffsetCursor = (v: Record<string, unknown>): v is { o: number } =>
  typeof v.o === "number" && Number.isInteger(v.o) && v.o >= 0 && v.o <= 1_000_000;

/** Keyset cursor on (timestamp, id) for newest-first lists. */
export const isKeyCursor = (v: Record<string, unknown>): v is { t: string; id: string } =>
  typeof v.t === "string" && !Number.isNaN(Date.parse(v.t)) && typeof v.id === "string" && /^[0-9a-f-]{36}$/.test(v.id);

/** Slice `limit` from rows fetched with `limit + 1`, returning the cursor for the next page. */
export function pageOf<R, I>(rows: R[], limit: number, map: (r: R) => I, next: (last: R) => string) {
  const more = rows.length > limit;
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items: items.map(map), nextCursor: more && last !== undefined ? next(last) : null };
}
