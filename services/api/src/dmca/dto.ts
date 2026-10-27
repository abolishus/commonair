// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DMCA DTOs. The staff view (`DmcaNotice`) carries the claimant's and counter-notifiers' contact
 * details for platform moderators; the owner view (`DmcaNoticeForOwner`) carries the claimant's
 * name only, never their email, address, phone or signature.
 */
import type * as D from "@commonair/contracts/dto";
import { activeDmcaStrikes, schema, type Executor } from "@commonair/db";
import { asc, inArray } from "drizzle-orm";
import { iso, isoOrNull } from "../lib/dto.ts";

const { dmcaNotices, dmcaNoticeItems, dmcaCounterNotices, users } = schema;
export type NoticeRow = typeof dmcaNotices.$inferSelect;
export type ItemRow = typeof dmcaNoticeItems.$inferSelect;
export type CounterRow = typeof dmcaCounterNotices.$inferSelect;
type UserRef = { id: string; username: string };

export const toItem = (i: ItemRow): D.DmcaNoticeItem => ({
  id: i.id,
  url: i.url,
  subjectType: i.subjectType,
  subjectId: i.subjectId,
  ownerId: i.ownerId,
  removedAt: isoOrNull(i.removedAt),
  restoredAt: isoOrNull(i.restoredAt),
});

export const toCounter = (c: CounterRow, user: UserRef): D.DmcaCounterNotice => ({
  id: c.id,
  noticeId: c.noticeId,
  user,
  itemIds: c.itemIds,
  fullName: c.fullName,
  address: c.address,
  phone: c.phone,
  statement: c.statement,
  restoreAfter: iso(c.restoreAfter),
  restoredAt: isoOrNull(c.restoredAt),
  suitFiledAt: isoOrNull(c.suitFiledAt),
  suitNote: c.suitNote,
  createdAt: iso(c.createdAt),
});

export function toStaffNotice(
  n: NoticeRow,
  items: ItemRow[],
  counters: { row: CounterRow; user: UserRef }[],
  ownerStrikes: Record<string, number>,
  handledBy: UserRef | null,
): D.DmcaNotice {
  return {
    id: n.id,
    status: n.status,
    claimantName: n.claimantName,
    claimantEmail: n.claimantEmail,
    claimantAddress: n.claimantAddress,
    claimantPhone: n.claimantPhone,
    copyrightedWork: n.copyrightedWork,
    infringingUrls: n.infringingUrls,
    signature: n.signature,
    items: items.map(toItem),
    counters: counters.map((c) => toCounter(c.row, c.user)),
    ownerStrikes,
    handledBy,
    decisionNote: n.decisionNote,
    createdAt: iso(n.createdAt),
    actionedAt: isoOrNull(n.actionedAt),
  };
}

/** The owner's view: only their own items, the claimant's name, and their own counter-notice. */
export function toOwnerNotice(n: NoticeRow, ownItems: ItemRow[], counter: CounterRow | null): D.DmcaNoticeForOwner {
  return {
    id: n.id,
    status: n.status,
    claimantName: n.claimantName,
    copyrightedWork: n.copyrightedWork,
    items: ownItems.map(toItem),
    counter: counter
      ? {
          id: counter.id,
          restoreAfter: iso(counter.restoreAfter),
          restoredAt: isoOrNull(counter.restoredAt),
          suitFiledAt: isoOrNull(counter.suitFiledAt),
        }
      : null,
    createdAt: iso(n.createdAt),
    actionedAt: isoOrNull(n.actionedAt),
  };
}

/** Staff DTOs for a page of notices: items, counters, handlers and owners' strikes in a few queries. */
export async function loadStaffNotices(db: Executor, rows: NoticeRow[], now: Date): Promise<D.DmcaNotice[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [items, counters] = await Promise.all([
    db.select().from(dmcaNoticeItems).where(inArray(dmcaNoticeItems.noticeId, ids)).orderBy(asc(dmcaNoticeItems.id)),
    db
      .select()
      .from(dmcaCounterNotices)
      .where(inArray(dmcaCounterNotices.noticeId, ids))
      .orderBy(asc(dmcaCounterNotices.createdAt)),
  ]);
  const userIds = [
    ...new Set([
      ...counters.map((c) => c.userId),
      ...rows.map((r) => r.handledById).filter((x): x is string => x !== null),
    ]),
  ];
  const people = userIds.length
    ? await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, userIds))
    : [];
  const byId = new Map(people.map((u) => [u.id, u]));
  const owners = [...new Set(items.map((i) => i.ownerId).filter((x): x is string => x !== null))];
  const strikes = new Map<string, number>();
  for (const o of owners) strikes.set(o, await activeDmcaStrikes(db, o, now));
  return rows.map((n) => {
    const own = items.filter((i) => i.noticeId === n.id);
    const ownerStrikes: Record<string, number> = {};
    for (const i of own) if (i.ownerId) ownerStrikes[i.ownerId] = strikes.get(i.ownerId) ?? 0;
    return toStaffNotice(
      n,
      own,
      counters
        .filter((c) => c.noticeId === n.id)
        .map((c) => ({ row: c, user: byId.get(c.userId) ?? { id: c.userId, username: "" } })),
      ownerStrikes,
      n.handledById ? (byId.get(n.handledById) ?? { id: n.handledById, username: "" }) : null,
    );
  });
}
