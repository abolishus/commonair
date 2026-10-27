// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Platform suspensions of a user or channel, shared by `safety.suspend`, report resolution, the
 * DMCA repeat-infringer policy and appeals. Lifting a DMCA suspension goes through
 * `liftDmcaSuspensionInTx` in `@commonair/db`, never through `setSuspension(…, false, …)`.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, type Executor } from "@commonair/db";
import { badRequest, forbidden, pgCode } from "../lib/errors.ts";
import { endLiveInTx, type EndedBroadcast } from "./live.ts";

const { users, channels } = schema;

/** Written to `users.ban_reason` and `channels.suspended_reason`. */
export type SuspensionReason = "moderation" | "dmca_repeat_infringer";

/** Suspend or unsuspend; the T0 trigger refuses lifting a T0 suspension (→ FORBIDDEN). */
export async function setSuspension(
  tx: Executor,
  target: { userId: string; channelId: string | null },
  kind: "user" | "channel",
  suspended: boolean,
  now: Date,
  durationSeconds: number | undefined,
  reason: SuspensionReason = "moderation",
): Promise<{ changed: boolean; ended: EndedBroadcast | null }> {
  try {
    if (kind === "user") {
      const rows = await tx
        .update(users)
        .set(
          suspended
            ? {
                banned: true,
                banReason: reason,
                banExpires: durationSeconds ? new Date(now.getTime() + durationSeconds * 1000) : null,
              }
            : { banned: false, banReason: null, banExpires: null },
        )
        .where(
          and(
            eq(users.id, target.userId),
            suspended ? sql`not (${users.banned} and ${users.banReason} = 't0_hash_match')` : eq(users.banned, true),
          ),
        )
        .returning({ id: users.id });
      return { changed: rows.length > 0, ended: null };
    }
    if (!target.channelId) throw badRequest("This account has no channel");
    const rows = await tx
      .update(channels)
      .set(suspended ? { suspendedAt: now, suspendedReason: reason } : { suspendedAt: null, suspendedReason: null })
      .where(
        and(
          eq(channels.id, target.channelId),
          suspended ? isNull(channels.suspendedAt) : sql`${channels.suspendedAt} is not null`,
        ),
      )
      .returning({ id: channels.id });
    const ended = suspended ? await endLiveInTx(tx, target.channelId, now) : null;
    return { changed: rows.length > 0, ended };
  } catch (err) {
    if (pgCode(err) === "42501") throw forbidden("A suspension from a T0 match is lifted only by dismissing its case");
    throw err;
  }
}
