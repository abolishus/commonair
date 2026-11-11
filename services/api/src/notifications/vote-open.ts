// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `vote_open` rows as the inbox delivers them (design overhaul F8): one per proposal per member,
 * only while that proposal is still voting, named by the proposal's title looked up at read time
 * (the row itself carries only the proposal id, so nothing user-written is copied into it).
 */
import { and, eq, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type Executor, schema } from "@commonair/db";

const { notifications, proposals } = schema;

/** Notification types whose payload names a proposal by `proposalId`. */
const PROPOSAL_TYPES: ReadonlySet<string> = new Set(["proposal", "vote_open"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const proposalIdOf = (n: { payload: AnyColumn }) => sql`(${n.payload}->>'proposalId')`;

/**
 * Whether a `notifications` row is delivered: every other type is; a `vote_open` row only when its
 * proposal is still voting and it is the member's first `vote_open` row for that proposal (later
 * copies, from a re-run or a seed, are never shown or counted).
 */
export function deliveredNotification(): SQL {
  return sql`(${voteOpenDelivered()} and ${inAppAllowed()})`;
}

/**
 * Overhaul wave 4 (D7.3): governance (`proposal`, `vote_open`) and creator (`vod_ready`) rows reach
 * the inbox unless the member turned that preference's in-app medium off (their default row with
 * `enabled = false`; `NOTIFY_DEFAULTS` has in-app on for both). Applied when the inbox reads, so
 * no insert site needs it and turning in-app back on shows the rows again. Go-live in-app is
 * applied at fan-out; the other types always reach the inbox.
 */
export function inAppAllowed(): SQL {
  return sql`not exists (select 1 from notification_preferences ip
    where ip.user_id = ${notifications.userId} and ip.channel_id is null and ip.medium = 'in_app'
      and not ip.enabled
      and ((ip.type = 'governance' and ${notifications.type} in ('proposal', 'vote_open'))
        or (ip.type = 'creator' and ${notifications.type} = 'vod_ready')))`;
}

function voteOpenDelivered(): SQL {
  // The earlier copy is spelled out: drizzle renders an alias inside a raw fragment without its table.
  return sql`(${notifications.type} <> 'vote_open' or (
    exists (select 1 from proposals vp where vp.id::text = ${proposalIdOf(notifications)} and vp.status = 'voting')
    and not exists (select 1 from notifications vf where vf.user_id = ${notifications.userId}
              and vf.type = 'vote_open' and (vf.payload->>'proposalId') = ${proposalIdOf(notifications)}
              and (vf.created_at, vf.id) < (${notifications.createdAt}, ${notifications.id}))))`;
}

/**
 * The rows `markNotificationsRead({ ids })` marks: those ids, and every other `vote_open` row of
 * the same member for a proposal one of them names, so a hidden copy never stays unread.
 */
export function markedByIds(db: Executor, userId: string, ids: readonly string[]): SQL | undefined {
  const named = alias(notifications, "vote_open_named");
  const sameProposal = db
    .select({ proposalId: proposalIdOf(named) })
    .from(named)
    .where(and(eq(named.userId, userId), eq(named.type, "vote_open"), inArray(named.id, [...ids])));
  return sql`(${inArray(notifications.id, [...ids])} or (${notifications.type} = 'vote_open' and ${inArray(
    proposalIdOf(notifications),
    sameProposal,
  )}))`;
}

/** A proposal-naming payload with the proposal's current title added as `title`. */
export async function withProposalTitles<T extends { type: string; payload: Record<string, unknown> }>(
  db: Executor,
  rows: readonly T[],
): Promise<T[]> {
  const ids = [
    ...new Set(
      rows
        .filter((r) => PROPOSAL_TYPES.has(r.type))
        .map((r) => r.payload.proposalId)
        .filter((id): id is string => typeof id === "string" && UUID.test(id)),
    ),
  ];
  if (ids.length === 0) return [...rows];
  const found = await db
    .select({ id: proposals.id, title: proposals.title })
    .from(proposals)
    .where(inArray(proposals.id, ids));
  const titles = new Map(found.map((p) => [p.id, p.title]));
  return rows.map((r) => {
    const id = r.payload.proposalId;
    const title = PROPOSAL_TYPES.has(r.type) && typeof id === "string" ? titles.get(id.toLowerCase()) : undefined;
    return title === undefined ? r : { ...r, payload: { ...r.payload, title } };
  });
}
