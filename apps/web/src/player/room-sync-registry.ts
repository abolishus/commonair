// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * How a watch room reaches this channel's player (decision (r)). The player and the chat panel are
 * siblings on `/$channel` and share no React state, so the player registers its steering seam here
 * by channel, beside its media clock (`media-clock.ts`), and the room drawer asks for it.
 *
 * Until the player registers (`registerRoomPlayer`, called from `player.tsx`), `roomPlayer` falls
 * back to the media clock plus the page's `player-video` element: seek-only correction, which works
 * for hls.js and native playback alike but cannot steer the hold-back.
 */
import { prefersNativeHls } from "./controller.ts";
import { playbackMode, playheadWallclock, type PlaybackMode } from "./media-clock.ts";
import { liveEdgeMs, roomReport, type RoomPlayer, type RoomReport } from "./room-sync.ts";

/** What `player.tsx` registers: the controller's steering seam. */
export interface RoomPlayerSource {
  setTargetLatency(seconds: number): number;
  seekToWallclock(t: Date): boolean;
  playheadWallclock(): Date | null;
  playbackMode(): "live" | "dvr";
  /** Optional: the player's live latency in seconds (hls.js `latency`), null when unknown. */
  latencySeconds?(): number | null;
}

const registry = new Map<string, { source: RoomPlayerSource; native: boolean }[]>();

/** Register `source` as `channel`'s player for rooms; the returned function unregisters it (idempotent). */
export function registerRoomPlayer(channel: string, source: RoomPlayerSource, native: boolean): () => void {
  const entry = { source, native };
  const stack = registry.get(channel) ?? [];
  stack.push(entry);
  registry.set(channel, stack);
  return () => {
    const current = registry.get(channel);
    if (!current) return;
    const i = current.indexOf(entry);
    if (i === -1) return;
    current.splice(i, 1);
    if (current.length === 0) registry.delete(channel);
  };
}

function nativePlayback(video: HTMLVideoElement): boolean {
  const mse = typeof window !== "undefined" && ("MediaSource" in window || "ManagedMediaSource" in window);
  return prefersNativeHls(video, mse);
}

const PLAYER_VIDEO = '[data-testid="player-video"]';

function seekableEnd(video: HTMLVideoElement | null): number | null {
  const ranges = video?.seekable;
  if (!ranges || ranges.length === 0) return null;
  try {
    return ranges.end(ranges.length - 1);
  } catch {
    return null;
  }
}

/** The live edge from the player's latency, else from the video element's `seekable` (native HLS). */
function edgeOf(
  mode: PlaybackMode,
  head: Date | null,
  latency: number | null,
  video: HTMLVideoElement | null,
): Date | null {
  const ms = liveEdgeMs({
    mode,
    playheadMs: head?.getTime() ?? null,
    latencySeconds: latency,
    seekableEnd: seekableEnd(video),
    currentTime: video && Number.isFinite(video.currentTime) ? video.currentTime : null,
  });
  return ms === null ? null : new Date(ms);
}

/** The fallback: the media clock and a seek on the page's video element. */
function domPlayer(channel: string, doc: Document): RoomPlayer | null {
  const video = doc.querySelector<HTMLVideoElement>(PLAYER_VIDEO);
  if (!video) return null;
  return {
    playheadWallclock: () => playheadWallclock(channel),
    playbackMode: () => playbackMode(channel),
    edgeWallclock: () => edgeOf(playbackMode(channel), playheadWallclock(channel), null, video),
    seekToWallclock: (t) => {
      const head = playheadWallclock(channel);
      if (!head || video.readyState < 1) return false;
      const next = video.currentTime + (t.getTime() - head.getTime()) / 1000;
      if (!Number.isFinite(next) || next < 0) return false;
      video.currentTime = next;
      return true;
    },
    native: nativePlayback(video),
  };
}

/** The room's view of this channel's player, or null when none is mounted. */
export function roomPlayer(channel: string, doc: Document | null = globalThis.document ?? null): RoomPlayer | null {
  const stack = registry.get(channel);
  const top = stack?.[stack.length - 1];
  if (top) {
    const s = top.source;
    return {
      playheadWallclock: () => s.playheadWallclock(),
      playbackMode: () => s.playbackMode(),
      seekToWallclock: (t) => s.seekToWallclock(t),
      ...(top.native ? {} : { setTargetLatency: (sec: number) => s.setTargetLatency(sec) }),
      ...(s.latencySeconds ? { latencySeconds: () => s.latencySeconds?.() ?? null } : {}),
      // hls.js knows its latency; native HLS (no latency) falls back to the element's `seekable`.
      edgeWallclock: () =>
        edgeOf(
          s.playbackMode(),
          s.playheadWallclock(),
          s.latencySeconds?.() ?? null,
          doc?.querySelector<HTMLVideoElement>(PLAYER_VIDEO) ?? null,
        ),
      native: top.native,
    };
  }
  return doc ? domPlayer(channel, doc) : null;
}

/**
 * What this member reports with every `room.sync` (batch 8): the playhead, the mode and the live
 * edge (null in DVR). Without a mounted player, the media clock alone and no edge.
 */
export function roomSyncReport(channel: string, doc: Document | null = globalThis.document ?? null): RoomReport {
  return (
    roomReport(roomPlayer(channel, doc)) ?? {
      at: playheadWallclock(channel),
      mode: playbackMode(channel),
      edge: null,
    }
  );
}
