// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Go-live inbox rows name the channel by its current display name and avatar (overhaul wave 4,
 * D7.3; `GoLiveNotificationPayload`). Joined when the inbox reads, never stored in the row: a
 * rename or a new avatar shows on old rows too, and nothing user-written is copied into them.
 */
import { eq, inArray } from "drizzle-orm";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { channelAvatar } from "../lib/dto.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `rows` with `displayName` and `avatarUrl` added to each go-live payload whose channel still exists. */
export async function withChannelFaces<T extends { type: string; payload: Record<string, unknown> }>(
  deps: Deps,
  rows: readonly T[],
): Promise<T[]> {
  const ids = [
    ...new Set(
      rows
        .filter((r) => r.type === "go_live")
        .map((r) => r.payload.channelId)
        .filter((id): id is string => typeof id === "string" && UUID.test(id))
        .map((id) => id.toLowerCase()),
    ),
  ];
  if (ids.length === 0) return [...rows];
  const found = await deps.db
    .select({ c: schema.channels, ownerImage: schema.users.image })
    .from(schema.channels)
    .innerJoin(schema.users, eq(schema.users.id, schema.channels.ownerId))
    .where(inArray(schema.channels.id, ids));
  const faces = new Map(
    found.map(({ c, ownerImage }) => [
      c.id,
      { displayName: c.displayName, avatarUrl: channelAvatar(deps, c, ownerImage) },
    ]),
  );
  return rows.map((r) => {
    const id = r.payload.channelId;
    const face = r.type === "go_live" && typeof id === "string" ? faces.get(id.toLowerCase()) : undefined;
    return face === undefined ? r : { ...r, payload: { ...r.payload, ...face } };
  });
}
