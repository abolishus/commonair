// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The song-request queue (ADR 0026 decision 6): links only. URLs are returned as stored and never
 * fetched. Only a queued request moves, to played or skipped.
 */
import { and, asc, eq } from "drizzle-orm";
import type { SONG_REQUEST_STATUSES } from "@commonair/contracts/enums";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { conflict, notFound } from "../lib/errors.ts";
import { toSongRequest, type SongRequest } from "./dto.ts";

const { songRequests, users } = schema;

export const SONG_REQUEST_LIST_LIMIT = 200;

export async function listSongRequests(
  deps: Deps,
  channelId: string,
  status: (typeof SONG_REQUEST_STATUSES)[number] = "queued",
): Promise<SongRequest[]> {
  const rows = await deps.db
    .select({ request: songRequests, requester: users.username })
    .from(songRequests)
    .innerJoin(users, eq(users.id, songRequests.requesterId))
    .where(and(eq(songRequests.channelId, channelId), eq(songRequests.status, status)))
    .orderBy(asc(songRequests.createdAt), asc(songRequests.id))
    .limit(SONG_REQUEST_LIST_LIMIT);
  return rows.map((r) => toSongRequest(r.request, r.requester));
}

export async function setSongRequestStatus(
  deps: Deps,
  channel: { id: string },
  actorId: string,
  input: { id: string; status: "played" | "skipped" },
): Promise<SongRequest> {
  return deps.db.transaction(async (tx) => {
    const [moved] = await tx
      .update(songRequests)
      .set({ status: input.status })
      .where(
        and(eq(songRequests.id, input.id), eq(songRequests.channelId, channel.id), eq(songRequests.status, "queued")),
      )
      .returning();
    if (!moved) {
      const [exists] = await tx
        .select({ id: songRequests.id })
        .from(songRequests)
        .where(and(eq(songRequests.id, input.id), eq(songRequests.channelId, channel.id)));
      throw exists
        ? conflict("Only a queued request can be marked played or skipped")
        : notFound("Song request not found");
    }
    const [requester] = await tx
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, moved.requesterId));
    if (!requester) throw new Error("song request requester missing");
    await audit(tx, {
      actorType: "user",
      actorId,
      action: "bot.song_request.status",
      subjectType: "song_request",
      subjectId: moved.id,
      channelId: channel.id,
      details: { status: input.status },
    });
    return toSongRequest(moved, requester.username);
  });
}
