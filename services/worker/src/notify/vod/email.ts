// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Your video is ready" by email (overhaul wave 4, D7.3; ux-journeys J2-f): the creator
 * preference's email medium, off by default. The trigger is the `vod_ready` inbox row the media
 * service writes once per VOD (`services/media/src/vod/ready-notice.ts`: never for a rehearsal or
 * a video another flow hides), so this sweep needs no hook of its own: every minute it reads the
 * rows written in the last `VOD_EMAIL_WINDOW_MS` and mails each one at most once, claimed by a
 * Valkey key (`SET NX`, kept a day) so concurrent replicas and the next sweep skip it. A failed
 * send drops the claim, so a later sweep in the window tries again.
 */
import { NOTIFICATION_SETTINGS_PATH, VodReadyNotificationPayload } from "@commonair/contracts/notify";
import { schema } from "@commonair/db";
import { and, asc, eq, gte } from "drizzle-orm";
import type { WorkerContext } from "../../context.ts";
import { preferenceEnabled, unsubscribeUrl } from "../email/prefs.ts";

/** Rows newer than this are considered; older ones were handled (or their window passed). */
export const VOD_EMAIL_WINDOW_MS = 30 * 60_000;
/** The sweep's period. */
export const VOD_EMAIL_SWEEP_MS = 60_000;
/** How long a claim is kept: well past the window. */
export const VOD_EMAIL_CLAIM_SECONDS = 86_400;
/** Rows per sweep; a burst beyond it waits for the next sweep. */
export const VOD_EMAIL_BATCH = 500;

export const vodEmailClaimKey = (notificationId: string) => `notify:vod-ready-email:${notificationId}`;

export interface VodEmailResult {
  seen: number;
  sent: number;
}

export async function sweepVodReadyEmails(ctx: WorkerContext): Promise<VodEmailResult> {
  const result: VodEmailResult = { seen: 0, sent: 0 };
  const { mailer, site } = ctx;
  if (!mailer || !site) return result;
  const n = schema.notifications;
  const rows = await ctx.db
    .select({ id: n.id, userId: n.userId, payload: n.payload })
    .from(n)
    .where(and(eq(n.type, "vod_ready"), gte(n.createdAt, new Date(ctx.now().getTime() - VOD_EMAIL_WINDOW_MS))))
    .orderBy(asc(n.createdAt))
    .limit(VOD_EMAIL_BATCH);
  for (const row of rows) {
    result.seen++;
    const parsed = VodReadyNotificationPayload.safeParse(row.payload);
    if (!parsed.success) continue;
    const key = vodEmailClaimKey(row.id);
    const claimed = await ctx.valkey.set(key, "1", "EX", VOD_EMAIL_CLAIM_SECONDS, "NX");
    if (claimed !== "OK") continue;
    try {
      if (await sendOne(ctx, row.userId, parsed.data)) result.sent++;
    } catch (err) {
      await ctx.valkey.del(key).catch(() => undefined);
      // Never log the address.
      ctx.logger.warn("video-ready email failed", {
        userId: row.userId,
        vodId: parsed.data.vodId,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  return result;
}

async function sendOne(ctx: WorkerContext, userId: string, p: VodReadyNotificationPayload): Promise<boolean> {
  const { mailer, site } = ctx;
  if (!mailer || !site) return false;
  const [user] = await ctx.db
    .select({
      email: schema.users.email,
      emailVerified: schema.users.emailVerified,
      locale: schema.users.locale,
      accountType: schema.users.accountType,
      deletedAt: schema.users.deletedAt,
      pseudonymizedAt: schema.users.pseudonymizedAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!user || !user.emailVerified || user.accountType !== "human" || user.deletedAt || user.pseudonymizedAt)
    return false;
  if (!(await preferenceEnabled(ctx.db, userId, "creator", "email"))) return false;
  // Still there and ready (it may have been removed since the row was written).
  const [vod] = await ctx.db
    .select({ status: schema.vods.status })
    .from(schema.vods)
    .where(eq(schema.vods.id, p.vodId));
  if (vod?.status !== "ready") return false;
  const base = site.publicUrl.replace(/\/+$/, "");
  await mailer.send(
    "vodReady",
    {
      title: p.title,
      videoUrl: `${base}/${encodeURIComponent(p.slug)}/vods/${p.vodId}`,
      settingsUrl: `${base}${NOTIFICATION_SETTINGS_PATH}`,
      unsubscribeUrl: await unsubscribeUrl(site.publicUrl, ctx.webhooks.authSecret, userId, "creator"),
      locale: user.locale,
    },
    user.email,
  );
  return true;
}
