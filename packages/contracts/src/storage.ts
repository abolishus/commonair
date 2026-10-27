// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Media bucket layout (ADR 0009 and its amendment 1). One place for the prefixes every service
 * reads and writes, so the origin's allowlist, the recorder, retention and the moderation movers
 * cannot drift apart.
 */
import type { VISIBILITIES, VOD_STATUSES } from "./enums.ts";

/**
 * First key segments that hold published objects; the origin's `/media/` route serves only these.
 * Everything else (`recordings/`, `incoming/`, `moderation/`, `evidence/`, `exports/`) is private.
 */
export const PUBLIC_MEDIA_PREFIXES: readonly string[] = ["channels", "clips", "thumbnails", "vods"];

/** A VOD that is public and playable keeps its objects here (served at `/media/vods/…`). */
export const VOD_PUBLIC_PREFIX = "vods/";
/** Every other VOD (recording, processing, restricted, removed) keeps them here (never routed). */
export const VOD_PRIVATE_PREFIX = "recordings/";

export type VodPlacement = "public" | "private";

/** The object prefix of a VOD under a placement. The trailing slash keeps `vods/a` from matching `vods/ab…`. */
export const vodPrefix = (vodId: string, placement: VodPlacement): string =>
  `${placement === "public" ? VOD_PUBLIC_PREFIX : VOD_PRIVATE_PREFIX}${vodId}/`;

/** True for exactly the two prefixes a VOD may own. Retention and every reader check this before touching storage. */
export const isVodOwnPrefix = (vodId: string, prefix: string): boolean =>
  prefix === vodPrefix(vodId, "public") || prefix === vodPrefix(vodId, "private");

/** The VOD's HLS media playlist, under its prefix. */
export const VOD_PLAYLIST = "index.m3u8";

/** The database state that decides where a VOD's objects belong. */
export interface VodPlacementState {
  status: (typeof VOD_STATUSES)[number];
  visibility: (typeof VISIBILITIES)[number];
  /** `vods.removed_reason`; any value (the owner's, retention's, `dmca`, …) keeps the VOD private. */
  removedReason: string | null;
  /** The broadcast carries a T1 restriction (`broadcasts.restricted_at`). */
  broadcastRestricted: boolean;
  /** The channel is suspended. */
  channelSuspended: boolean;
  /** A hidden NCII item covers the VOD: its objects are under `moderation/ncii-hidden/`. */
  nciiHidden: boolean;
  /** A DMCA item covering the VOD has its objects hidden and not restored (`moderation/dmca/`). */
  dmcaHidden: boolean;
}

/**
 * Where a VOD's objects belong (ADR 0009 amendment 1, decision 3). `leave` means move nothing:
 * another flow (NCII auto-hide, DMCA disable and restore) owns the objects' keys for now, or the
 * VOD is deleted and has nothing left to move.
 */
export function vodPlacement(state: VodPlacementState): VodPlacement | "leave" {
  if (state.status === "deleted" || state.nciiHidden || state.dmcaHidden) return "leave";
  const publiclyPlayable =
    state.status === "ready" &&
    state.visibility === "public" &&
    state.removedReason === null &&
    !state.broadcastRestricted &&
    !state.channelSuspended;
  return publiclyPlayable ? "public" : "private";
}

/** Origin route for VODs that are not public: `GET|HEAD /vod/<vodId>/<file>?t=<token>`. */
export const VOD_ROUTE = "/vod/";
/**
 * The `PlaybackClaims.path` a VOD token carries. No MediaMTX path can equal it (they all start
 * `live/`), so a VOD token never authorizes the live `/hls` route or a relay.
 */
export const vodTokenPath = (vodId: string): string => `vod/${vodId}`;
/** A VOD token lives for the VOD's duration plus an hour, capped here (accepted: 12 h, no refresh). */
export const VOD_TOKEN_MAX_TTL_SECONDS = 12 * 60 * 60;
