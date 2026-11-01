// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * MediaMTX hooks (INTERNAL_ROUTES). `mediaAuth` answers MediaMTX's auth HTTP
 * requests (which cannot carry our header, so callers authenticate in the body);
 * `mediaReady` / `mediaNotReady` come from runOnReady / runOnNotReady and carry
 * the x-internal-secret header. Lifecycle hooks are idempotent and tolerate
 * duplicates and out-of-order delivery.
 *
 * The rehearsal gate (batch 6 decision (f)): while `KEYS.rehearsalArmed(channelId)` exists, a
 * publish with the channel's normal key starts a `kind = 'rehearsal'` broadcast instead of a live
 * one. A rehearsal never becomes `channels.live_broadcast_id` and writes no `stream.online` or
 * `stream.offline`, so the directory, the go-live fan-out, EventSub, webhooks, Discord, raids and
 * goals never see it; media still runs ingest, transcode, health, recording and moderation for it
 * (the `online` / `offline` live events), without simulcast. The arm is captured at auth, so an
 * arm lapsing between auth and ready still starts the rehearsal; it is not consumed (it lapses
 * after `REHEARSAL_RULES.armTtlSeconds`, or `stream.rehearsal.disarm` deletes it), so a reconnect
 * inside the TTL starts another rehearsal rather than going live.
 */
import { and, eq, isNull } from "drizzle-orm";
import { KEYS, MediaMtxAuthRequest, MediaReadyHook, mediaPath, RehearsalArm } from "@commonair/contracts/internal";
import type { INGEST_PROTOCOLS } from "@commonair/contracts/enums";
import { schema } from "@commonair/db";
import { hmacHex, sha256Hex } from "@commonair/tokens";
import type { Deps } from "../deps.ts";
import { broadcasterFields, emit } from "../events/outbox.ts";
import { isSuspended } from "../lib/caller.ts";
import { publishLive } from "../lib/control.ts";
import { canonicalIp } from "../lib/netrange.ts";
import { decidePublish, internalCredentialsOk, planMediaAuth } from "./auth.ts";

const { channels, users, streamKeys, broadcasts, playbackSessions, rehearsalInvitees } = schema;
const LIVE_PATH = /^live\/([a-z0-9_]{3,25})$/;
/** Remembers which key authorized the latest publish, for the broadcast row. */
const publishKey = (slug: string) => `media:publish-key:${slug}`;
/** Marks a source that already went not-ready, so a late "ready" for it is ignored. */
const endedSource = (path: string, sourceId: string) => `media:ended:${path}:${sourceId}`;
/** The rehearsal arm the latest authorized publish saw (JSON `RehearsalArm`); absent = live. */
const publishRehearsal = (slug: string) => `media:publish-rehearsal:${slug}`;
const MARKER_TTL_SECONDS = 600;

/** A stored rehearsal arm, or null (absent, unreadable, or armed by someone other than the owner). */
function parseArm(raw: string | null, ownerId: string): RehearsalArm | null {
  if (!raw) return null;
  try {
    const arm = RehearsalArm.parse(JSON.parse(raw));
    return arm.ownerId === ownerId ? arm : null;
  } catch {
    return null;
  }
}

type IngestProtocol = (typeof INGEST_PROTOCOLS)[number];

/** MediaMTX source types (rtmpConn, webRTCSession, srtConn, rtspSession, …) → our ingest protocol. */
export function ingestProtocolOf(sourceType: string): IngestProtocol {
  const t = sourceType.toLowerCase();
  if (t.startsWith("webrtc")) return "whip";
  if (t.startsWith("srt")) return "srt";
  if (t.startsWith("rtsp")) return "rtsp";
  return "rtmp";
}

