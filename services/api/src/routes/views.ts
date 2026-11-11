// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `vods.recordView` and `clips.recordView` (overhaul wave 3, D5.5): the web calls them once a
 * video or clip actually starts playing. Only an item the caller may watch right now counts: the
 * same visibility rules as `vods.get` / `clips.get`, plus playable (ready, not withheld behind the
 * mature gate, servable). Anything else reads as NOT_FOUND, so nothing leaks about hidden items.
 * Dedupe and counting live in `media-views/record.ts`; a repeat play answers Ok, not counted.
 */
import { and, eq } from "drizzle-orm";
import { schema } from "@commonair/db";
import { notFound } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";
import type { Caller } from "../lib/access.ts";
import type { RequestInfo } from "../lib/orpc.ts";
import { recordMediaView, type Viewer } from "../media-views/record.ts";
import { clipVisible, urlsWithheld, viewerAudience, vodShown } from "../media/visibility.ts";

const { broadcasts, channels, clips, vods } = schema;

const viewerOf = (caller: Caller | null, req: RequestInfo): Viewer =>
  caller ? { userId: caller.user.id } : { ip: req.ip };

export const vodViews = {
  recordView: os.vods.recordView.handler(async ({ context, input }) => {
    const { deps } = context;
    const [row] = await deps.db
      .select({ v: vods, channel: channels, b: broadcasts })
      .from(vods)
      .innerJoin(broadcasts, eq(broadcasts.id, vods.broadcastId))
      .innerJoin(channels, eq(channels.id, vods.channelId))
      .where(eq(vods.id, input.id))
      .limit(1);
    if (!row) throw notFound("VOD not found");
    const audience = await viewerAudience(deps, context.caller, row.channel);
    if (!vodShown(audience, row.v, row.channel, row.b.restrictedAt)) throw notFound("VOD not found");
    // Playable: what `vods.get` hands a playlist URL to (the owner also sees processing and
    // suspended-channel VODs, which do not play).
    const servable = row.v.status === "ready" && row.v.removedReason === null && row.channel.suspendedAt === null;
    const [withheld] = await urlsWithheld(deps, context.caller, row.channel, [row.b]);
    if (!servable || (withheld ?? true)) throw notFound("VOD not found");
    await recordMediaView(deps, "vod", row.v.id, viewerOf(context.caller, context.req));
    return { ok: true as const };
  }),
};

export const clipViews = {
  recordView: os.clips.recordView.handler(async ({ context, input }) => {
    const { deps } = context;
    const [head] = await deps.db
      .select({ channel: channels })
      .from(clips)
      .innerJoin(channels, eq(channels.id, clips.channelId))
      .where(eq(clips.id, input.id))
      .limit(1);
    if (!head) throw notFound("Clip not found");
    const audience = await viewerAudience(deps, context.caller, head.channel);
    if (audience !== "owner" && head.channel.suspendedAt !== null) throw notFound("Clip not found");
    const [row] = await deps.db
      .select({ c: clips, b: broadcasts })
      .from(clips)
      .leftJoin(broadcasts, eq(broadcasts.id, clips.broadcastId))
      .where(and(eq(clips.id, input.id), clipVisible(audience)))
      .limit(1);
    if (!row || row.c.status !== "ready") throw notFound("Clip not found");
    const [withheld] = await urlsWithheld(deps, context.caller, head.channel, [row.b]);
    if (withheld ?? true) throw notFound("Clip not found");
    await recordMediaView(deps, "clip", row.c.id, viewerOf(context.caller, context.req));
    return { ok: true as const };
  }),
};
