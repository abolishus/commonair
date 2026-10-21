// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared writes for automated moderation actions, always inside the caller's transaction: the
 * `audit_log` row (actor `system`), validated `events` rows, ending a live broadcast and hiding
 * content. Details and payloads carry ids, enums, scores and versions only (AGENTS.md: no personal
 * data in append-only columns).
 */
import { EVENTS, type EventPayload, type EventType } from "@commonair/contracts/events";
import type { PLATFORM_ROLES } from "@commonair/contracts/enums";
import { schema, uuidv7, type Executor } from "@commonair/db";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { moderationMetrics } from "./metrics.ts";

const { auditLog, events, broadcasts, channels, playbackSessions, vods, clips, notifications, users } = schema;

export interface AuditInput {
  action: string;
  subjectType: string;
  subjectId: string;
  channelId?: string | null;
  reason?: string;
  details: Record<string, unknown>;
  /** Defaults to `system`; a job applying a `legal` user's decision records that user. */
  actorType?: "system" | "admin" | "moderator";
  actorId?: string | null;
}

export async function audit(tx: Executor, a: AuditInput, now: Date): Promise<string> {
  const id = uuidv7(now.getTime());
  await tx.insert(auditLog).values({
    id,
    actorType: a.actorType ?? "system",
    actorId: a.actorId ?? null,
    action: a.action,
    subjectType: a.subjectType,
    subjectId: a.subjectId,
    channelId: a.channelId ?? null,
    reason: a.reason ?? "",
    details: a.details,
    createdAt: now,
  });
  return id;
}

/** One outbox row, its payload validated against the catalog first (a bad payload throws and rolls back). */
export async function emit<T extends EventType>(
  tx: Executor,
  type: T,
  channelId: string | null,
  payload: EventPayload<T>,
  now: Date,
): Promise<void> {
  const def = EVENTS[type];
  const parsed = def.payload.parse(payload) as Record<string, unknown>;
  await tx.insert(events).values({
    id: uuidv7(now.getTime()),
    type,
    version: def.version,
    channelId,
    payload: parsed,
    occurredAt: now,
  });
}

/**
 * An operational alert: an `error` (or `fatal`) log line with `alert: <name>` that the log
 * pipeline routes to operators, plus a counter. Fields are ids, counts and versions only.
 */
export function alert(
  ctx: Pick<WorkerContext, "logger">,
  name: string,
  msg: string,
  fields: Record<string, unknown> = {},
  level: "error" | "fatal" = "error",
) {
  moderationMetrics.alerts.add(1, { alert: name });
  ctx.logger[level](msg, { alert: name, ...fields });
}

/** Error metadata may contain object keys, URLs, SQL, or request data; expose only a safe code. */
export function safeErrorCode(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code)) return code;
  }
  return err instanceof Error ? "Error" : "UnknownError";
}

/** Rebuild a committed T0 offline notification target so a queue retry can publish it again. */
export async function endedBroadcastForCase(tx: Executor, caseId: string): Promise<EndedBroadcast | null> {
  const rows = await tx
    .select({ details: auditLog.details })
    .from(auditLog)
    .where(and(eq(auditLog.subjectType, "moderation_case"), eq(auditLog.subjectId, caseId)))
    .orderBy(sql`${auditLog.createdAt} asc`);
  const broadcastId = rows
    .map((row) => row.details)
    .find(
      (details) =>
        typeof details === "object" &&
        details !== null &&
        "broadcastEnded" in details &&
        typeof details.broadcastEnded === "string",
    );
  const id =
    typeof broadcastId === "object" && broadcastId !== null && "broadcastEnded" in broadcastId
      ? broadcastId.broadcastEnded
      : null;
  if (typeof id !== "string") return null;
  const [broadcast] = await tx
    .select({ id: broadcasts.id, channelId: broadcasts.channelId, path: broadcasts.path })
    .from(broadcasts)
    .where(eq(broadcasts.id, id));
  if (!broadcast) return null;
  const [channel] = await tx.select({ slug: channels.slug }).from(channels).where(eq(channels.id, broadcast.channelId));
  return channel
    ? { broadcastId: broadcast.id, channelId: broadcast.channelId, path: broadcast.path, slug: channel.slug }
    : null;
}

type PlatformRole = (typeof PLATFORM_ROLES)[number];

/** One `notifications` row (type `moderation`) per active user holding any of `roles`. Payload: ids only. */
export async function notifyRoles(
  tx: Executor,
  roles: readonly PlatformRole[],
  payload: Record<string, unknown>,
  now: Date,
): Promise<number> {
  const staff = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.role, [...roles]), isNull(users.deletedAt)));
  if (staff.length === 0) return 0;
  await tx
    .insert(notifications)
    .values(staff.map((u) => ({ id: uuidv7(now.getTime()), userId: u.id, type: "moderation" as const, payload })));
  return staff.length;
}

export interface EndedBroadcast {
  broadcastId: string;
  channelId: string;
  slug: string;
  path: string;
}

/**
 * End a broadcast if it is still live, as the API's not-ready hook does: `ended_at`, the
 * channel's live pointer, open playback sessions and `stream.offline`. Media already kicked
 * the publisher; a later not-ready hook finds nothing live and does nothing.
 */