export async function mediaAuth(deps: Deps, body: unknown): Promise<number> {
  const parsed = MediaMtxAuthRequest.safeParse(body);
  if (!parsed.success) return 401;
  const req = parsed.data;
  const plan = planMediaAuth(req);
  if (plan.kind === "deny") return 401;
  if (plan.kind === "internal") return internalCredentialsOk(req, deps.env.MEDIA_INTERNAL_PASSWORD) ? 200 : 401;
  if (!plan.secret) return 401;
  const [row] = await deps.db
    .select({ channel: channels, owner: users })
    .from(channels)
    .innerJoin(users, eq(users.id, channels.ownerId))
    .where(eq(channels.slug, plan.slug))
    .limit(1);
  if (!row) return 401;
  const [key] = await deps.db
    .select({ id: streamKeys.id })
    .from(streamKeys)
    .where(
      and(
        eq(streamKeys.channelId, row.channel.id),
        eq(streamKeys.keyHash, await sha256Hex(plan.secret)),
        isNull(streamKeys.revokedAt),
      ),
    )
    .limit(1);
  const ok = decidePublish({
    channelExists: true,
    channelSuspended: row.channel.suspendedAt !== null,
    ownerSuspended: isSuspended(row.owner, deps.now()) || row.owner.deletedAt !== null,
    keyMatches: key !== undefined,
  });
  if (ok && key) {
    await deps.valkey.set(publishKey(plan.slug), key.id, "EX", MARKER_TTL_SECONDS);
    // Rehearsal gate: the normal key, while armed, publishes a rehearsal (mediaReady reads this).
    const arm = parseArm(await deps.valkey.get(KEYS.rehearsalArmed(row.channel.id)), row.channel.ownerId);
    if (arm) await deps.valkey.set(publishRehearsal(plan.slug), JSON.stringify(arm), "EX", MARKER_TTL_SECONDS);
    else await deps.valkey.del(publishRehearsal(plan.slug));
    // Same scheme (and canonical address form) as playback_sessions.ip_hash, so integrity can exclude the streamer's own
    // address from their viewer counts.
    await deps.db
      .update(streamKeys)
      .set({ lastUsedIpHash: await hmacHex(deps.env.AUTH_SECRET, `ip:${canonicalIp(req.ip)}`) })
      .where(eq(streamKeys.id, key.id));
  }
  if (!ok) deps.logger.info("media publish refused", { channelId: row.channel.id, keyMatched: key !== undefined });
  return ok ? 200 : 401;
}

export async function mediaReady(deps: Deps, body: unknown): Promise<number> {
  const parsed = MediaReadyHook.safeParse(body);
  if (!parsed.success) return 400;
  const hook = parsed.data;
  const slug = LIVE_PATH.exec(hook.path)?.[1];
  // Rendition paths and anything else are not broadcasts.
  if (!slug) return 204;
  if (hook.sourceId && (await deps.valkey.exists(endedSource(hook.path, hook.sourceId)))) return 204;
  const now = deps.now();
  const keyId = await deps.valkey.get(publishKey(slug));
  const authArm = await deps.valkey.get(publishRehearsal(slug));
  const started = await deps.db.transaction(async (tx) => {
    const [c] = await tx.select().from(channels).where(eq(channels.slug, slug)).for("update");
    if (!c) return null;
    if (c.liveBroadcastId) {
      const [current] = await tx.select().from(broadcasts).where(eq(broadcasts.id, c.liveBroadcastId));
      if (current && !current.endedAt) return null; // duplicate ready: already live
    }
    const arm = parseArm(authArm ?? (await deps.valkey.get(KEYS.rehearsalArmed(c.id))), c.ownerId);
    if (arm) {
      const [open] = await tx
        .select({ id: broadcasts.id })
        .from(broadcasts)
        .where(and(eq(broadcasts.channelId, c.id), eq(broadcasts.kind, "rehearsal"), isNull(broadcasts.endedAt)))
        .limit(1);
      if (open) return null; // duplicate ready: already rehearsing
      const [b] = await tx
        .insert(broadcasts)
        .values({
          channelId: c.id,
          kind: "rehearsal",
          streamKeyId: keyId,
          ingestProtocol: ingestProtocolOf(hook.sourceType),
          path: mediaPath(slug),
          title: c.title,
          categoryId: c.categoryId,
          mature: c.mature,
          startedAt: now,
        })
        .returning();
      if (!b) throw new Error("broadcast insert returned no row");
      if (keyId) await tx.update(streamKeys).set({ lastUsedAt: now }).where(eq(streamKeys.id, keyId));
      // The arm's invitees carry over into the rehearsal it starts.
      await tx
        .update(rehearsalInvitees)
        .set({ broadcastId: b.id })
        .where(
          and(
            eq(rehearsalInvitees.armId, arm.armId),
            eq(rehearsalInvitees.channelId, c.id),
            isNull(rehearsalInvitees.broadcastId),
          ),
        );
      // No liveBroadcastId and no stream.online: nothing outside the rehearsal sees it.
      return { channel: c, broadcast: b };
    }
    const [b] = await tx
      .insert(broadcasts)
      .values({
        channelId: c.id,
        streamKeyId: keyId,
        ingestProtocol: ingestProtocolOf(hook.sourceType),
        path: mediaPath(slug),
        title: c.title,
        categoryId: c.categoryId,
        mature: c.mature,
        startedAt: now,
      })
      .returning();
    if (!b) throw new Error("broadcast insert returned no row");
    await tx.update(channels).set({ liveBroadcastId: b.id }).where(eq(channels.id, c.id));
    if (keyId) await tx.update(streamKeys).set({ lastUsedAt: now }).where(eq(streamKeys.id, keyId));
    await emit(
      tx,
      "stream.online",
      c.id,
      { ...broadcasterFields(c), id: b.id, type: "live", started_at: now.toISOString() },
      now,
    );
    return { channel: c, broadcast: b };
  });
  if (started)
    await publishLive(deps, {
      type: "online",
      channelId: started.channel.id,
      broadcastId: started.broadcast.id,
      slug,
      path: started.broadcast.path,
      protocol: started.broadcast.ingestProtocol,
      at: now.toISOString(),
    });
  return 204;
}

