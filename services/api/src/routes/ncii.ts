// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `ncii.*`: the public NCII takedown form (TAKE IT DOWN Act) and its staff queue
 * (docs/testing/e4c-selectors.md "NCII request", "NCII decision").
 *
 * The 48-hour clock is the database's: `received_at` is set by the trigger from the database
 * clock and `deadline_at = received_at + 48 h` is fixed there, so nothing here can shorten or
 * extend it. Requester data (name, email, signature, description, URLs) stays on the request
 * rows: it never reaches a log, an audit row, an event or a notification.
 */
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { schema, type Executor } from "@commonair/db";
import { verifyAltcha } from "../auth/altcha.ts";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { emit } from "../events/outbox.ts";
import { iso, isoOrNull } from "../lib/dto.ts";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.ts";
import { instanceMediaBase } from "../lib/media-ref.ts";
import { decodeCursor, encodeCursor, isOffsetCursor } from "../lib/cursor.ts";
import { os, requireCaller } from "../lib/orpc.ts";
import { afterBroadcastEnded, endBroadcastInTx, type EndedBroadcast } from "../moderation/live.ts";
import { resolveContentUrl, type InstanceHosts } from "../moderation/ncii-urls.ts";
import { notifyRoles } from "../moderation/notify.ts";
import { staffActorType } from "../moderation/review.ts";
import { moderationRuntime } from "../moderation/runtime.ts";
import { lockUploadReference } from "../moderation/committed.ts";

const { nciiRequests, nciiRequestItems, vods, clips, channels, channelPanels, emotes, users } = schema;
type RequestRow = typeof nciiRequests.$inferSelect;
type ItemRow = typeof nciiRequestItems.$inferSelect;

export function instanceHosts(deps: Deps): InstanceHosts {
  const origins = new Set<string>();
  for (const u of [deps.site.publicUrl, deps.env.API_PUBLIC_URL, ...deps.env.AUTH_TRUSTED_ORIGINS])
    try {
      origins.add(new URL(u).origin);
    } catch {
      // not a URL: ignore
    }
  return { origins: [...origins], mediaBase: instanceMediaBase(deps.env) };
}

const toItem = (i: ItemRow) => ({
  id: i.id,
  url: i.url,
  subjectType: i.subjectType,
  subjectId: i.subjectId,
  hiddenAt: isoOrNull(i.hiddenAt),
  removedAt: isoOrNull(i.removedAt),
});

const toRequest = (r: RequestRow, items: ItemRow[]) => ({
  id: r.id,
  status: r.status,
  requesterName: r.requesterName,
  requesterEmail: r.requesterEmail,
  relationship: r.relationship,
  description: r.description,
  signature: r.signature,
  items: items.map(toItem),
  receivedAt: iso(r.receivedAt),
  deadlineAt: iso(r.deadlineAt),
  escalated24At: isoOrNull(r.escalated24At),
  escalated36At: isoOrNull(r.escalated36At),
  autoHiddenAt: isoOrNull(r.autoHiddenAt),
  decidedAt: isoOrNull(r.decidedAt),
  decisionNote: r.decisionNote,
});

async function itemsOf(db: Executor, ids: string[]): Promise<Map<string, ItemRow[]>> {
  const out = new Map<string, ItemRow[]>();
  if (ids.length === 0) return out;
  const rows = await db
    .select()
    .from(nciiRequestItems)
    .where(inArray(nciiRequestItems.requestId, ids))
    .orderBy(asc(nciiRequestItems.id));
  for (const r of rows) out.set(r.requestId, [...(out.get(r.requestId) ?? []), r]);
  return out;
}

/** Drop every reference to an upload key from the channel (theme, panels, emotes). */
async function clearUploadReferences(tx: Executor, channelId: string, key: string, mediaBase: string): Promise<void> {
  await tx
    .update(channels)
    .set({
      theme: sql`case
        when ${channels.theme}->>'avatarKey' = ${key} then ${channels.theme} - 'avatarKey'
        else ${channels.theme} end`,
    })
    .where(eq(channels.id, channelId));
  await tx
    .update(channels)
    .set({
      theme: sql`case
        when ${channels.theme}->>'bannerKey' = ${key} then ${channels.theme} - 'bannerKey'
        else ${channels.theme} end`,
    })
    .where(eq(channels.id, channelId));
  await tx
    .update(channelPanels)
    .set({ imageKey: null })
    .where(and(eq(channelPanels.channelId, channelId), eq(channelPanels.imageKey, key)));
  await tx.delete(emotes).where(and(eq(emotes.channelId, channelId), eq(emotes.imageKey, key)));
  await tx
    .update(users)
    .set({ image: null })
    .where(or(eq(users.image, key), eq(users.image, `${mediaBase}${key}`)));
}

