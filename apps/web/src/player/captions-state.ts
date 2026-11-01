// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The CC toggle's logic (ADR 0011), apart from React so it is testable without a player: which text
 * tracks are captions, turning them on and off through the player seam, and the viewer's caption
 * style kept in `localStorage`.
 *
 * Live cues are written a chunk (3 s) plus whisper's time after the speech, so turning captions on
 * holds the playhead `CAPTIONS_LATENCY_SECONDS` behind live (`setTargetLatency`), which lands each
 * cue before its PDT; turning them off restores the previous target. Native HLS (WebKit) exposes no
 * target: nothing changes there and the cues may arrive late, which the toggle says.
 */
import type { PlayerController } from "./controller.ts";

/** The playhead's distance from live while captions are on (8–10 s puts every cue before its PDT). */
export const CAPTIONS_LATENCY_SECONDS = 9;
/**
 * What off restores when no target was set before: about hls.js's low-latency default
 * (`liveSyncDurationCount: 3` of the origin's 1 s segments).
 */
export const DEFAULT_LIVE_LATENCY_SECONDS = 3;

export const CAPTION_SIZES = ["small", "medium", "large"] as const;
export const CAPTION_CONTRASTS = ["standard", "high"] as const;
export type CaptionSize = (typeof CAPTION_SIZES)[number];
export type CaptionContrast = (typeof CAPTION_CONTRASTS)[number];
export interface CaptionStyle {
  size: CaptionSize;
  contrast: CaptionContrast;
}
export const DEFAULT_CAPTION_STYLE: CaptionStyle = { size: "medium", contrast: "standard" };
export const CAPTION_STYLE_KEY = "commonair.captions.style";

/** The caption-like tracks of a `TextTrackList` (hls.js adds one per SUBTITLES rendition). */
export function captionTracks(list: ArrayLike<TextTrack> | null | undefined): TextTrack[] {
  if (!list) return [];
  const out: TextTrack[] = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (t && (t.kind === "subtitles" || t.kind === "captions")) out.push(t);
  }
  return out;
}

/** The track to show: the one in `language` (the session's spoken language), else the first. */
export function pickTrack(tracks: readonly TextTrack[], language: string | null): TextTrack | null {
  return tracks.find((t) => language !== null && t.language === language) ?? tracks[0] ?? null;
}

export const isShowing = (tracks: readonly TextTrack[]) => tracks.some((t) => t.mode === "showing");

type Latency = Pick<PlayerController, "setTargetLatency">;

/** What `captionsOn` changed, for `captionsOff` to undo. */
export interface CaptionsSession {
  /** The target before captions (NaN when none was set). */
  previous: number;
  /** Native HLS: the latency could not be raised. */
  native: boolean;
}

/** Show `track` (every other caption track off) and hold the playhead behind live. */
export function captionsOn(controller: Latency, tracks: readonly TextTrack[], track: TextTrack): CaptionsSession {
  for (const t of tracks) t.mode = t === track ? "showing" : "disabled";
  // `setTargetLatency(NaN)` changes nothing and reports the current target (NaN when unset).
  const previous = controller.setTargetLatency(Number.NaN);
  const applied = controller.setTargetLatency(CAPTIONS_LATENCY_SECONDS);
  // hls.js returns the clamped value it applied; native HLS returns the measured latency instead.
  return { previous, native: applied !== CAPTIONS_LATENCY_SECONDS };
}

export function captionsOff(controller: Latency, tracks: readonly TextTrack[], session: CaptionsSession | null): void {
  for (const t of tracks) t.mode = "disabled";
  if (!session || session.native) return;
  controller.setTargetLatency(Number.isFinite(session.previous) ? session.previous : DEFAULT_LIVE_LATENCY_SECONDS);
}

/** The stored style; the default when storage is missing, throws or holds anything else. */
export function readCaptionStyle(storage: () => Storage | null): CaptionStyle {
  try {
    const raw = storage()?.getItem(CAPTION_STYLE_KEY);
    if (!raw) return DEFAULT_CAPTION_STYLE;
    const v = JSON.parse(raw) as Partial<CaptionStyle>;
    return {
      size: (CAPTION_SIZES as readonly string[]).includes(v.size ?? "") ? (v.size as CaptionSize) : "medium",
      contrast: (CAPTION_CONTRASTS as readonly string[]).includes(v.contrast ?? "")
        ? (v.contrast as CaptionContrast)
        : "standard",
    };
  } catch {
    return DEFAULT_CAPTION_STYLE;
  }
}

/** Keep the style for this viewer; a storage that throws (private mode, quota) is ignored. */
export function writeCaptionStyle(storage: () => Storage | null, style: CaptionStyle): void {
  try {
    storage()?.setItem(CAPTION_STYLE_KEY, JSON.stringify(style));
  } catch {
    // The style still applies to this page.
  }
}

/** `localStorage`, or null where reading it throws. */
export function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The style as data attributes on the root element, which `captions.css` reads for `::cue`. */
export function applyCaptionStyle(root: HTMLElement | null, style: CaptionStyle): void {
  if (!root) return;
  root.dataset.ccSize = style.size;
  root.dataset.ccContrast = style.contrast;
}
