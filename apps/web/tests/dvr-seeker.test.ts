// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The DVR seeker on the player seam (ADR 0016): enter, seek, clamp, back to live, single flight. */
import { describe, expect, it, vi } from "vite-plus/test";
import type { DvrGrant } from "../src/player/controller.ts";
import {
  behindLiveSeconds,
  behindOf,
  DVR_LIVE_EDGE_SECONDS,
  DVR_WINDOW_MARGIN_SECONDS,
  DvrSeeker,
  isBackToLiveKey,
  isTypingTarget,
  positionOf,
  seekerFor,
  type DvrSeam,
} from "../src/player/dvr.ts";
import type { PlaybackMode } from "../src/player/media-clock.ts";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const GRANT: DvrGrant = { windowSeconds: 1800, playlistUrl: "https://origin.test/dvr/v/index.m3u8?t=dvr" };

/** A fake seam: DVR plays the window `[now - window, now - 8 s]`. */
function fakeSeam(opts: { enterOk?: boolean; grant?: DvrGrant | null } = {}) {
  let mode: PlaybackMode = "live";
  let playhead: Date | null = new Date(NOW - 5000);
  const release: (() => void)[] = [];
  const seam = {
    enterDvr: vi.fn<(url: string) => Promise<boolean>>(async () => {
      await new Promise<void>((r) => release.push(r));
      if (opts.enterOk === false) return false;
      mode = "dvr";
      return true;
    }),
    exitDvr: vi.fn<() => void>(() => {
      mode = "live";
      playhead = new Date(NOW - 5000);
    }),
    seekToWallclock: vi.fn<(t: Date) => boolean>((t: Date) => {
      const window = (opts.grant ?? GRANT).windowSeconds;
      const ok = t.getTime() >= NOW - window * 1000 && t.getTime() <= NOW - 8000;
      if (ok) playhead = t;
      return ok;
    }),
    playheadWallclock: () => playhead,
    playbackMode: () => mode,
    dvrGrant: () => (opts.grant === undefined ? GRANT : opts.grant),
  } satisfies DvrSeam;
  const flush = async () => {
    while (release.length > 0) release.shift()?.();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { seam, flush, mode: () => mode };
}

describe("positions", () => {
  it("maps behind-live seconds to a window position and back, clamped", () => {
    expect(positionOf(0, 1800)).toBe(1800);
    expect(positionOf(600, 1800)).toBe(1200);
    expect(positionOf(5000, 1800)).toBe(0);
    expect(behindOf(1200, 1800)).toBe(600);
    expect(behindOf(-5, 1800)).toBe(1800);
    expect(behindOf(4000, 1800)).toBe(0);
  });

  it("behind live is 0 at live and before the first frame", () => {
    const at = (mode: PlaybackMode, playhead: Date | null) =>
      behindLiveSeconds({ playbackMode: () => mode, playheadWallclock: () => playhead }, NOW);
    expect(at("live", new Date(NOW - 60_000))).toBe(0);
    expect(at("dvr", null)).toBe(0);
    expect(at("dvr", new Date(NOW - 60_000))).toBe(60);
    expect(at("dvr", new Date(NOW + 1000))).toBe(0);
  });
});

describe("DvrSeeker", () => {
  it("enters DVR on the grant's playlist, then seeks to the wall-clock time", async () => {
    const { seam, flush, mode } = fakeSeam();
    const s = new DvrSeeker(seam, () => NOW);
    const done = s.seek(1200);
    await flush();
    await done;
    expect(seam.enterDvr).toHaveBeenCalledWith(GRANT.playlistUrl);
    expect(seam.seekToWallclock).toHaveBeenCalledWith(new Date(NOW - 1_200_000));
    expect(mode()).toBe("dvr");
    // Already in DVR: seeks without loading again.
    await s.seek(600);
    expect(seam.enterDvr).toHaveBeenCalledTimes(1);
    expect(seam.seekToWallclock).toHaveBeenLastCalledWith(new Date(NOW - 600_000));
  });

  it("near the live edge goes back to live instead", async () => {
    const { seam } = fakeSeam();
    const s = new DvrSeeker(seam, () => NOW);
    await s.seek(DVR_LIVE_EDGE_SECONDS);
    expect(seam.enterDvr).not.toHaveBeenCalled();
    expect(seam.exitDvr).toHaveBeenCalledTimes(1);
  });

  it("the latest seek wins while the DVR playlist loads; live() cancels", async () => {
    const { seam, flush } = fakeSeam();
    const s = new DvrSeeker(seam, () => NOW);
    const first = s.seek(1700);
    void s.seek(900);
    void s.seek(300);
    await flush();
    await first;
    expect(seam.enterDvr).toHaveBeenCalledTimes(1);
    expect(seam.seekToWallclock.mock.calls.map(([t]) => (NOW - t.getTime()) / 1000)).toEqual([1700, 300]);

    const { seam: other, flush: flushOther } = fakeSeam();
    const cancelled = new DvrSeeker(other, () => NOW);
    const pending = cancelled.seek(600);
    cancelled.live();
    await flushOther();
    await pending;
    expect(other.seekToWallclock).not.toHaveBeenCalled();
    expect(other.exitDvr).toHaveBeenCalled();
  });

  it("past the old end of the window lands just inside it; beyond the DVR end goes live", async () => {
    const { seam, flush } = fakeSeam();
    const s = new DvrSeeker(seam, () => NOW);
    const p = s.seek(5000);
    await flush();
    await p;
    // Clamped to the window first (1800 s fits exactly).
    expect(seam.seekToWallclock).toHaveBeenLastCalledWith(new Date(NOW - 1_800_000));

    // The window slid on: 1800 s back is now out of range, so it lands margin seconds inside.
    seam.seekToWallclock.mockImplementationOnce(() => false);
    await s.seek(1800);
    expect(seam.seekToWallclock).toHaveBeenLastCalledWith(new Date(NOW - (1800 - DVR_WINDOW_MARGIN_SECONDS) * 1000));

    // Newer than the DVR playlist reaches.
    seam.seekToWallclock.mockImplementationOnce(() => false);
    await s.seek(20);
    expect(seam.exitDvr).toHaveBeenCalled();
  });

  it("a failed DVR load or no grant leaves the player on live without seeking", async () => {
    const failed = fakeSeam({ enterOk: false });
    const p = new DvrSeeker(failed.seam, () => NOW).seek(600);
    await failed.flush();
    await p;
    expect(failed.seam.seekToWallclock).not.toHaveBeenCalled();

    const none = fakeSeam({ grant: null });
    await new DvrSeeker(none.seam, () => NOW).seek(600);
    expect(none.seam.enterDvr).not.toHaveBeenCalled();
  });

  it("one seeker per controller", () => {
    const { seam } = fakeSeam();
    expect(seekerFor(seam)).toBe(seekerFor(seam));
    expect(seekerFor(fakeSeam().seam)).not.toBe(seekerFor(seam));
  });
});

describe("the L shortcut", () => {
  const key = (k: string, extra: Partial<KeyboardEvent> = {}, target: EventTarget | null = null) =>
    isBackToLiveKey({ key: k, ctrlKey: false, metaKey: false, altKey: false, target, ...extra });

  it("is L or l without modifiers, outside text fields", () => {
    expect(key("l")).toBe(true);
    expect(key("L")).toBe(true);
    expect(key("k")).toBe(false);
    expect(key("l", { ctrlKey: true })).toBe(false);
    expect(key("l", { metaKey: true })).toBe(false);
    expect(key("l", { altKey: true })).toBe(false);
    const input = { tagName: "INPUT" } as unknown as EventTarget;
    const textarea = { tagName: "TEXTAREA" } as unknown as EventTarget;
    const editable = { tagName: "DIV", isContentEditable: true } as unknown as EventTarget;
    const button = { tagName: "BUTTON" } as unknown as EventTarget;
    expect(key("l", {}, input)).toBe(false);
    expect(key("l", {}, textarea)).toBe(false);
    expect(key("l", {}, editable)).toBe(false);
    expect(key("l", {}, button)).toBe(true);
    expect(isTypingTarget(null)).toBe(false);
  });
});
