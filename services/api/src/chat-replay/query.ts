// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Chat replay (ADR 0012 amendment 1 decisions 5 to 7): one broadcast's messages inside a
 * wall-clock window, in media-time order, minus everything the live room could no longer see and
 * everything this viewer chose not to see. Rows are read through
 * `chat_messages_broadcast_media_idx (broadcast_id, media_ts)`.
 */
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { dto } from "@commonair/contracts";
import type { z } from "zod";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { messageDtos, type MessageRow } from "../chat/messages.ts";
import { decodeReplayCursor, encodeReplayCursor } from "./cursor.ts";

const { chatMessages: m, users, vods } = schema;
type ChannelRow = typeof schema.channels.$inferSelect;

const DAY_MS = 86_400_000;

/** `ChatReplayPage` has no exported type alias in the contract; infer it. */
export type ChatReplayPage = z.output<typeof dto.ChatReplayPage>;

export interface ReplayBroadcast {
  id: string;
  startedAt: Date;
  /** Null while it is still live (the VOD is recording). */
  endedAt: Date | null;
}

export interface ReplayWindow {
  channel: ChannelRow;
  /** Null when the clip's broadcast is gone: nothing to replay. */
  broadcast: ReplayBroadcast | null;
  from: Date;
  to: Date;
}

export interface ReplayInput {
  cursor?: string;
  limit: number;
}

/** What a message is placed at: its media time, or its receive time when it has none. */
const at = sql`coalesce(${m.mediaTs}, ${m.createdAt})`;
/** `at` as Postgres's microsecond UTC text, for the cursor. */
const atText = sql<string>`to_char(${at} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const tsz = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;

/** Inside the broadcast's span (open-ended while it is live). */
const duringBroadcast = (column: SQL, b: ReplayBroadcast): SQL =>
  b.endedAt
    ? sql`${column} >= ${tsz(b.startedAt)} and ${column} <= ${tsz(b.endedAt)}`
    : sql`${column} >= ${tsz(b.startedAt)}`;

/**
 * Decision 7, per message row of `b`'s channel: what live viewers saw purged or never saw, the
 * author's account state, and this viewer's blocks.
 */
export function replayable(b: ReplayBroadcast, viewerId: string | null, now: Date): SQL {
  const parts: SQL[] = [
    // Deleted (author, moderator or a report resolution) and held-and-never-approved messages.
    sql`${m.deletedAt} is null`,
    sql`${m.heldAt} is null`,
    // A `/clear` in this broadcast after the message.
    sql`not exists (select 1 from mod_actions a
                     where a.channel_id = ${m.channelId}
                       and a.action = 'clear_chat'
                       and a.created_at > ${m.createdAt}
                       and ${duringBroadcast(sql`a.created_at`, b)})`,
    // A ban or timeout of the author in this channel during this broadcast, after the message
    // (every ban inserts a row; a later lift does not bring the purged lines back).
    sql`not exists (select 1 from chat_bans cb
                     where cb.channel_id = ${m.channelId}
                       and cb.user_id = ${m.userId}
                       and cb.created_at > ${m.createdAt}
                       and ${duringBroadcast(sql`cb.created_at`, b)})`,
    // A permanent channel ban hides the author on every replay of the channel.
    sql`not exists (select 1 from chat_bans pb
                     where pb.channel_id = ${m.channelId}
                       and pb.user_id = ${m.userId}
                       and pb.expires_at is null
                       and pb.lifted_at is null)`,
    // A platform suspension hides the author while it lasts.
    sql`not (${users.banned} and (${users.banExpires} is null or ${users.banExpires} > ${tsz(now)}))`,
  ];
  if (viewerId)
    parts.push(sql`not exists (select 1 from user_blocks ub
                                where ub.user_id = ${viewerId}
                                  and ub.blocked_user_id = ${m.userId})`);
  return and(...parts) as SQL;
}

/** Whether the broadcast still has a VOD that keeps its chat (retention's own test, decision 6). */
async function hasLiveVod(deps: Pick<Deps, "db">, broadcastId: string): Promise<boolean> {
  const [row] = await deps.db
    .select({ id: vods.id })
    .from(vods)
    .where(and(eq(vods.broadcastId, broadcastId), sql`${vods.status} <> 'deleted'`, sql`${vods.removedReason} is null`))
    .limit(1);
  return row !== undefined;
}

/** Decision 6: has every message of a window ending at `to` aged out by now? */
export function agedOut(
  to: Date,
  now: Date,
  vodAlive: boolean,
  env: Pick<Deps["env"], "CHAT_RETENTION_DAYS" | "CHAT_REPLAY_MAX_DAYS">,
): boolean {
  const days = vodAlive ? env.CHAT_REPLAY_MAX_DAYS : env.CHAT_RETENTION_DAYS;
  return to.getTime() < now.getTime() - days * DAY_MS;
}

/** One page of the window's replay for `viewerId` (null when signed out). */
export async function replayPage(
  deps: Pick<Deps, "db" | "env" | "now">,
  w: ReplayWindow,
  viewerId: string | null,
  input: ReplayInput,
): Promise<ChatReplayPage> {
  const cursor = decodeReplayCursor(input.cursor);
  const now = deps.now();
  const b = w.broadcast;
  if (!b) return { items: [], nextCursor: null, retained: false };
  const where = [
    eq(m.broadcastId, b.id),
    sql`${at} >= ${tsz(w.from)}`,
    sql`${at} <= ${tsz(w.to)}`,
    replayable(b, viewerId, now),
  ];
  if (cursor) where.push(sql`(${at}, ${m.id}) > (${cursor.t}::timestamptz, ${cursor.id}::uuid)`);
  const rows = await deps.db
    .select({ m, u: users, atText })
    .from(m)
    .innerJoin(users, eq(users.id, m.userId))
    .where(and(...where))
    .orderBy(asc(at), asc(m.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > input.limit && last ? encodeReplayCursor({ t: last.atText, id: last.m.id }) : null;

  const dtos = await messageDtos(
    deps,
    w.channel,
    page.map((r): MessageRow => ({ m: r.m, u: r.u })),
  );
  await blankHiddenQuotes(deps, b, viewerId, now, dtos);
  const items = dtos.map((d, i) => {
    const row = page[i];
    const mediaTs = row?.m.mediaTs ?? null;
    return {
      ...d,
      at: (mediaTs ?? row?.m.createdAt ?? new Date(d.createdAt)).toISOString(),
      catchingUp: mediaTs === null,
    };
  });
  const retained = items.length > 0 || cursor !== null || !agedOut(w.to, now, await hasLiveVod(deps, b.id), deps.env);
  return { items, nextCursor, retained };
}

/** A quoted reply whose target replay hides (a blocked or banned author, a cleared line) shows blank, as a deleted one does. */
async function blankHiddenQuotes(
  deps: Pick<Deps, "db">,
  b: ReplayBroadcast,
  viewerId: string | null,
  now: Date,
  dtos: dto.ChatMessage[],
): Promise<void> {
  const quoted = [...new Set(dtos.map((d) => d.replyTo?.id).filter((x): x is string => typeof x === "string"))];
  if (quoted.length === 0) return;
  const visible = new Set(
    (
      await deps.db
        .select({ id: m.id })
        .from(m)
        .innerJoin(users, eq(users.id, m.userId))
        .where(and(inArray(m.id, quoted), replayable(b, viewerId, now)))
    ).map((r) => r.id),
  );
  for (const d of dtos) if (d.replyTo && !visible.has(d.replyTo.id)) d.replyTo = { ...d.replyTo, body: "" };
}