/** Unpublish one resolved item for a `removed` decision. Content removed by T0 stays as it is. */
async function removeItem(tx: Executor, item: ItemRow, now: Date, mediaBase: string): Promise<EndedBroadcast | null> {
  let ended: EndedBroadcast | null = null;
  switch (item.subjectType) {
    case "vod":
      if (item.subjectId)
        await tx
          .update(vods)
          .set({ status: "deleted", removedReason: "ncii" })
          .where(and(eq(vods.id, item.subjectId), ne(vods.status, "deleted")));
      break;
    case "clip":
      if (item.subjectId)
        await tx
          .update(clips)
          .set({ status: "deleted", removedReason: "ncii" })
          .where(and(eq(clips.id, item.subjectId), ne(clips.status, "deleted")));
      break;
    case "broadcast": {
      if (!item.subjectId) break;
      const [b] = await tx
        .select({ channelId: schema.broadcasts.channelId })
        .from(schema.broadcasts)
        .where(eq(schema.broadcasts.id, item.subjectId));
      if (b) ended = await endBroadcastInTx(tx, b.channelId, item.subjectId, now);
      // The broadcast's recordings go with it.
      await tx
        .update(vods)
        .set({ status: "deleted", removedReason: "ncii" })
        .where(and(eq(vods.broadcastId, item.subjectId), ne(vods.status, "deleted")));
      await tx
        .update(clips)
        .set({ status: "deleted", removedReason: "ncii" })
        .where(and(eq(clips.broadcastId, item.subjectId), ne(clips.status, "deleted")));
      break;
    }
    case "upload":
      if (item.subjectId && item.uploadKey) {
        await lockUploadReference(tx, item.uploadKey);
        await clearUploadReferences(tx, item.subjectId, item.uploadKey, mediaBase);
      }
      break;
    case null:
      break;
  }
  if (item.subjectType)
    await tx.update(nciiRequestItems).set({ removedAt: now }).where(eq(nciiRequestItems.id, item.id));
  return ended;
}

