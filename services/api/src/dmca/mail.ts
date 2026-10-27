// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DMCA mail, always after commit and never failing the action (`sendNotice`). Addresses are read
 * here and passed to the mailer only; they never reach a log (the mailer logs template ids).
 */
import { schema } from "@commonair/db";
import { inArray } from "drizzle-orm";
import type { Deps } from "../deps.ts";
import { appUrl, sendNotice } from "../mail.ts";
import type { CounterRow, ItemRow, NoticeRow } from "./dto.ts";

const { users, vods, clips, broadcasts } = schema;

/** The notice reference people see in mail and on the page: its id. */
export const noticeRef = (noticeId: string) => noticeId;

/** Where the owner reads the notice and files a counter-notice. */
export const ownerNoticePath = (noticeId: string) => `/settings/copyright?notice=${encodeURIComponent(noticeId)}`;

/** A human title for each resolved item's subject (VOD/clip/broadcast title, else the URL). */
export async function itemTitles(deps: Deps, items: readonly ItemRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = (t: string) => items.filter((i) => i.subjectType === t && i.subjectId).map((i) => i.subjectId as string);
  const [v, c, b] = await Promise.all([
    ids("vod").length
      ? deps.db
          .select({ id: vods.id, title: vods.title })
          .from(vods)
          .where(inArray(vods.id, ids("vod")))
      : [],
    ids("clip").length
      ? deps.db
          .select({ id: clips.id, title: clips.title })
          .from(clips)
          .where(inArray(clips.id, ids("clip")))
      : [],
    ids("broadcast").length
      ? deps.db
          .select({ id: broadcasts.id, title: broadcasts.title })
          .from(broadcasts)
          .where(inArray(broadcasts.id, ids("broadcast")))
      : [],
  ]);
  const titles = new Map([...v, ...c, ...b].map((r) => [r.id, r.title]));
  for (const i of items) out.set(i.id, (i.subjectId && titles.get(i.subjectId)) || i.url);
  return out;
}

/** § 512(g)(2)(A): tell each owner of removed content, with a link to the notice. */
export async function mailOwnersNoticeReceived(deps: Deps, notice: NoticeRow, removed: readonly ItemRow[]) {
  const titles = await itemTitles(deps, removed);
  const owners = [...new Set(removed.map((i) => i.ownerId).filter((x): x is string => x !== null))];
  if (owners.length === 0) return;
  const people = await deps.db
    .select({ id: users.id, email: users.email, locale: users.locale, accountType: users.accountType })
    .from(users)
    .where(inArray(users.id, owners));
  for (const u of people) {
    if (u.accountType !== "human") continue;
    const own = removed.filter((i) => i.ownerId === u.id);
    const contentTitle = own.map((i) => titles.get(i.id) ?? i.url).join(", ");
    await sendNotice(deps.logger, "dmcaNoticeReceived", () =>
      deps.mailer.send(
        "dmcaNoticeReceived",
        {
          contentTitle,
          noticeRef: noticeRef(notice.id),
          receivedAt: notice.createdAt,
          noticeUrl: appUrl(deps.site, ownerNoticePath(notice.id)),
          locale: u.locale,
        },
        u.email,
      ),
    );
  }
}

/**
 * The claimant hears the decision; a rejection carries the moderator's note (what was missing).
 * An actioned notice says how many of its locations were actually disabled, so the claimant is
 * never told material came down when none (or only some) did.
 */
export async function mailClaimantDecided(deps: Deps, notice: NoticeRow, counts: { removed: number; total: number }) {
  if (notice.status !== "actioned" && notice.status !== "rejected") return;
  const decision = notice.status;
  await sendNotice(deps.logger, "dmcaNoticeDecided", () =>
    deps.mailer.send(
      "dmcaNoticeDecided",
      {
        noticeRef: noticeRef(notice.id),
        decision,
        decidedAt: notice.actionedAt ?? deps.now(),
        note: notice.decisionNote ?? "",
        removedItems: counts.removed,
        totalItems: counts.total,
      },
      notice.claimantEmail,
    ),
  );
}

/**
 * § 512(g)(2)(B): forward the counter-notice to the claimant. This is the one place the
 * uploader's name, address and phone leave the instance, because the statute requires the
 * claimant to receive them (to be able to sue); they go nowhere else.
 */
export async function mailClaimantCounter(deps: Deps, notice: NoticeRow, counter: CounterRow, items: ItemRow[]) {
  const covered = items.filter((i) => counter.itemIds.includes(i.id));
  await sendNotice(deps.logger, "dmcaCounterNoticeForwarded", () =>
    deps.mailer.send(
      "dmcaCounterNoticeForwarded",
      {
        noticeRef: noticeRef(notice.id),
        fullName: counter.fullName,
        address: counter.address,
        phone: counter.phone,
        statement: counter.statement,
        signature: counter.signature,
        items: covered.map((i) => i.url),
        receivedAt: counter.createdAt,
        restoreAfter: counter.restoreAfter,
      },
      notice.claimantEmail,
    ),
  );
}
