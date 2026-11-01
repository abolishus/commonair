// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Test helpers for the decision (z) events: the payloads written for one VOD, clip or channel. */
import { and, asc, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@commonair/db";

const KEY = {
  "media.vod.state": "vod_id",
  "media.clip.state": "clip_id",
  "channel.suspension": "channel_id",
} as const;

export type StateEventType = keyof typeof KEY;

/** Every `type` payload about `id`, oldest first. */
export async function stateEvents(db: Database, type: StateEventType, id: string): Promise<Record<string, unknown>[]> {
  const rows = await db
    .select({ payload: schema.events.payload })
    .from(schema.events)
    .where(and(eq(schema.events.type, type), sql`${schema.events.payload}->>${KEY[type]} = ${id}`))
    .orderBy(asc(schema.events.occurredAt), asc(schema.events.id));
  return rows.map((r) => r.payload as Record<string, unknown>);
}

/** `[public, reason]` of each media-state event about `id`, oldest first. */
export async function mediaStates(db: Database, type: "media.vod.state" | "media.clip.state", id: string) {
  return (await stateEvents(db, type, id)).map((p) => [p.public, p.reason]);
}

/** `suspended` of each `channel.suspension` event about `channelId`, oldest first. */
export async function suspensions(db: Database, channelId: string): Promise<unknown[]> {
  return (await stateEvents(db, "channel.suspension", channelId)).map((p) => p.suspended);
}
