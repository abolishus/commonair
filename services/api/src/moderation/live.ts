// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Ending a live broadcast from a moderation decision (`end_stream`, a suspension, an NCII
 * removal). The database change goes into the caller's transaction with its `stream.offline`
 * event; after commit the publisher is kicked from MediaMTX and the live bus is told. A kick that
 * fails is logged: the broadcast is already over in the database, and a suspended channel's key
 * is refused at the next publish.
 */
import { and, eq, isNull } from "drizzle-orm";
import { KEYS, MEDIA_INTERNAL_USER, mediaPath } from "@commonair/contracts/internal";
import { schema, type Executor } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { broadcasterFields, emit } from "../events/outbox.ts";
import { publishLive } from "../lib/control.ts";

const { broadcasts, channels, playbackSessions } = schema;

export interface EndedBroadcast {
  channelId: string;
  broadcastId: string;
  slug: string;
  path: string;
}

/** End `broadcastId` if it is the channel's live broadcast. Returns null when it was not live. */
export async function endBroadcastInTx(
  tx: Executor,
  channelId: string,
  broadcastId: string,
  now: Date,
): Promise<EndedBroadcast | null> {
  const [c] = await tx.select().from(channels).where(eq(channels.id, channelId)).for("update");
  if (!c) return null;
  const [b] = await tx
    .update(broadcasts)
    .set({ endedAt: now })
    .where(and(eq(broadcasts.id, broadcastId), eq(broadcasts.channelId, channelId), isNull(broadcasts.endedAt)))
    .returning();
  if (!b) return null;
  if (c.liveBroadcastId === b.id) await tx.update(channels).set({ liveBroadcastId: null }).where(eq(channels.id, c.id));
  await tx
    .update(playbackSessions)
    .set({ endedAt: now })
    .where(and(eq(playbackSessions.broadcastId, b.id), isNull(playbackSessions.endedAt)));
  await emit(tx, "stream.offline", c.id, broadcasterFields(c), now);
  return { channelId: c.id, broadcastId: b.id, slug: c.slug, path: b.path };
}

/** The channel's live broadcast, ended in the transaction (suspensions). */
export async function endLiveInTx(tx: Executor, channelId: string, now: Date): Promise<EndedBroadcast | null> {
  const [c] = await tx.select({ live: channels.liveBroadcastId }).from(channels).where(eq(channels.id, channelId));
  return c?.live ? endBroadcastInTx(tx, channelId, c.live, now) : null;
}

const KICK_ROUTES: Record<string, string> = {
  rtmpConn: "rtmpconns",
  rtmpsConn: "rtmpsconns",
  webRTCSession: "webrtcsessions",
  rtspSession: "rtspsessions",
  rtspsSession: "rtspssessions",
  srtConn: "srtconns",
};

/** Disconnect whoever publishes `path` (MediaMTX control API, internal credentials). */
export async function kickPublisher(deps: Deps, path: string, doFetch: typeof fetch = fetch): Promise<boolean> {
  const base = deps.env.MEDIAMTX_API_URL.replace(/\/+$/, "");
  const headers = {
    authorization: `Basic ${Buffer.from(`${MEDIA_INTERNAL_USER}:${deps.env.MEDIA_INTERNAL_PASSWORD}`).toString("base64")}`,
  };
  const signal = () => AbortSignal.timeout(5000);
  const res = await doFetch(`${base}/v3/paths/get/${path.split("/").map(encodeURIComponent).join("/")}`, {
    headers,
    signal: signal(),
  });
  if (!res.ok) {
    await res.body?.cancel();
    return false;
  }
  const p = (await res.json()) as { source?: { type?: string; id?: string } | null };
  const route = p.source?.type ? KICK_ROUTES[p.source.type] : undefined;
  if (!route || !p.source?.id) return false;
  const kick = await doFetch(`${base}/v3/${route}/kick/${encodeURIComponent(p.source.id)}`, {
    method: "POST",
    headers,
    signal: signal(),
  });
  await kick.body?.cancel();
  return kick.ok;
}

/** After commit: clear live caches, announce offline, kick the publisher. */
export async function afterBroadcastEnded(deps: Deps, ended: EndedBroadcast | null): Promise<void> {
  if (!ended) return;
  await deps.valkey
    .del(KEYS.viewers(ended.channelId), KEYS.viewerCount(ended.channelId), KEYS.renditions(ended.channelId))
    .catch(() => 0);
  await publishLive(deps, {
    type: "offline",
    channelId: ended.channelId,
    broadcastId: ended.broadcastId,
    slug: ended.slug,
    path: ended.path || mediaPath(ended.slug),
    at: deps.now().toISOString(),
  });
  try {
    await kickPublisher(deps, ended.path || mediaPath(ended.slug));
  } catch (err) {
    deps.logger.warn("publisher kick failed", {
      channelId: ended.channelId,
      broadcastId: ended.broadcastId,
      err: (err as Error).name,
    });
  }
}
