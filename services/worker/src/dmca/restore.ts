// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `dmca-restore` (§ 512(g)(2)(C); NOT REVIEWED BY A LAWYER): every 15 minutes, restore the
 * material of each counter-notice whose waiting period (`restore_after`, 12 weekdays after
 * receipt, inside the statute's 10 to 14 business days) has ended, unless the claimant told the
 * designated agent they filed suit (`suit_filed_at`). Per counter-notice, in this order:
 *
 * 1. move the hidden objects back to their public keys (material another active notice still
 *    holds stays hidden, and so does a VOD deleted in the meantime);
 * 2. one transaction: clear `removed_reason = 'dmca'` (a VOD deleted since by retention stays
 *    deleted: `restorable: false` in the audit), set the items' and the counter-notice's
 *    `restored_at`, reverse that notice's strike (`counter_notice_restored`) once none of the
 *    user's removed items on it is left down (a counter-notice covering only some of them keeps
 *    the strike), reconcile a repeat-infringer termination now under the threshold
 *    (`reconcileDmcaTerminationInTx`, which lifts only the DMCA suspension), mark the notice
 *    `restored` once every removed item is back, audit `dmca.content.restore` and the events;
 * 3. after commit: the user-control invalidation and the `contentRestored` mail, which names only
 *    material that is actually available again (not material another notice still holds, nor a
 *    VOD deleted meanwhile).
 *
 * If the transaction finds the counter-notice no longer due (a suit was recorded meanwhile), or
 * fails, the objects are hidden again. `asOf` is honoured only with test hooks on (`dmca-tick`).
 *
 * Each run first sweeps actioned items whose objects were never moved (`objects_hidden_at` null:
 * the API's enqueue failed, the job ran out of attempts, or media was still being written) and
 * runs `dmca-disable` for their notices again.
 */
import { BUS, UserControlMessage } from "@commonair/contracts/events";
import type { DmcaRestoreJob, DmcaRestoreResult } from "@commonair/contracts/internal";
import {
  lockAccountActions,
  reconcileDmcaTerminationInTx,
  reverseAccountActionInTx,
  schema,
  type Executor,
} from "@commonair/db";
import { and, asc, eq, inArray, isNotNull, isNull, ne, notInArray, sql } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { withRunLock } from "../integrity/lock.ts";
import { alert, audit, emit, safeErrorCode } from "../moderation/records.ts";
import { DmcaMediaPendingError, disableNoticeObjects } from "./disable.ts";
import { coveredBy, coveredIds, hideObjects, objectsOf, unhideObjects, type Covered } from "./objects.ts";

const {
  dmcaNotices: notices,
  dmcaNoticeItems: items,
  dmcaCounterNotices: counters,
  accountActions,
  vods,
  clips,
  channels,
  users,
} = schema;

export const DMCA_RESTORE_LOCK = "worker:lock:moderation:dmca-restore";
/** Counter-notices handled per run; the rest wait for the next one (every 15 min). */
const BATCH = 200;
/** Notices re-run through dmca-disable per sweep. */
const SWEEP_BATCH = 50;
/** A fresh action's own dmca-disable job gets this long before the sweep steps in. */
export const SWEEP_GRACE_MS = 10 * 60_000;

type CounterRow = typeof counters.$inferSelect;
type ItemRow = typeof items.$inferSelect;

/** `asOf` is honoured only with test hooks on; otherwise it is the worker's clock. */
export function restoreAsOf(ctx: WorkerContext, job: DmcaRestoreJob): Date {
  if (!job.asOf) return ctx.now();
  if (ctx.moderation?.testHooks) return new Date(job.asOf);
  ctx.logger.warn("dmca-restore asOf ignored: test hooks are off");
  return ctx.now();
}

/** Whether a counter-notice is due at `asOf` (pure; the boundary is inclusive). */
export const isDue = (c: Pick<CounterRow, "restoreAfter" | "restoredAt" | "suitFiledAt">, asOf: Date) =>
  c.restoredAt === null && c.suitFiledAt === null && c.restoreAfter.getTime() <= asOf.getTime();

interface Plan {
  items: ItemRow[];
  covered: Covered[];
  /** Material another active (removed, not restored) item still holds. */
  held: { vodIds: Set<string>; clipIds: Set<string> };
}

async function plan(db: Executor, c: CounterRow): Promise<Plan> {
  const rows = await db
    .select()
    .from(items)
    .where(
      and(
        eq(items.noticeId, c.noticeId),
        inArray(items.id, c.itemIds),
        isNotNull(items.removedAt),
        isNull(items.restoredAt),
      ),
    );
  const channelIds = [...new Set(rows.map((i) => i.channelId).filter((x): x is string => x !== null))];
  const others =
    channelIds.length && rows.length
      ? await db
          .select()
          .from(items)
          .where(
            and(
              inArray(items.channelId, channelIds),
              isNotNull(items.removedAt),
              isNull(items.restoredAt),
              notInArray(
                items.id,
                rows.map((i) => i.id),
              ),
            ),
          )
      : [];
  const covered = await Promise.all(rows.map((i) => coveredBy(db, i)));
  return { items: rows, covered, held: await coveredIds(db, others) };
}

const objectsToRestore = (p: Plan) => {
  const keys: string[] = [];
  const prefixes: string[] = [];
  for (const c of p.covered) {
    const o = objectsOf(c, p.held);
    keys.push(...o.keys);
    prefixes.push(...o.prefixes);
  }
  return { keys, prefixes };
};

interface Restored {
  noticeId: string;
  userId: string;
  restoredItems: number;
  /** Titles of restored items whose material is available again (what the owner is told). */
  availableTitles: string[];
  channelSlug: string | null;
  terminationReversed: boolean;
}

async function restoreInTx(tx: Executor, c: CounterRow, p: Plan, asOf: Date): Promise<Restored | null> {
  const [row] = await tx.select().from(counters).where(eq(counters.id, c.id)).for("update");
  if (!row || !isDue(row, asOf)) return null;
  let unrestorable = 0;
  let held = 0;
  const titles: string[] = [];
  for (const [n, cov] of p.covered.entries()) {
    const item = p.items[n];
    if (!item) continue;
    const vodIds = cov.vods.filter((v) => !p.held.vodIds.has(v.id)).map((v) => v.id);
    const clipIds = cov.clips.filter((x) => !p.held.clipIds.has(x.id)).map((x) => x.id);
    if (vodIds.length) {
      await tx
        .update(vods)
        .set({ removedReason: null })
        .where(and(inArray(vods.id, vodIds), eq(vods.removedReason, "dmca"), ne(vods.status, "deleted")));
      // Retention deleted it while it was down (`coalesce(removed_reason, 'retention')` kept
      // 'dmca'): it stays deleted, now under its real reason so its clips are not hidden for good.
      await tx
        .update(vods)
        .set({ removedReason: "retention" })
        .where(and(inArray(vods.id, vodIds), eq(vods.removedReason, "dmca"), eq(vods.status, "deleted")));
    }
    if (clipIds.length)
      await tx
        .update(clips)
        .set({ removedReason: null })
        .where(and(inArray(clips.id, clipIds), eq(clips.removedReason, "dmca"), ne(clips.status, "deleted")));
    const direct =
      item.subjectType === "vod"
        ? cov.vods.find((v) => v.id === item.subjectId)
        : item.subjectType === "clip"
          ? cov.clips.find((x) => x.id === item.subjectId)
          : undefined;
    const gone = item.subjectType !== "broadcast" && (!direct || direct.status === "deleted");
    if (gone) unrestorable++;
    // Still down because another active notice holds the same material: restored for this
    // notice (so neither notice blocks the other for good), but not available, so not mailed.
    const stillHeld =
      item.subjectType === "vod" || item.subjectType === "broadcast"
        ? cov.vods.length > 0 && cov.vods.every((v) => p.held.vodIds.has(v.id))
        : item.subjectType === "clip" && item.subjectId !== null && p.held.clipIds.has(item.subjectId);
    if (stillHeld && !gone) held++;
    if (gone || stillHeld) continue;
    const [t] =
      item.subjectType === "vod" && item.subjectId
        ? await tx.select({ title: vods.title }).from(vods).where(eq(vods.id, item.subjectId))
        : item.subjectType === "clip" && item.subjectId
          ? await tx.select({ title: clips.title }).from(clips).where(eq(clips.id, item.subjectId))
          : [];
    titles.push(t?.title || item.url);
  }
  const ids = p.items.map((i) => i.id);
  if (ids.length)
    await tx
      .update(items)
      .set({ restoredAt: asOf })
      .where(and(inArray(items.id, ids), isNull(items.restoredAt)));
  await tx
    .update(counters)
    .set({ restoredAt: asOf })
    .where(and(eq(counters.id, c.id), isNull(counters.restoredAt)));

  // § 512(i): a successfully countered notice no longer counts towards the repeat-infringer policy,
  // but only once all of this user's removed material on it is back: countering one of several
  // URLs must not wipe the strike while the rest stays down.
  await lockAccountActions(tx, c.userId);
  const [stillDown] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(items)
    .where(
      and(
        eq(items.noticeId, c.noticeId),
        eq(items.ownerId, c.userId),
        isNotNull(items.removedAt),
        isNull(items.restoredAt),
      ),
    );
  const [strike] =
    (stillDown?.n ?? 0) > 0
      ? []
      : await tx
          .select({ id: accountActions.id })
          .from(accountActions)
          .where(
            and(
              eq(accountActions.userId, c.userId),
              eq(accountActions.action, "dmca_strike"),
              eq(accountActions.sourceType, "dmca_notice"),
              eq(accountActions.sourceId, c.noticeId),
              isNull(accountActions.reversedAt),
            ),
          );
  const reversedStrike = strike
    ? await reverseAccountActionInTx(tx, { id: strike.id, now: asOf, byId: null, reason: "counter_notice_restored" })
    : null;
  if (reversedStrike)
    await emit(
      tx,
      "account.action.reversed",
      null,
      {
        account_action_id: reversedStrike.id,
        user_id: c.userId,
        action: "dmca_strike",
        reversal: "counter_notice_restored",
      },
      asOf,
    );
  const termination = reversedStrike
    ? await reconcileDmcaTerminationInTx(tx, { userId: c.userId, now: asOf, byId: null })
    : null;
  if (termination)
    await emit(
      tx,
      "account.action.reversed",
      null,
      {
        account_action_id: termination.id,
        user_id: c.userId,
        action: "dmca_termination",
        reversal: "strikes_below_threshold",
      },
      asOf,
    );

  const [left] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(items)
    .where(and(eq(items.noticeId, c.noticeId), isNotNull(items.removedAt), isNull(items.restoredAt)));
  if ((left?.n ?? 0) === 0) await tx.update(notices).set({ status: "restored" }).where(eq(notices.id, c.noticeId));

  await audit(
    tx,
    {
      action: "dmca.content.restore",
      subjectType: "dmca_notice",
      subjectId: c.noticeId,
      details: {
        noticeId: c.noticeId,
        counterNoticeId: c.id,
        restoredItems: ids.length,
        unrestorableItems: unrestorable,
        heldItems: held,
        restorable: unrestorable === 0,
        strikeReversed: reversedStrike !== null,
        terminationReversed: termination !== null,
      },
    },
    asOf,
  );
  await emit(
    tx,
    "dmca.content.restored",
    null,
    { notice_id: c.noticeId, counter_notice_id: c.id, restored_items: ids.length },
    asOf,
  );
  if (termination)
    await audit(
      tx,
      {
        action: "account.dmca_termination.reverse",
        subjectType: "user",
        subjectId: c.userId,
        details: { userId: c.userId, accountActionId: termination.id, reversal: "strikes_below_threshold" },
      },
      asOf,
    );
  const [ch] = await tx.select({ slug: channels.slug }).from(channels).where(eq(channels.ownerId, c.userId));
  return {
    noticeId: c.noticeId,
    userId: c.userId,
    restoredItems: ids.length,
    availableTitles: titles,
    channelSlug: ch?.slug ?? null,
    terminationReversed: termination !== null,
  };
}

async function afterRestore(ctx: WorkerContext, r: Restored, asOf: Date) {
  if (r.terminationReversed) {
    const msg = UserControlMessage.parse({ op: "invalidate", userId: r.userId, reason: "suspended" });
    await ctx.valkey.publish(BUS.userControl, JSON.stringify(msg));
  }
  if (!ctx.mailer || !ctx.site || r.availableTitles.length === 0) return;
  const [u] = await ctx.db
    .select({ email: users.email, locale: users.locale, accountType: users.accountType })
    .from(users)
    .where(eq(users.id, r.userId));
  if (!u || u.accountType !== "human") return;
  const base = ctx.site.publicUrl.replace(/\/+$/, "");
  try {
    await ctx.mailer.send(
      "contentRestored",
      {
        contentTitle: r.availableTitles.join(", "),
        restoredAt: asOf,
        contentUrl: `${base}/${r.channelSlug ? encodeURIComponent(r.channelSlug) : "settings/copyright"}`,
        locale: u.locale,
      },
      u.email,
    );
  } catch (err) {
    // The restore stands; only the notice mail is lost (never log the address).
    ctx.logger.warn("dmca contentRestored mail failed", { noticeId: r.noticeId, errorCode: safeErrorCode(err) });
  }
}

/** Restore one due counter-notice. Returns the restored item count, or null when it was no longer due. */
export async function restoreCounter(ctx: WorkerContext, c: CounterRow, asOf: Date): Promise<number | null> {
  const p = await plan(ctx.db, c);
  const objects = objectsToRestore(p);
  // Objects first, so the content works the moment it is listed again.
  if (ctx.storage) await unhideObjects(ctx.storage, ctx.mediaBucket, objects);
  let r: Restored | null;
  try {
    r = await ctx.db.transaction((tx) => restoreInTx(tx, c, p, asOf));
  } catch (err) {
    // The database still hides the content, so its files must not stay public either (a suit
    // recorded before the next run would otherwise leave them out for good).
    if (ctx.storage) await hideObjects(ctx.storage, ctx.mediaBucket, objects);
    throw err;
  }
  if (!r) {
    // No longer due (a suit was recorded meanwhile): put the objects back out of reach.
    if (ctx.storage) await hideObjects(ctx.storage, ctx.mediaBucket, objects);
    return null;
  }
  await afterRestore(ctx, r, asOf);
  return r.restoredItems;
}

/**
 * Re-run dmca-disable for notices with actioned items whose objects were never moved. Nothing
 * else retries them: a failed enqueue or an exhausted job would otherwise leave the files public.
 */
export async function sweepUnhidden(ctx: WorkerContext, asOf: Date): Promise<number> {
  if (!ctx.storage) return 0;
  const before = new Date(asOf.getTime() - SWEEP_GRACE_MS).toISOString();
  const rows = await ctx.db
    .selectDistinct({ noticeId: items.noticeId })
    .from(items)
    .where(
      and(
        isNotNull(items.removedAt),
        isNull(items.objectsHiddenAt),
        isNull(items.restoredAt),
        sql`${items.removedAt} <= ${before}::timestamptz`,
      ),
    )
    .limit(SWEEP_BATCH);
  let swept = 0;
  for (const { noticeId } of rows) {
    try {
      swept += (await disableNoticeObjects(ctx, { noticeId })).items;
    } catch (err) {
      if (err instanceof DmcaMediaPendingError) continue; // still being written; next run
      alert(ctx, "dmca_disable_failed", "a DMCA notice's objects could not be hidden", {
        noticeId,
        errorCode: safeErrorCode(err),
      });
    }
  }
  return swept;
}

export async function runDmcaRestoreOnce(ctx: WorkerContext, asOf: Date): Promise<DmcaRestoreResult> {
  await sweepUnhidden(ctx, asOf);
  const due = await ctx.db
    .select()
    .from(counters)
    .where(
      and(
        isNull(counters.restoredAt),
        isNull(counters.suitFiledAt),
        sql`${counters.restoreAfter} <= ${asOf.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(counters.restoreAfter))
    .limit(BATCH);
  const result: DmcaRestoreResult = { restored: 0, counters: 0 };
  for (const c of due) {
    try {
      const n = await restoreCounter(ctx, c, asOf);
      if (n === null) continue;
      result.restored += n;
      result.counters++;
    } catch (err) {
      // One counter-notice failing must not stop the others; it is retried next run.
      alert(ctx, "dmca_restore_failed", "a DMCA counter-notice could not be restored", {
        counterNoticeId: c.id,
        errorCode: safeErrorCode(err),
      });
    }
  }
  if (result.counters > 0) ctx.logger.info("dmca restore run", { ...result, asOf: asOf.toISOString() });
  return result;
}

/** The job: under the run lock. An on-demand (`asOf`) run waits for a scheduled run to finish. */
export async function dmcaRestore(ctx: WorkerContext, job: DmcaRestoreJob): Promise<DmcaRestoreResult> {
  const asOf = restoreAsOf(ctx, job);
  const deadline = Date.now() + (job.asOf ? 25_000 : 0);
  for (;;) {
    const r = await withRunLock(
      ctx.valkey,
      DMCA_RESTORE_LOCK,
      { ttlMs: 30_000, maxHoldMs: 10 * 60_000, job: "dmca-restore", logger: ctx.logger },
      () => runDmcaRestoreOnce(ctx, asOf),
    );
    if (r.acquired) return r.value;
    if (Date.now() >= deadline) return { restored: 0, counters: 0 };
    await Bun.sleep(200);
  }
}
