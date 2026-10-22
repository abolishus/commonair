// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * MediaMTX `authHTTPAddress` decisions (pure). MediaMTX only distinguishes 200 and
 * non-200, so every refusal is a plain 401.
 *
 * - publish `live/<slug>`: the channel's active stream key (RTMP `?key=`, WHIP bearer token),
 *   channel and owner not suspended.
 * - publish `live/<slug>/<rendition>` and `live/<slug>/aac`: internal credentials (the media
 *   service's ladder and its AAC copy of the source).
 * - read / playback / api / metrics: internal credentials (MEDIA_INTERNAL_PASSWORD) only; viewers go through the origin.
 * - anything else (pprof, unknown paths): refused.
 */
import { MEDIA_INTERNAL_USER, SOURCE_AAC_DIR, type MediaMtxAuthRequest } from "@commonair/contracts/internal";
import { RENDITIONS } from "@commonair/contracts/enums";
import { timingSafeEqual } from "@commonair/tokens";

export type MediaAuthPlan =
  | { kind: "publish"; slug: string; secret: string | null }
  | { kind: "internal" }
  | { kind: "deny" };

const LIVE_PATH = /^live\/([a-z0-9_]{3,25})$/;
// Renditions and the AAC copy of the source (SOURCE_AAC_DIR), both published by media.
const RENDITION_PATH = new RegExp(
  `^live/[a-z0-9_]{3,25}/(${[...RENDITIONS.filter((r) => r !== "source"), SOURCE_AAC_DIR].join("|")})$`,
);

/** Secret a publisher presented: RTMP/SRT query `key`, WHIP bearer token, or the password field. */
export function presentedSecret(req: MediaMtxAuthRequest): string | null {
  const key = new URLSearchParams(req.query).get("key");
  if (key) return key;
  if (req.token) return req.token;
  if (req.password && !req.user) return req.password;
  return null;
}

export function planMediaAuth(req: MediaMtxAuthRequest): MediaAuthPlan {
  switch (req.action) {
    case "publish": {
      const m = LIVE_PATH.exec(req.path);
      if (m?.[1]) return { kind: "publish", slug: m[1], secret: presentedSecret(req) };
      if (RENDITION_PATH.test(req.path)) return { kind: "internal" };
      return { kind: "deny" };
    }
    case "read":
    case "playback":
    case "api":
    case "metrics":
      return { kind: "internal" };
    default:
      return { kind: "deny" };
  }
}

export const internalCredentialsOk = (req: Pick<MediaMtxAuthRequest, "user" | "password">, mediaPassword: string) =>
  timingSafeEqual(req.user, MEDIA_INTERNAL_USER) && timingSafeEqual(req.password, mediaPassword);

export interface PublishFacts {
  channelExists: boolean;
  channelSuspended: boolean;
  ownerSuspended: boolean;
  /** The presented secret hashes to the channel's active (unrevoked) key. */
  keyMatches: boolean;
}

export const decidePublish = (f: PublishFacts): boolean =>
  f.channelExists && !f.channelSuspended && !f.ownerSuspended && f.keyMatches;
