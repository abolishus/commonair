// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What a VOD or clip watch page shows (docs/testing/w2-selectors.md "VOD and clip watch pages").
 * Anything the caller may not watch is the same not-found state, whatever the reason (the API
 * answers NOT_FOUND for private, `subscribers`, removed, restricted and suspended media), so the
 * page never reveals that a hidden video exists. `vods.get` / `clips.get` list mature media but
 * withhold its URLs from viewers who have not confirmed 18+: a ready item without a URL is the
 * mature gate.
 */
import type * as D from "@commonair/contracts/dto";
import type { z } from "zod";

export type VodDto = z.infer<typeof D.Vod>;
export type ClipDto = z.infer<typeof D.Clip>;

/** `data-state` on the page container, plus the two states without one. */
export type WatchState = "not-found" | "not-ready" | "gated" | "ready";

const sameChannel = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** `vod` null: `vods.get` answered NOT_FOUND. */
export function vodState(vod: VodDto | null, routeChannel: string): WatchState {
  if (!vod || !sameChannel(vod.channelSlug, routeChannel)) return "not-found";
  switch (vod.status) {
    case "recording":
    case "processing":
      return "not-ready";
    case "ready":
      return vod.playlistUrl === null ? "gated" : "ready";
    case "failed":
    case "deleted":
      return "not-found";
  }
}

/** `clip` null: `clips.get` answered NOT_FOUND. */
export function clipState(clip: ClipDto | null, routeChannel: string): WatchState {
  if (!clip || !sameChannel(clip.channelSlug, routeChannel)) return "not-found";
  switch (clip.status) {
    case "processing":
      return "not-ready";
    case "ready":
      return clip.url === null ? "gated" : "ready";
    case "failed":
    case "deleted":
      return "not-found";
  }
}