export async function endBroadcast(tx: Executor, broadcastId: string, now: Date): Promise<EndedBroadcast | null> {
  const [b] = await tx
    .update(broadcasts)
    .set({ endedAt: now })
    .where(and(eq(broadcasts.id, broadcastId), isNull(broadcasts.endedAt)))
    .returning({ id: broadcasts.id, channelId: broadcasts.channelId, path: broadcasts.path });
  if (!b) return null;
  const [c] = await tx
    .update(channels)
    .set({ liveBroadcastId: null })
    .where(and(eq(channels.id, b.channelId), eq(channels.liveBroadcastId, b.id)))
    .returning();
  const channel = c ?? (await tx.select().from(channels).where(eq(channels.id, b.channelId)))[0];
  if (!channel) throw new Error("broadcast references a missing channel");
  await tx
    .update(playbackSessions)
    .set({ endedAt: now })
    .where(and(eq(playbackSessions.broadcastId, b.id), isNull(playbackSessions.endedAt)));
  await emit(
    tx,
    "stream.offline",
    channel.id,
    {
      broadcaster_user_id: channel.ownerId,
      broadcaster_user_login: channel.slug,
      broadcaster_user_name: channel.displayName,
    },
    now,
  );
  return { broadcastId: b.id, channelId: channel.id, slug: channel.slug, path: b.path };
}

export interface HiddenContent {
  vodIds: string[];
  clipIds: string[];
}

/**
 * Set VODs and clips `deleted` with `reason`. Rows already deleted keep their status and reason
 * (a T0 removal in particular is never overwritten; the database refuses that anyway).
 */
export async function hideContent(
  tx: Executor,
  target: { vodIds?: readonly string[]; clipIds?: readonly string[]; broadcastId?: string },
  reason: string,
): Promise<HiddenContent> {
  const vodWhere = [
    ...(target.vodIds?.length ? [inArray(vods.id, [...target.vodIds])] : []),
    ...(target.broadcastId ? [eq(vods.broadcastId, target.broadcastId)] : []),
  ];
  const hiddenVods =
    vodWhere.length === 0
      ? []
      : await tx
          .update(vods)
          .set({ status: "deleted", removedReason: reason })
          .where(and(or(...vodWhere), ne(vods.status, "deleted")))
          .returning({ id: vods.id });
  // Clips cut from those VODs carry the same content, and so do clips of the same broadcasts cut
  // from the live buffer (they have no vod_id).
  const allVodIds = [
    ...new Set([
      ...(target.vodIds ?? []),
      ...(target.broadcastId
        ? (await tx.select({ id: vods.id }).from(vods).where(eq(vods.broadcastId, target.broadcastId))).map((v) => v.id)
        : []),
    ]),
  ];
  const vodBroadcastIds = target.vodIds?.length
    ? (
        await tx
          .select({ b: vods.broadcastId })
          .from(vods)
          .where(inArray(vods.id, [...target.vodIds]))
      ).map((v) => v.b)
    : [];
  const broadcastIds = [...new Set([...(target.broadcastId ? [target.broadcastId] : []), ...vodBroadcastIds])];
  const clipWhere = [
    ...(target.clipIds?.length ? [inArray(clips.id, [...target.clipIds])] : []),
    ...(broadcastIds.length ? [inArray(clips.broadcastId, broadcastIds)] : []),
    ...(allVodIds.length ? [inArray(clips.vodId, allVodIds)] : []),
  ];
  const hiddenClips =
    clipWhere.length === 0
      ? []
      : await tx
          .update(clips)
          .set({ status: "deleted", removedReason: reason })
          .where(and(or(...clipWhere), ne(clips.status, "deleted")))
          .returning({ id: clips.id });
  return { vodIds: hiddenVods.map((v) => v.id), clipIds: hiddenClips.map((c) => c.id) };
}

/**
 * Clear every reference to an uploaded object (channel avatar/banner, panel image, emote, user
 * image). References may be stored as the key or as a URL ending in it.
 */
export async function clearUploadReferences(tx: Executor, key: string): Promise<number> {
  let cleared = 0;
  const like = `%${key.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}`;
  for (const field of ["avatarKey", "bannerKey"] as const) {
    const rows = await tx
      .update(channels)
      .set({ theme: sql`${channels.theme} - ${field}::text` })
      .where(sql`${channels.theme}->>${field}::text like ${like}`)
      .returning({ id: channels.id });
    cleared += rows.length;
  }
  cleared += (
    await tx
      .update(schema.channelPanels)
      .set({ imageKey: null })
      .where(sql`${schema.channelPanels.imageKey} like ${like}`)
      .returning({ id: schema.channelPanels.id })
  ).length;
  cleared += (
    await tx
      .delete(schema.emotes)
      .where(sql`${schema.emotes.imageKey} like ${like}`)
      .returning({ id: schema.emotes.id })
  ).length;
  cleared += (
    await tx
      .update(users)
      .set({ image: null })
      .where(sql`${users.image} like ${like}`)
      .returning({ id: users.id })
  ).length;
  return cleared;
}
