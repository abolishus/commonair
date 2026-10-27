// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DMCA notice and takedown (17 U.S.C. § 512(c), (g), (i)); see docs/operators/dmca.md.
 * NOT REVIEWED BY A LAWYER: the flow, the policy text and `DMCA_RULES` are an engineering reading
 * of the statute.
 *
 * - `submit` (§ 512(c)(3)(A)): public, ALTCHA; URLs normalised, de-duplicated and resolved into
 *   items (a VOD, clip or live broadcast here; anything else stays unresolved for staff).
 * - `action` (§ 512(c)(1)(C)): a platform moderator actions (disable access at once: the subject
 *   keeps its status and gets `removed_reason = 'dmca'`, the worker then moves its objects to a
 *   private prefix) or rejects (the claimant hears what is missing, § 512(c)(3)(B)(ii)). Each owner
 *   gets one strike per notice (§ 512(i)) and is told (§ 512(g)(2)(A)).
 * - `counter` (§ 512(g)(3)): the owner's counter-notice starts the 12-weekday clock and is
 *   forwarded to the claimant (§ 512(g)(2)(B)); the worker restores after it unless `suitFiled`.
 *
 * Claimant and counter-notice details stay on the mutable `dmca_*` rows: audit rows, events,
 * account actions, notifications and logs carry ids, enums and counts only.
 */
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { schema, type Executor } from "@commonair/db";
import { verifyAltcha } from "../auth/altcha.ts";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { emit } from "../events/outbox.ts";
import type { Caller } from "../lib/access.ts";
import { publishUserControl } from "../lib/control.ts";
import { decodeCursor, encodeCursor, isKeyCursor } from "../lib/cursor.ts";
import { iso } from "../lib/dto.ts";
import { badRequest, conflict, forbidden, isUniqueViolation, notFound } from "../lib/errors.ts";
import { afterBroadcastEnded, endBroadcastInTx, type EndedBroadcast } from "../moderation/live.ts";
import { resolveContentUrl } from "../moderation/ncii-urls.ts";
import { notifyRoles } from "../moderation/notify.ts";
import { staffActorType } from "../moderation/review.ts";
import { moderationRuntime } from "../moderation/runtime.ts";
import { instanceHosts } from "../routes/ncii.ts";
import { loadStaffNotices, toOwnerNotice, type ItemRow, type NoticeRow } from "./dto.ts";
import { mailClaimantCounter, mailClaimantDecided, mailOwnersNoticeReceived } from "./mail.ts";
import { dedupeUrls, restoreAfter } from "./rules.ts";
import { strikeInTx, type StrikeResult } from "./strikes.ts";

const { dmcaNotices, dmcaNoticeItems, dmcaCounterNotices, vods, clips, broadcasts, channels } = schema;

/** `removed_reason` of a VOD or clip whose access a DMCA notice disabled (reversible). */
export const DMCA_REMOVED_REASON = "dmca";

/** DMCA item subjects; an `upload` (or anything else) URL stays unresolved. */
const SUBJECTS = new Set(["vod", "clip", "broadcast"]);

export interface SubmitInput {
  claimantName: string;
  claimantEmail: string;
  claimantAddress: string;
  claimantPhone?: string | undefined;
  copyrightedWork: string;
  infringingUrls: string[];
  goodFaithStatement: true;
  accuracyStatement: true;
  signature: string;
  altcha: string;
}

