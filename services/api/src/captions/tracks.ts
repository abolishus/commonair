// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Caption tracks for playback and VODs (ADR 0011). W2-captions owns this directory; the contract
 * step leaves stubs that report no captions, so `playback.start` and the `Vod` composer never need
 * editing again.
 */
import type { dto } from "@commonair/contracts";
import type { schema } from "@commonair/db";
import type { z } from "zod";
import type { Deps } from "../deps.ts";

type BroadcastRow = typeof schema.broadcasts.$inferSelect;
type VodRow = typeof schema.vods.$inferSelect;
type PlaybackStart = z.infer<typeof dto.PlaybackStart>;

/** The live caption tracks `playback.start` advertises for a broadcast (none for a rehearsal). */
export async function captionTracksFor(_deps: Deps, _broadcast: BroadcastRow): Promise<PlaybackStart["captions"]> {
  return [];
}

/** Why there are or are not live captions (`PlaybackStart.captionsState`). */
export async function captionsStateFor(_deps: Deps, _broadcast: BroadcastRow): Promise<PlaybackStart["captionsState"]> {
  return "off";
}

/** A VOD's ready caption tracks (`Vod.captions`), for a VOD `vodShown` admits. */
export async function vodCaptionTracks(_deps: Deps, _vod: VodRow): Promise<z.infer<typeof dto.Vod>["captions"]> {
  return [];
}
