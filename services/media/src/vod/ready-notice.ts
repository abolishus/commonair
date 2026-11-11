// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The owner's "Your video is ready" inbox row (overhaul wave 3, D5.3, ux-journeys J2-f), written by
 * `finalizeVod` inside the transaction that moves the VOD from `processing` to `ready`.
 *
 * Never twice, by two guards: that transition happens once (the row is locked `for update` and the
 * update is conditional on `processing`; nothing moves a VOD back to `processing` once it is
 * ready), so a retried or concurrent job that lost the race never reaches this; and the row's
 * `dedupe_key` (unique per user) makes a second insert a no-op even if it did.
 *
 * In-app only: no email or push until D7 adds a `creator` notification preference. A rehearsal's
 * VOD gets no row (it is private, kept 24 h, and the owner is already in the studio watching it),
 * nor does one another flow hides (`leave` placement: NCII, DMCA).
 */
import { eq } from "drizzle-orm";
import { VodReadyNotificationPayload } from "@commonair/contracts/notify";
import { schema, type Executor } from "@commonair/db";

/** `notifications.dedupe_key` of a VOD's ready notice. */
export const vodReadyKey = (vodId: string) => `vod-ready-${vodId}`;

/** The longest title the payload carries (`VodReadyNotificationPayload`, in UTF-16 units). */
const TITLE_MAX = 140;

/** `title` cut to `TITLE_MAX` without splitting a surrogate pair. */
export function payloadTitle(title: string): string {
  let out = "";
  for (const cp of title) {
    if (out.length + cp.length > TITLE_MAX) break;
    out += cp;
  }
  return out;
}

/** Insert the notice for a VOD that just became ready. True when a row was written. */
export async function vodReadyNoticeTx(tx: Executor, vodId: string, now: Date): Promise<boolean> {
  const [row] = await tx
    .select({
      title: schema.vods.title,
      broadcastId: schema.vods.broadcastId,
      kind: schema.broadcasts.kind,
      slug: schema.channels.slug,
      ownerId: schema.channels.ownerId,
    })
    .from(schema.vods)
    .innerJoin(schema.broadcasts, eq(schema.broadcasts.id, schema.vods.broadcastId))
    .innerJoin(schema.channels, eq(schema.channels.id, schema.vods.channelId))
    .where(eq(schema.vods.id, vodId));
  if (!row || row.kind === "rehearsal") return false;
  const payload = VodReadyNotificationPayload.parse({
    vodId,
    broadcastId: row.broadcastId,
    slug: row.slug,
    title: payloadTitle(row.title),
  });
  const written = await tx
    .insert(schema.notifications)
    .values({ userId: row.ownerId, type: "vod_ready", payload, dedupeKey: vodReadyKey(vodId), createdAt: now })
    .onConflictDoNothing()
    .returning({ id: schema.notifications.id });
  return written.length > 0;
}
