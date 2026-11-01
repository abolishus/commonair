// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The moved notice (ADR 0037 decision 3, batch 7 decision (l)). On `channel.moved` the outbox hook
 * enqueues `PORTABILITY_JOBS.moved`; this sends each holder of a "tell me if they move" grant on
 * that channel **one** `channelMoved` email (on the `moved` unsubscribe list, with List-Unsubscribe),
 * then deletes the grant. The streamer never sees who held one.
 *
 * One transaction per grant: the row is locked (`for update skip locked`, so two runs never send
 * twice), the mail is sent, then the row is deleted. A commit failure after a send can repeat one
 * email; it can never lose one. A grant whose holder was deleted, has no verified address, or is
 * the streamer is dropped without a mail. A move cleared before the job runs sends nothing and
 * keeps the grants.
 */
import { EMAIL_UNSUBSCRIBE_PATH } from "@commonair/contracts/notify";
import type { Mailer } from "@commonair/email";
import { schema } from "@commonair/db";
import { signUnsubscribeToken } from "@commonair/tokens";
import { and, asc, eq, gt } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";

const { followPortabilityGrants: grants, channels, users } = schema;

/** Grants handled per page; the job loops until none are left. */
export const MOVED_PAGE = 100;
/** Where the email's settings link points (the grants section lives there). */
export const PRIVACY_SETTINGS_PATH = "/settings/privacy";

/** `channelMoved`'s data (`packages/email/src/templates/portability.tsx`). */
export interface ChannelMovedMail {
  channelName: string;
  movedToHost: string;
  channelUrl: string;
  settingsUrl: string;
  unsubscribeUrl: string;
  locale: string | null;
}

/**
 * The template id is registered in `packages/email/src/registry.ts` by the orchestrator (a contract
 * request of W3-portability); typed loosely here so this module does not depend on that edit.
 */
function sendChannelMoved(mailer: Mailer, data: ChannelMovedMail, to: string): Promise<string> {
  const send = mailer.send.bind(mailer) as unknown as (t: string, d: ChannelMovedMail, to: string) => Promise<string>;
  return send("channelMoved", data, to);
}

export interface MovedResult {
  sent: number;
  dropped: number;
  failed: number;
}

/** The host of the destination, for the email's text (never the full address). */
export function movedHost(movedTo: string): string {
  try {
    return new URL(movedTo).hostname;
  } catch {
    return "";
  }
}

export async function sendMovedNotices(ctx: WorkerContext, channelId: string): Promise<MovedResult> {
  const out: MovedResult = { sent: 0, dropped: 0, failed: 0 };
  const [c] = await ctx.db
    .select({
      slug: channels.slug,
      displayName: channels.displayName,
      ownerId: channels.ownerId,
      movedTo: channels.movedTo,
    })
    .from(channels)
    .where(eq(channels.id, channelId));
  if (!c || !c.movedTo) return out;
  const movedTo = c.movedTo;
  const { mailer, site } = ctx;
  if (!mailer || !site) throw new Error("the moved notice needs the mailer and the instance site");
  const base = site.publicUrl.replace(/\/+$/, "");

  // Users already handled in this run (a failed send stays for the retry, not this loop).
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const page = await ctx.db
      .select({ userId: grants.userId })
      .from(grants)
      .where(and(eq(grants.channelId, channelId), gt(grants.userId, after)))
      .orderBy(asc(grants.userId))
      .limit(MOVED_PAGE);
    if (page.length === 0) break;
    for (const { userId } of page) {
      after = userId;
      const outcome = await ctx.db.transaction(async (tx) => {
        const [g] = await tx
          .select({ userId: grants.userId })
          .from(grants)
          .where(and(eq(grants.channelId, channelId), eq(grants.userId, userId)))
          .for("update", { skipLocked: true });
        if (!g) return "gone" as const;
        const [u] = await tx
          .select({
            email: users.email,
            emailVerified: users.emailVerified,
            locale: users.locale,
            deletedAt: users.deletedAt,
          })
          .from(users)
          .where(eq(users.id, userId));
        const drop = !u || u.deletedAt !== null || !u.emailVerified || userId === c.ownerId;
        if (!drop) {
          const token = await signUnsubscribeToken(ctx.webhooks.authSecret, userId, "moved");
          try {
            await sendChannelMoved(
              mailer,
              {
                channelName: c.displayName,
                movedToHost: movedHost(movedTo),
                channelUrl: `${base}/${encodeURIComponent(c.slug)}`,
                settingsUrl: `${base}${PRIVACY_SETTINGS_PATH}`,
                unsubscribeUrl: `${base}${EMAIL_UNSUBSCRIBE_PATH}?list=moved&token=${encodeURIComponent(token)}`,
                locale: u.locale,
              },
              u.email,
            );
          } catch (err) {
            // The grant stays for the job's retry; never log the address.
            ctx.logger.warn("moved notice send failed", {
              channelId,
              userId,
              error: err instanceof Error ? err.name : "unknown",
            });
            return "failed" as const;
          }
        }
        await tx.delete(grants).where(and(eq(grants.channelId, channelId), eq(grants.userId, userId)));
        return drop ? ("dropped" as const) : ("sent" as const);
      });
      if (outcome === "sent") out.sent++;
      else if (outcome === "dropped") out.dropped++;
      else if (outcome === "failed") out.failed++;
    }
  }
  ctx.logger.info("moved notices sent", { channelId, ...out });
  return out;
}
