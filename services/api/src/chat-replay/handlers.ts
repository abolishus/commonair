// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `vods.chat` / `clips.chat` (ADR 0012 amendment 1 decisions 5 and 7): chat replay, served exactly
 * when the VOD or clip itself is playable to the caller, as `vods.get` / `clips.get` decide it
 * (status, removal, visibility, channel suspension), and only when its media URLs would not be
 * withheld behind the 18+ gate. Filtered per viewer (blocks): the API's default
 * `cache-control: no-store` keeps every response out of shared caches.
 */
import { and, eq } from "drizzle-orm";
import { schema } from "@commonair/db";
import { notFound } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";
import { clipVisible, urlsWithheld, viewerAudience, vodShown } from "../media/visibility.ts";
import { matureGate } from "../routes/playback.ts";
import { replayPage, type ReplayWindow } from "./query.ts";

const { broadcasts, channels, clips, vods } = schema;

export const vodChat = os.vods.chat.handler(async ({ context, input }) => {
  const { deps, caller } = context;
  const [row] = await deps.db
    .select({ v: vods, channel: channels, b: broadcasts })
    .from(vods)
    .innerJoin(broadcasts, eq(broadcasts.id, vods.broadcastId))
    .innerJoin(channels, eq(channels.id, vods.channelId))
    .where(eq(vods.id, input.id))
    .limit(1);
  if (!row || !vodShown(await viewerAudience(deps, caller, row.channel), row.v, row.channel, row.b.restrictedAt))
    throw notFound("VOD not found");
  const [withheld] = await urlsWithheld(deps, caller, row.channel, [row.b]);
  if (withheld ?? true) throw matureGate();
  // The recording span: start to end, or to now while it is still recording.
  const window: ReplayWindow = {
    channel: row.channel,
    broadcast: { id: row.b.id, startedAt: row.b.startedAt, endedAt: row.b.endedAt },
    from: row.b.startedAt,
    to: row.b.endedAt ?? deps.now(),
  };
  return replayPage(deps, window, caller?.user.id ?? null, input);
});

export const clipChat = os.clips.chat.handler(async ({ context, input }) => {
  const { deps, caller } = context;
  const [head] = await deps.db
    .select({ channel: channels })
    .from(clips)
    .innerJoin(channels, eq(channels.id, clips.channelId))
    .where(eq(clips.id, input.id))
    .limit(1);
  if (!head) throw notFound("Clip not found");
  const audience = await viewerAudience(deps, caller, head.channel);
  if (audience !== "owner" && head.channel.suspendedAt !== null) throw notFound("Clip not found");
  const [row] = await deps.db
    .select({ c: clips, b: broadcasts })
    .from(clips)
    .leftJoin(broadcasts, eq(broadcasts.id, clips.broadcastId))
    .where(and(eq(clips.id, input.id), clipVisible(audience)))
    .limit(1);
  if (!row) throw notFound("Clip not found");
  const [withheld] = await urlsWithheld(deps, caller, head.channel, [
    row.b ? { mature: row.b.mature, categoryId: row.b.categoryId } : null,
  ]);
  if (withheld ?? true) throw matureGate();
  // The wall-clock window the clip was cut from, on the recorder clock (ADR 0012 part 1).
  const from = row.b
    ? new Date(row.b.startedAt.getTime() + row.c.startOffset * 1000)
    : new Date(row.c.createdAt.getTime());
  const window: ReplayWindow = {
    channel: head.channel,
    broadcast: row.b ? { id: row.b.id, startedAt: row.b.startedAt, endedAt: row.b.endedAt } : null,
    from,
    to: new Date(from.getTime() + row.c.durationSeconds * 1000),
  };
  return replayPage(deps, window, caller?.user.id ?? null, input);
});
