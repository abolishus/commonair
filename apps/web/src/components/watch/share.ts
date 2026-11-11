// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The watch pages' pure helpers (F11): the canonical URL Share copies, the `?t=` start time it can
 * carry, and the "More from" selection. No React here, so the edge cases are tested exhaustively.
 */
import type { VideoTile } from "../channel/video-grid.tsx";

export type WatchKind = "vod" | "clip";

/** How many cards "More from <channel>" shows. */
export const MORE_FROM_SIZE = 6;

/** The longest start time `?t=` accepts (48 h; longer than any recording the platform keeps). */
const MAX_START_SECONDS = 48 * 3600;

/** `https://host/<slug>/vods/<id>` (or `/clips/`), with `?t=<seconds>` when a start time is given. */
export function watchUrl(
  publicUrl: string,
  kind: WatchKind,
  slug: string,
  id: string,
  startSeconds: number | null = null,
): string {
  const path = `${encodeURIComponent(slug)}/${kind === "vod" ? "vods" : "clips"}/${encodeURIComponent(id)}`;
  const base = `${publicUrl.replace(/\/+$/, "")}/${path}`;
  const at = startSeconds === null ? 0 : Math.floor(startSeconds);
  return Number.isFinite(at) && at > 0 ? `${base}?t=${at}` : base;
}

/**
 * A `?t=` value as whole seconds: `90`, or the `1h2m3s` form other sites use (any part may be
 * left out). Null for anything else, zero, or past `MAX_START_SECONDS`.
 */
export function parseStartTime(raw: unknown): number | null {
  if (typeof raw === "number") return validStart(raw);
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (value === "") return null;
  if (/^\d{1,6}$/.test(value)) return validStart(Number(value));
  const m = /^(?:(\d{1,2})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s)?$/.exec(value);
  if (!m) return null;
  return validStart(Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0));
}

function validStart(seconds: number): number | null {
  if (!Number.isInteger(seconds)) return null;
  return seconds > 0 && seconds <= MAX_START_SECONDS ? seconds : null;
}

/** The VOD route's `validateSearch`: keeps only a valid `t`. */
export function parseWatchSearch(search: Record<string, unknown>): { t?: number } {
  const t = parseStartTime(search.t);
  return t === null ? {} : { t };
}

/** Seconds into the media from the player's wall clocks (micros), or null while either is unknown. */
export function playheadSeconds(playheadMicros: number | null, originMicros: number | null): number | null {
  if (playheadMicros === null || originMicros === null) return null;
  const seconds = Math.floor((playheadMicros - originMicros) / 1_000_000);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/** "More from": the channel's other items, in the API's order (newest first), at most `size`. */
export function moreFrom(tiles: readonly VideoTile[], currentId: string, size = MORE_FROM_SIZE): VideoTile[] {
  return tiles.filter((tile) => tile.id !== currentId).slice(0, Math.max(0, size));
}

/** The two player calls the `?t=` start needs (`WatchPlayerHandle` satisfies it). */
export interface StartSeekPlayer {
  originWallclock(): Date | null;
  seekToWallclock(t: Date): boolean;
}

/**
 * One attempt at the `?t=` start: "done" once the player moved there, "pending" while it does not
 * know media time 0 yet (or refused), "dropped" when `t` is past the recording, so the page stops
 * retrying and plays from the start. A `durationSeconds` of 0 or less means unknown.
 */
export function seekToStart(
  player: StartSeekPlayer | null,
  startSeconds: number,
  durationSeconds: number,
): "done" | "pending" | "dropped" {
  if (durationSeconds > 0 && startSeconds >= durationSeconds) return "dropped";
  const origin = player?.originWallclock() ?? null;
  if (!player || !origin) return "pending";
  return player.seekToWallclock(new Date(origin.getTime() + startSeconds * 1000)) ? "done" : "pending";
}

/**
 * "Up next" (D3.9): the item recorded right after the current one (lists are newest first, so the
 * one before it), else the newest other item. Null when the channel has nothing else.
 */
export function upNext(tiles: readonly VideoTile[], currentId: string): VideoTile | null {
  const at = tiles.findIndex((tile) => tile.id === currentId);
  if (at > 0) return tiles[at - 1] ?? null;
  return tiles.find((tile) => tile.id !== currentId) ?? null;
}

/** "Watch from this moment": the clip's place in its video as the video page's `?t=` (whole seconds). */
export function momentStart(vodOffsetSeconds: number | null): number | null {
  if (vodOffsetSeconds === null || !Number.isFinite(vodOffsetSeconds)) return null;
  const at = Math.floor(vodOffsetSeconds);
  return at > 0 ? at : null;
}

/** The browser's share sheet (`navigator.share`), when it has one. */
export type NativeShare = (data: { title: string; url: string }) => Promise<void>;

export function browserShare(): NativeShare | null {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") return null;
  return (data) => navigator.share(data);
}

/** Whether a share-sheet failure is the viewer closing it (not worth a message). */
export function shareCancelled(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
