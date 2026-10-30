// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The replay cursor: the last item's `(coalesce(media_ts, created_at), id)`, opaque base64url
 * JSON. The time is Postgres's own microsecond text, so rows that differ below a millisecond
 * (a database-defaulted `created_at`) are neither skipped nor repeated.
 */
import { decodeCursor, encodeCursor } from "../lib/cursor.ts";

export interface ReplayCursor {
  /** ISO 8601 UTC with microseconds, as `replayAtText` renders it. */
  t: string;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MICRO_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

const isReplayCursor = (v: Record<string, unknown>): v is { t: string; id: string } =>
  typeof v.t === "string" && MICRO_ISO.test(v.t) && typeof v.id === "string" && UUID.test(v.id);

export const encodeReplayCursor = (c: ReplayCursor): string => encodeCursor({ t: c.t, id: c.id });

/** Null for no cursor; a malformed one is a BAD_REQUEST. */
export const decodeReplayCursor = (raw: string | undefined): ReplayCursor | null => decodeCursor(raw, isReplayCursor);