async function lockNotice(tx: Executor, noticeId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`dmca_notice:${noticeId}`}, 0))`);
}

export async function submitNotice(deps: Deps, input: SubmitInput): Promise<{ id: string }> {
  const failure = await verifyAltcha(input.altcha, {
    hmacKey: deps.env.ALTCHA_HMAC_KEY,
    now: () => deps.now().getTime(),
    valkey: deps.valkey,
  });
  if (failure) throw badRequest("The verification challenge failed; reload the form and try again");
  const urls = dedupeUrls(input.infringingUrls);
  if (urls.length === 0) throw badRequest("List at least one URL");
  const hosts = instanceHosts(deps);
  const resolved = (await Promise.all(urls.map((u) => resolveContentUrl(deps.db, u, hosts)))).map((r) =>
    r.subjectType !== null && SUBJECTS.has(r.subjectType)
      ? {
          url: r.url,
          subjectType: r.subjectType as "vod" | "clip" | "broadcast",
          subjectId: r.subjectId,
          channelId: r.channelId,
        }
      : { url: r.url, subjectType: null, subjectId: null, channelId: null },
  );
  const channelIds = [...new Set(resolved.map((r) => r.channelId).filter((x): x is string => x !== null))];
  const owners = new Map(
    channelIds.length
      ? (
          await deps.db
            .select({ id: channels.id, ownerId: channels.ownerId })
            .from(channels)
            .where(inArray(channels.id, channelIds))
        ).map((c) => [c.id, c.ownerId])
      : [],
  );
  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    const [n] = await tx
      .insert(dmcaNotices)
      .values({
        claimantName: input.claimantName.trim(),
        claimantEmail: input.claimantEmail.trim(),
        claimantAddress: input.claimantAddress.trim(),
        claimantPhone: input.claimantPhone?.trim() || null,
        copyrightedWork: input.copyrightedWork.trim(),
        infringingUrls: urls,
        goodFaithStatement: input.goodFaithStatement,
        accuracyStatement: input.accuracyStatement,
        signature: input.signature.trim(),
        createdAt: now,
      })
      .returning();
    if (!n) throw new Error("dmca notice insert returned no row");
    await tx.insert(dmcaNoticeItems).values(
      resolved.map((r) => ({
        noticeId: n.id,
        url: r.url,
        subjectType: r.subjectType,
        subjectId: r.subjectId,
        channelId: r.channelId,
        ownerId: r.channelId ? (owners.get(r.channelId) ?? null) : null,
        createdAt: now,
      })),
    );
    const resolvedItems = resolved.filter((r) => r.subjectType !== null).length;
    await audit(tx, {
      actorType: "system",
      actorId: null,
      action: "dmca.notice.submit",
      subjectType: "dmca_notice",
      subjectId: n.id,
      details: { noticeId: n.id, items: resolved.length, resolvedItems },
    });
    await emit(
      tx,
      "dmca.notice.received",
      null,
      { notice_id: n.id, items: resolved.length, resolved_items: resolvedItems },
      now,
    );
    await notifyRoles(tx, ["moderator", "admin"], { kind: "dmca_notice", noticeId: n.id, items: resolved.length });
    return { id: n.id };
  });
}

export async function queueNotices(
  deps: Deps,
  input: { status?: NoticeRow["status"] | undefined; cursor?: string | undefined; limit: number },
) {
  const cur = decodeCursor(input.cursor, isKeyCursor);
  // New notices are worked oldest first; everything else is browsed newest first.
  const oldestFirst = input.status === "received";
  let after: SQL | undefined;
  if (cur) {
    const t = new Date(cur.t);
    after = oldestFirst
      ? or(gt(dmcaNotices.createdAt, t), and(eq(dmcaNotices.createdAt, t), gt(dmcaNotices.id, cur.id)))
      : or(lt(dmcaNotices.createdAt, t), and(eq(dmcaNotices.createdAt, t), lt(dmcaNotices.id, cur.id)));
  }
  const rows = await deps.db
    .select()
    .from(dmcaNotices)
    .where(and(input.status ? eq(dmcaNotices.status, input.status) : undefined, after))
    .orderBy(
      ...(oldestFirst
        ? [asc(dmcaNotices.createdAt), asc(dmcaNotices.id)]
        : [desc(dmcaNotices.createdAt), desc(dmcaNotices.id)]),
    )
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: await loadStaffNotices(deps.db, page, deps.now()),
    nextCursor: rows.length > input.limit && last ? encodeCursor({ t: iso(last.createdAt), id: last.id }) : null,
  };
}

async function staffNotice(deps: Deps, noticeId: string) {
  const [n] = await deps.db.select().from(dmcaNotices).where(eq(dmcaNotices.id, noticeId));
  if (!n) throw notFound("Notice not found");
  const [dto] = await loadStaffNotices(deps.db, [n], deps.now());
  if (!dto) throw notFound("Notice not found");
  return dto;
}

/**
 * Disable access to one resolved item (§ 512(c)(1)(C)), reversibly: the subject keeps its status
 * and gets `removed_reason = 'dmca'`; its objects are moved by the worker, never deleted. Content
 * already gone (deleted, owner-removed) is not "removed" by this notice. Content another notice
 * already disabled counts as removed by this one too, so either notice's restore leaves it down
 * while the other still holds it.
 */
async function disableItemInTx(
  tx: Executor,
  item: ItemRow,
  now: Date,
): Promise<{ removed: boolean; ended: EndedBroadcast | null }> {
  if (!item.subjectId) return { removed: false, ended: null };
  const id = item.subjectId;
  switch (item.subjectType) {
    case "vod":
    case "clip": {
      const t = item.subjectType === "vod" ? vods : clips;
      const hit = await tx
        .update(t)
        .set({ removedReason: DMCA_REMOVED_REASON })
        .where(and(eq(t.id, id), isNull(t.removedReason), ne(t.status, "deleted")))
        .returning({ id: t.id });
      if (hit.length > 0) return { removed: true, ended: null };
      const [row] = await tx.select({ s: t.status, r: t.removedReason }).from(t).where(eq(t.id, id));
      return { removed: row?.s !== "deleted" && row?.r === DMCA_REMOVED_REASON, ended: null };
    }
    case "broadcast": {
      const [b] = await tx.select({ channelId: broadcasts.channelId }).from(broadcasts).where(eq(broadcasts.id, id));
      if (!b) return { removed: false, ended: null };
      const ended = await endBroadcastInTx(tx, b.channelId, id, now);
      // The broadcast's recordings carry the same material.
      await tx
        .update(vods)
        .set({ removedReason: DMCA_REMOVED_REASON })
        .where(and(eq(vods.broadcastId, id), isNull(vods.removedReason), ne(vods.status, "deleted")));
      await tx
        .update(clips)
        .set({ removedReason: DMCA_REMOVED_REASON })
        .where(and(eq(clips.broadcastId, id), isNull(clips.removedReason), ne(clips.status, "deleted")));
      return { removed: true, ended };
    }
    default:
      return { removed: false, ended: null };
  }
}

export async function decideNotice(
  deps: Deps,
  caller: Caller,
  input: { id: string; decision: "actioned" | "rejected"; note: string },
) {
  const now = deps.now();
  const actor = { actorType: staffActorType(caller.user.role), actorId: caller.user.id };
  const result = await deps.db.transaction(async (tx) => {
    await lockNotice(tx, input.id);
    const [n] = await tx.select().from(dmcaNotices).where(eq(dmcaNotices.id, input.id)).for("update");
    if (!n) throw notFound("Notice not found");
    if (n.status !== "received") throw conflict("This notice is already decided");
    const items = await tx
      .select()
      .from(dmcaNoticeItems)
      .where(eq(dmcaNoticeItems.noticeId, n.id))
      .orderBy(asc(dmcaNoticeItems.id));
    // Nobody decides a notice about their own content.
    if (items.some((i) => i.ownerId === caller.user.id))
      throw forbidden("You cannot decide a notice about your own content");
    const [updated] = await tx
      .update(dmcaNotices)
      .set({ status: input.decision, handledById: caller.user.id, actionedAt: now, decisionNote: input.note })
      .where(and(eq(dmcaNotices.id, n.id), eq(dmcaNotices.status, "received")))
      .returning();
    if (!updated) throw conflict("This notice is already decided");
    const removed: ItemRow[] = [];
    const ended: EndedBroadcast[] = [];
    const strikes: StrikeResult[] = [];
    if (input.decision === "actioned") {
      for (const i of items) {
        if (i.subjectType === null || i.removedAt !== null) continue;
        const r = await disableItemInTx(tx, i, now);
        if (r.ended) ended.push(r.ended);
        if (!r.removed) continue;
        const [row] = await tx
          .update(dmcaNoticeItems)
          .set({ removedAt: now })
          .where(and(eq(dmcaNoticeItems.id, i.id), isNull(dmcaNoticeItems.removedAt)))
          .returning();
        if (row) removed.push(row);
      }
      // One strike per notice per owner of removed material, never per URL.
      const owners = [...new Set(removed.map((i) => i.ownerId).filter((x): x is string => x !== null))];
      for (const userId of owners) strikes.push(await strikeInTx(tx, { userId, noticeId: n.id, actor, now }));
    }
    await audit(tx, {
      ...actor,
      action: input.decision === "actioned" ? "dmca.notice.action" : "dmca.notice.reject",
      subjectType: "dmca_notice",
      subjectId: n.id,
      // The note stays on the notice row (`decision_note`), never in the append-only log.
      details: {
        noticeId: n.id,
        decision: input.decision,
        items: items.length,
        removedItems: removed.length,
        strikes: strikes.filter((s) => s.strikeId !== null).length,
        terminations: strikes.filter((s) => s.terminated).length,
      },
    });
    await emit(
      tx,
      "dmca.notice.decided",
      null,
      { notice_id: n.id, decision: input.decision, removed_items: removed.length },
      now,
    );
    return { notice: updated, removed, ended, strikes, totalItems: items.length };
  });

  for (const e of result.ended) await afterBroadcastEnded(deps, e);
  for (const s of result.strikes)
    if (s.suspended) await publishUserControl(deps, { op: "disconnect", userId: s.userId, reason: "suspended" });
  if (result.removed.length > 0) {
    const rt = await moderationRuntime(deps);
    try {
      await rt.queue.dmcaDisable({ noticeId: result.notice.id });
    } catch (err) {
      // Access is already disabled in the database. A re-decision is a CONFLICT, so nothing here
      // retries it: the worker's dmca-restore run sweeps items still lacking objects_hidden_at.
      deps.logger.error("dmca-disable enqueue failed", { noticeId: result.notice.id, err: (err as Error).name });
    }
    await mailOwnersNoticeReceived(deps, result.notice, result.removed);
  }
  await mailClaimantDecided(deps, result.notice, { removed: result.removed.length, total: result.totalItems });
  return staffNotice(deps, result.notice.id);
}

export interface CounterInput {
  id: string;
  fullName: string;
  address: string;
  phone: string;
  itemIds: string[];
  statement: string;
  goodFaithStatement: true;
  consentToJurisdiction: true;
  signature: string;
}

export async function fileCounter(deps: Deps, caller: Caller, input: CounterInput): Promise<{ restoreAfter: string }> {
  const now = deps.now();
  const itemIds = [...new Set(input.itemIds)];
  const result = await deps.db
    .transaction(async (tx) => {
      await lockNotice(tx, input.id);
      const [n] = await tx.select().from(dmcaNotices).where(eq(dmcaNotices.id, input.id)).for("update");
      const items = n ? await tx.select().from(dmcaNoticeItems).where(eq(dmcaNoticeItems.noticeId, n.id)) : [];
      // A notice that names none of the caller's content does not exist for them.
      if (!n || !items.some((i) => i.ownerId === caller.user.id)) throw notFound("Notice not found");
      if (n.status !== "actioned" && n.status !== "countered")
        throw conflict("A counter-notice can be filed only for a notice that removed content");
      const byId = new Map(items.map((i) => [i.id, i]));
      for (const id of itemIds) {
        const i = byId.get(id);
        if (!i || i.ownerId !== caller.user.id || i.removedAt === null || i.restoredAt !== null)
          throw badRequest("Every item must be your removed, not yet restored content from this notice");
      }
      const [existing] = await tx
        .select({ id: dmcaCounterNotices.id })
        .from(dmcaCounterNotices)
        .where(and(eq(dmcaCounterNotices.noticeId, n.id), eq(dmcaCounterNotices.userId, caller.user.id)));
      if (existing) throw conflict("You already filed a counter-notice for this notice");
      const [c] = await tx
        .insert(dmcaCounterNotices)
        .values({
          noticeId: n.id,
          userId: caller.user.id,
          fullName: input.fullName.trim(),
          address: input.address.trim(),
          phone: input.phone.trim(),
          itemIds,
          statement: input.statement.trim(),
          goodFaithStatement: input.goodFaithStatement,
          consentToJurisdiction: input.consentToJurisdiction,
          signature: input.signature.trim(),
          restoreAfter: restoreAfter(now),
          createdAt: now,
        })
        .returning();
      if (!c) throw new Error("dmca counter-notice insert returned no row");
      const [notice] = await tx
        .update(dmcaNotices)
        .set({ status: "countered" })
        .where(eq(dmcaNotices.id, n.id))
        .returning();
      await audit(tx, {
        actorType: "user",
        actorId: caller.user.id,
        action: "dmca.counter.receive",
        subjectType: "dmca_notice",
        subjectId: n.id,
        details: { noticeId: n.id, counterNoticeId: c.id, items: itemIds.length },
      });
      await emit(
        tx,
        "dmca.counter.received",
        null,
        { notice_id: n.id, counter_notice_id: c.id, restore_after: iso(c.restoreAfter), items: itemIds.length },
        now,
      );
      await notifyRoles(tx, ["moderator", "admin"], { kind: "dmca_counter", noticeId: n.id, counterNoticeId: c.id });
      return { notice: notice ?? n, counter: c, items };
    })
    .catch((err: unknown) => {
      if (isUniqueViolation(err)) throw conflict("You already filed a counter-notice for this notice");
      throw err;
    });
  await mailClaimantCounter(deps, result.notice, result.counter, result.items);
  return { restoreAfter: iso(result.counter.restoreAfter) };
}

/** Notices about the caller's content that staff have decided (only the caller's items). */
export async function myNotices(deps: Deps, caller: Caller) {
  const own = await deps.db
    .select()
    .from(dmcaNoticeItems)
    .where(eq(dmcaNoticeItems.ownerId, caller.user.id))
    .orderBy(asc(dmcaNoticeItems.id));
  const ids = [...new Set(own.map((i) => i.noticeId))];
  if (ids.length === 0) return [];
  const [notices, counters] = await Promise.all([
    deps.db
      .select()
      .from(dmcaNotices)
      // An undecided notice is not yet about the owner: they hear of it when it is actioned.
      .where(and(inArray(dmcaNotices.id, ids), ne(dmcaNotices.status, "received")))
      .orderBy(desc(dmcaNotices.createdAt), desc(dmcaNotices.id)),
    deps.db
      .select()
      .from(dmcaCounterNotices)
      .where(and(inArray(dmcaCounterNotices.noticeId, ids), eq(dmcaCounterNotices.userId, caller.user.id))),
  ]);
  return notices.map((n) =>
    toOwnerNotice(
      n,
      own.filter((i) => i.noticeId === n.id),
      counters.find((c) => c.noticeId === n.id) ?? null,
    ),
  );
}

/** § 512(g)(2)(C): the claimant told the agent they filed suit; the content stays down. */
export async function recordSuit(deps: Deps, caller: Caller, input: { id: string; note: string }) {
  const now = deps.now();
  const noticeId = await deps.db.transaction(async (tx) => {
    const [c] = await tx.select().from(dmcaCounterNotices).where(eq(dmcaCounterNotices.id, input.id)).for("update");
    if (!c) throw notFound("Counter-notice not found");
    if (c.suitFiledAt !== null) throw conflict("A court action is already recorded for this counter-notice");
    if (c.restoredAt !== null) throw conflict("The content was already restored");
    await tx
      .update(dmcaCounterNotices)
      // The note stays on this mutable row, never in the audit log.
      .set({ suitFiledAt: now, suitRecordedById: caller.user.id, suitNote: input.note })
      .where(and(eq(dmcaCounterNotices.id, c.id), isNull(dmcaCounterNotices.suitFiledAt)));
    await audit(tx, {
      actorType: staffActorType(caller.user.role),
      actorId: caller.user.id,
      action: "dmca.counter.suit_filed",
      subjectType: "dmca_notice",
      subjectId: c.noticeId,
      details: { noticeId: c.noticeId, counterNoticeId: c.id },
    });
    await emit(tx, "dmca.counter.suit_filed", null, { notice_id: c.noticeId, counter_notice_id: c.id }, now);
    return c.noticeId;
  });
  return staffNotice(deps, noticeId);
}