export const ncii = {
  submit: os.ncii.submit.handler(async ({ context, input }) => {
    const { deps } = context;
    const failure = await verifyAltcha(input.altcha, {
      hmacKey: deps.env.ALTCHA_HMAC_KEY,
      now: () => deps.now().getTime(),
      valkey: deps.valkey,
    });
    if (failure) throw badRequest("The verification challenge failed; reload the form and try again");
    const hosts = instanceHosts(deps);
    const urls = [...new Set(input.contentUrls)];
    const resolved = await Promise.all(urls.map((u) => resolveContentUrl(deps.db, u, hosts)));
    const row = await deps.db.transaction(async (tx) => {
      const [r] = await tx
        .insert(nciiRequests)
        .values({
          requesterName: input.requesterName,
          requesterEmail: input.requesterEmail,
          relationship: input.relationship,
          contentUrls: urls,
          description: input.description,
          goodFaith: input.goodFaith,
          signature: input.signature,
          // Placeholders: the trigger sets both from the database clock.
          receivedAt: new Date(0),
          deadlineAt: new Date(0),
        })
        .returning();
      if (!r) throw new Error("ncii insert returned no row");
      await tx.insert(nciiRequestItems).values(
        resolved.map((i) => ({
          requestId: r.id,
          url: i.url,
          subjectType: i.subjectType,
          subjectId: i.subjectId,
          uploadKey: i.uploadKey,
        })),
      );
      const resolvedCount = resolved.filter((i) => i.subjectType !== null).length;
      await audit(tx, {
        actorType: "system",
        actorId: null,
        action: "ncii.received",
        subjectType: "ncii_request",
        subjectId: r.id,
        details: { requestId: r.id, items: resolved.length, resolvedItems: resolvedCount },
      });
      await emit(tx, "ncii.request.received", null, {
        request_id: r.id,
        deadline_at: iso(r.deadlineAt),
        items: resolved.length,
        resolved_items: resolvedCount,
      });
      await notifyRoles(tx, ["moderator", "admin", "legal"], {
        kind: "ncii_request",
        requestId: r.id,
        deadlineAt: iso(r.deadlineAt),
      });
      return r;
    });
    return { id: row.id, deadlineAt: iso(row.deadlineAt) };
  }),

  queue: os.ncii.queue.handler(async ({ context, input }) => {
    const { deps } = context;
    const offset = decodeCursor(input.cursor, isOffsetCursor)?.o ?? 0;
    const undecided = input.status === undefined || input.status === "received" || input.status === "auto_hidden";
    const rows = await deps.db
      .select()
      .from(nciiRequests)
      .where(input.status ? eq(nciiRequests.status, input.status) : isNull(nciiRequests.decidedAt))
      // Undecided requests are worked by deadline; decided ones browsed newest first.
      .orderBy(...(undecided ? [asc(nciiRequests.deadlineAt)] : [desc(nciiRequests.decidedAt)]), asc(nciiRequests.id))
      .limit(input.limit + 1)
      .offset(offset);
    const page = rows.slice(0, input.limit);
    const items = await itemsOf(
      deps.db,
      page.map((r) => r.id),
    );
    return {
      items: page.map((r) => toRequest(r, items.get(r.id) ?? [])),
      nextCursor: rows.length > input.limit ? encodeCursor({ o: offset + input.limit }) : null,
    };
  }),

  decide: os.ncii.decide.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const rt = await moderationRuntime(deps);
    const now = deps.now();
    const result = await deps.db.transaction(async (tx) => {
      const [r] = await tx.select().from(nciiRequests).where(eq(nciiRequests.id, input.id)).for("update");
      if (!r) throw notFound("Request not found");
      // Repeating a `removed` decision re-sends the hash job (idempotent id) and changes nothing
      // else, so a lost enqueue can always be retried.
      if (r.decidedAt && r.status === "removed" && input.decision === "removed")
        return {
          updated: r,
          items: await tx.select().from(nciiRequestItems).where(eq(nciiRequestItems.requestId, r.id)),
          ended: [] as EndedBroadcast[],
        };
      if (r.decidedAt) throw conflict("This request is already decided");
      const items = await tx.select().from(nciiRequestItems).where(eq(nciiRequestItems.requestId, r.id));
      // A staff member never decides a request about their own content.
      const channelIds = new Set<string>();
      for (const i of items) {
        if (i.subjectType === "upload" && i.subjectId) channelIds.add(i.subjectId);
        if (i.subjectType === "vod" && i.subjectId) {
          const [v] = await tx.select({ c: vods.channelId }).from(vods).where(eq(vods.id, i.subjectId));
          if (v) channelIds.add(v.c);
        }
        if (i.subjectType === "clip" && i.subjectId) {
          const [c] = await tx.select({ c: clips.channelId }).from(clips).where(eq(clips.id, i.subjectId));
          if (c) channelIds.add(c.c);
        }
        if (i.subjectType === "broadcast" && i.subjectId) {
          const [b] = await tx
            .select({ c: schema.broadcasts.channelId })
            .from(schema.broadcasts)
            .where(eq(schema.broadcasts.id, i.subjectId));
          if (b) channelIds.add(b.c);
        }
      }
      if (channelIds.size > 0) {
        const own = await tx
          .select({ id: channels.id })
          .from(channels)
          .where(and(inArray(channels.id, [...channelIds]), eq(channels.ownerId, caller.user.id)))
          .limit(1);
        if (own.length > 0) throw forbidden("You cannot decide a request about your own content");
      }
      const [updated] = await tx
        .update(nciiRequests)
        .set({ status: input.decision, decidedAt: now, decidedById: caller.user.id, decisionNote: input.note })
        .where(and(eq(nciiRequests.id, r.id), isNull(nciiRequests.decidedAt)))
        .returning();
      if (!updated) throw conflict("This request is already decided");
      const ended: EndedBroadcast[] = [];
      if (input.decision === "removed")
        for (const i of items) {
          const e = await removeItem(tx, i, now, instanceMediaBase(deps.env));
          if (e) ended.push(e);
        }
      await audit(tx, {
        actorType: staffActorType(caller.user.role),
        actorId: caller.user.id,
        action: "ncii.decide",
        subjectType: "ncii_request",
        subjectId: r.id,
        reason: input.note,
        details: {
          requestId: r.id,
          decision: input.decision,
          items: items.length,
          removedItems: input.decision === "removed" ? items.filter((i) => i.subjectType !== null).length : 0,
        },
      });
      await emit(tx, "ncii.request.decided", null, { request_id: r.id, decision: input.decision });
      return {
        updated,
        items: await tx.select().from(nciiRequestItems).where(eq(nciiRequestItems.requestId, r.id)),
        ended,
      };
    });
    for (const e of result.ended) await afterBroadcastEnded(deps, e);
    // The worker hashes the removed content into the block list, then deletes the objects.
    if (input.decision === "removed") {
      try {
        await rt.queue.nciiHash({ requestId: result.updated.id });
      } catch (err) {
        deps.logger.error("ncii-hash enqueue failed", { requestId: result.updated.id, err: (err as Error).name });
        throw err;
      }
    }
    return toRequest(result.updated, result.items);
  }),
};
