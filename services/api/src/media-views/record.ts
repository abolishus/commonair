// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Play counts for videos and clips (overhaul wave 3, D5.5): at most one per viewer per item per
 * UTC day. The viewer is the signed-in user, else the client address (its rate-limit subject, so
 * an IPv6 /64 counts once). Either way only an HMAC of it, with the UTC day in the input, is kept,
 * and only in Valkey under a key that expires at the end of that day: yesterday's keys cannot be
 * linked to today's, and neither the address nor its hash reaches Postgres or a log line.
 * Postgres keeps the totals only (`vods.views`, `clips.views`).
 *
 * The counter has no consumer outside this database, so it writes no `events` row, and it is a
 * plain `views + 1` so `updated_at` (which other flows read as "the owner changed this") is left alone.
 */
import { sql } from "drizzle-orm";
import { schema } from "@commonair/db";
import { hmacHex } from "@commonair/tokens";
import type { Deps } from "../deps.ts";
import { utcDay } from "../growth/ingest.ts";
import { rateLimitSubjectIp } from "../lib/netrange.ts";

export type MediaKind = "vod" | "clip";
export type Viewer = { userId: string } | { ip: string };

const KEY_PREFIX = "media-views:";
const DAY_MS = 86_400_000;

/** Milliseconds from `at` to the next UTC midnight (at least one, so the key always expires). */
export function msToUtcMidnight(at: Date): number {
  const next = Math.floor(at.getTime() / DAY_MS) * DAY_MS + DAY_MS;
  return Math.max(1, next - at.getTime());
}

/** The viewer as hashed for one day: the day is part of the HMAC input. */
export async function viewerHash(secret: string, viewer: Viewer, day: string): Promise<string> {
  const subject = "userId" in viewer ? `u:${viewer.userId}` : `a:${rateLimitSubjectIp(viewer.ip)}`;
  return hmacHex(secret, `media-views:${day}:${subject}`);
}

/** The Valkey key that marks this viewer's play of this item today. */
export async function viewKey(secret: string, kind: MediaKind, id: string, viewer: Viewer, day: string) {
  return `${KEY_PREFIX}${kind}:${id}:${day}:${await viewerHash(secret, viewer, day)}`;
}

/**
 * Count one play of an item the caller may watch (the route checks that). True when it was
 * counted, false when this viewer already counted it today.
 */
export async function recordMediaView(
  deps: Pick<Deps, "db" | "valkey" | "now" | "env">,
  kind: MediaKind,
  id: string,
  viewer: Viewer,
): Promise<boolean> {
  const at = deps.now();
  const day = utcDay(at);
  const key = await viewKey(deps.env.AUTH_SECRET, kind, id, viewer, day);
  const first = await deps.valkey.set(key, "1", "PX", msToUtcMidnight(at), "NX");
  if (first !== "OK") return false;
  try {
    const table = kind === "vod" ? schema.vods : schema.clips;
    await deps.db.execute(sql`update ${table} set views = views + 1 where ${table.id} = ${id}`);
  } catch (err) {
    // Not counted, so a later play may count it.
    await deps.valkey.del(key).catch(() => {});
    throw err;
  }
  return true;
}