export async function mediaNotReady(deps: Deps, body: unknown): Promise<number> {
  const parsed = MediaReadyHook.safeParse(body);
  if (!parsed.success) return 400;
  const hook = parsed.data;
  const slug = LIVE_PATH.exec(hook.path)?.[1];
  if (!slug) return 204;
  if (hook.sourceId) await deps.valkey.set(endedSource(hook.path, hook.sourceId), "1", "EX", MARKER_TTL_SECONDS);
  const now = deps.now();
  const ended = await deps.db.transaction(async (tx) => {
    const [c] = await tx.select().from(channels).where(eq(channels.slug, slug)).for("update");
    if (!c) return null;
    if (!c.liveBroadcastId) {
      // A rehearsal ends quietly: no stream.offline (decision (f)).
      const [r] = await tx
        .update(broadcasts)
        .set({ endedAt: now })
        .where(and(eq(broadcasts.channelId, c.id), eq(broadcasts.kind, "rehearsal"), isNull(broadcasts.endedAt)))
        .returning();
      if (!r) return null; // duplicate or out-of-order: nothing is live or rehearsing
      await tx
        .update(playbackSessions)
        .set({ endedAt: now })
        .where(and(eq(playbackSessions.broadcastId, r.id), isNull(playbackSessions.endedAt)));
      return { channel: c, broadcast: r };
    }
    const [b] = await tx
      .update(broadcasts)
      .set({ endedAt: now })
      .where(and(eq(broadcasts.id, c.liveBroadcastId), isNull(broadcasts.endedAt)))
      .returning();
    await tx.update(channels).set({ liveBroadcastId: null }).where(eq(channels.id, c.id));
    if (!b) return null;
    await tx
      .update(playbackSessions)
      .set({ endedAt: now })
      .where(and(eq(playbackSessions.broadcastId, b.id), isNull(playbackSessions.endedAt)));
    await emit(tx, "stream.offline", c.id, broadcasterFields(c), now);
    return { channel: c, broadcast: b };
  });
  if (ended) {
    await deps.valkey.del(
      KEYS.viewers(ended.channel.id),
      KEYS.viewerCount(ended.channel.id),
      KEYS.catchingUpCount(ended.channel.id),
      KEYS.renditions(ended.channel.id),
    );
    await publishLive(deps, {
      type: "offline",
      channelId: ended.channel.id,
      broadcastId: ended.broadcast.id,
      slug,
      path: ended.broadcast.path,
      at: now.toISOString(),
    });
  }
  return 204;
}
