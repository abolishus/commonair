// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `watch_room` report subject's evidence (ADR 0017 decision 2, decision (q)). `subjectInfo` in
 * `routes/safety.ts` calls this inside the report transaction; the report row's `channel_id` is
 * null (room reports go to the platform queue only) and it has no single suspension target.
 *
 * The room's messages (author ids, body, time) and its member list (ids, joined and left times)
 * are copied into `reports.evidence`, so the report keeps the conversation after the room's data
 * expires 30 days after it ends. People appear by id only: the mod queue resolves usernames through
 * the existing user lookup, and account deletion can pseudonymize without rewriting the report.
 */
import { asc, desc, eq } from "drizzle-orm";
import { ROOM_LIMITS } from "@commonair/contracts/enums";
import { schema, type Executor } from "@commonair/db";

const { watchRooms: wr, watchRoomMembers: wm, watchRoomMessages: msgs } = schema;

/**
 * The most messages a report copies (the newest ones). A room lives for one broadcast with at most
 * 8 members and a per-member rate limit, so this bound is only reached by a very long room.
 */
export const EVIDENCE_MAX_MESSAGES = 2000;

export interface WatchRoomEvidenceMessage {
  id: string;
  userId: string;
  body: string;
  at: string;
}

export interface WatchRoomEvidenceMember {
  userId: string;
  host: boolean;
  joinedAt: string;
  leftAt: string | null;
}

/** `reports.evidence` of a `watch_room` report (version 1). */
export interface WatchRoomEvidenceBody {
  v: 1;
  roomId: string;
  channelId: string;
  broadcastId: string;
  hostId: string;
  ageBand: string;
  createdAt: string;
  endedAt: string | null;
  members: WatchRoomEvidenceMember[];
  messages: WatchRoomEvidenceMessage[];
  /** True when the room had more than `EVIDENCE_MAX_MESSAGES` messages and only the newest were kept. */
  truncated: boolean;
}

export interface WatchRoomEvidence {
  /** Stored as `reports.evidence`; it must survive the room's 30-day retention. */
  evidence: Record<string, unknown>;
}

/** The evidence for a report on `roomId`, or null when there is no such room (expired or never). */
export async function watchRoomEvidence(tx: Executor, roomId: string): Promise<WatchRoomEvidence | null> {
  const [room] = await tx.select().from(wr).where(eq(wr.id, roomId));
  if (!room) return null;
  const [members, newest] = await Promise.all([
    tx
      .select({ userId: wm.userId, joinedAt: wm.joinedAt, leftAt: wm.leftAt })
      .from(wm)
      .where(eq(wm.roomId, roomId))
      .orderBy(asc(wm.joinedAt), asc(wm.id))
      .limit(ROOM_LIMITS.maxMembers * 64),
    tx
      .select({ id: msgs.id, userId: msgs.authorId, body: msgs.body, at: msgs.createdAt })
      .from(msgs)
      .where(eq(msgs.roomId, roomId))
      // Newest first and one past the cap, so a long room is never read whole inside the report
      // transaction; the extra row only says the transcript was truncated.
      .orderBy(desc(msgs.createdAt), desc(msgs.id))
      .limit(EVIDENCE_MAX_MESSAGES + 1),
  ]);
  const truncated = newest.length > EVIDENCE_MAX_MESSAGES;
  const kept = newest.slice(0, EVIDENCE_MAX_MESSAGES).reverse();
  const body: WatchRoomEvidenceBody = {
    v: 1,
    roomId: room.id,
    channelId: room.channelId,
    broadcastId: room.broadcastId,
    hostId: room.hostId,
    ageBand: room.ageBand,
    createdAt: room.createdAt.toISOString(),
    endedAt: room.endedAt ? room.endedAt.toISOString() : null,
    members: members.map((m) => ({
      userId: m.userId,
      host: m.userId === room.hostId,
      joinedAt: m.joinedAt.toISOString(),
      leftAt: m.leftAt ? m.leftAt.toISOString() : null,
    })),
    messages: kept.map((m) => ({ id: m.id, userId: m.userId, body: m.body, at: m.at.toISOString() })),
    truncated,
  };
  return { evidence: { ...body } };
}
