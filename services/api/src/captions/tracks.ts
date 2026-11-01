// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Caption tracks for playback and VODs (ADR 0011), read from `broadcast_caption_tracks`, which the
 * media captions worker keeps (`services/media/src/captions/manager.ts`).
 *
 * - Live: only `active` tracks, never for a rehearsal (decision (g)). The URL is relative to the
 *   session's playlist (`captions/<lang>/index.m3u8`): the origin advertises the same track in
 *   the multivariant playlist with the viewer's token, which is how players find it.
 * - VOD: only `ready` tracks. The `.vtt` sits under the VOD's current `storage_prefix` (placement
 *   moves carry it), so its URL follows the VOD's own: the public `/media` URL for a public VOD on
 *   the public prefix, otherwise the origin's token-checked `/vod/` route.
 */
import { and, eq } from "drizzle-orm";
import { languageLabel } from "@commonair/captions";
import type { dto } from "@commonair/contracts";
import {
  VOD_ROUTE,
  VOD_TOKEN_MAX_TTL_SECONDS,
  vodCaptionsKey,
  vodPrefix,
  vodTokenPath,
} from "@commonair/contracts/storage";
import type { PlaybackClaims } from "@commonair/contracts/tokens";
import { schema, uuidv7 } from "@commonair/db";
import { signPlaybackToken } from "@commonair/tokens";
import type { z } from "zod";
import type { Deps } from "../deps.ts";
import { mediaUrl } from "../lib/dto.ts";

const { broadcastCaptionTracks: tracks } = schema;
type BroadcastRow = typeof schema.broadcasts.$inferSelect;
type VodRow = typeof schema.vods.$inferSelect;
type PlaybackStart = z.infer<typeof dto.PlaybackStart>;
type CaptionTrack = z.infer<typeof dto.CaptionTrack>;

/** The live subtitle playlist of a track, relative to the session's multivariant playlist. */
export const liveCaptionsPath = (language: string) => `captions/${language}/index.m3u8`;

async function trackRows(deps: Deps, broadcastId: string) {
  return deps.db
    .select({ language: tracks.language, status: tracks.status })
    .from(tracks)
    .where(eq(tracks.broadcastId, broadcastId));
}

/** The live caption tracks `playback.start` advertises for a broadcast (none for a rehearsal). */
export async function captionTracksFor(deps: Deps, broadcast: BroadcastRow): Promise<PlaybackStart["captions"]> {
  if (broadcast.kind === "rehearsal" || broadcast.endedAt !== null) return [];
  return (await trackRows(deps, broadcast.id))
    .filter((t) => t.status === "active")
    .map((t) => ({ language: t.language, label: languageLabel(t.language), url: liveCaptionsPath(t.language) }));
}

/** Why there are or are not live captions (`PlaybackStart.captionsState`): `active`, `queued` (capacity) or `off`. */
export async function captionsStateFor(deps: Deps, broadcast: BroadcastRow): Promise<PlaybackStart["captionsState"]> {
  if (broadcast.kind === "rehearsal" || broadcast.endedAt !== null) return "off";
  const rows = await trackRows(deps, broadcast.id);
  if (rows.some((t) => t.status === "active")) return "active";
  if (rows.some((t) => t.status === "queued")) return "queued";
  return "off";
}

/** A token for the origin's `/vod/` route, as `routes/vods.ts` mints one (duration plus an hour, capped). */
async function vodRouteToken(deps: Deps, v: VodRow): Promise<string> {
  const iat = Math.floor(deps.now().getTime() / 1000);
  const claims: PlaybackClaims = {
    v: 1,
    sid: uuidv7(),
    cid: v.channelId,
    path: vodTokenPath(v.id),
    src: "origin",
    iat,
    exp: iat + Math.min(Math.ceil(v.durationSeconds) + 3600, VOD_TOKEN_MAX_TTL_SECONDS),
  };
  return signPlaybackToken(deps.signingKey, claims);
}

/** Where a VOD's track is served from (the object under its current prefix). */
export async function vodCaptionUrl(deps: Deps, v: VodRow, language: string): Promise<string | null> {
  const key = vodCaptionsKey(v.storagePrefix, language);
  if (v.visibility === "public" && v.storagePrefix === vodPrefix(v.id, "public")) return mediaUrl(deps, key);
  const t = encodeURIComponent(await vodRouteToken(deps, v));
  const base = `${deps.env.PLAYBACK_PUBLIC_URL.replace(/\/+$/, "")}${VOD_ROUTE}${v.id}/`;
  return `${base}${key.slice(v.storagePrefix.length)}?t=${t}`;
}

/** A VOD's ready caption tracks (`Vod.captions`), for a VOD `vodShown` admits. */
export async function vodCaptionTracks(deps: Deps, vod: VodRow): Promise<z.infer<typeof dto.Vod>["captions"]> {
  if (vod.status !== "ready") return [];
  const rows = await deps.db
    .select({ language: tracks.language })
    .from(tracks)
    .where(and(eq(tracks.vodId, vod.id), eq(tracks.status, "ready")));
  const out: CaptionTrack[] = [];
  for (const r of rows) {
    const url = await vodCaptionUrl(deps, vod, r.language);
    if (url) out.push({ language: r.language, label: languageLabel(r.language), url });
  }
  return out;
}
