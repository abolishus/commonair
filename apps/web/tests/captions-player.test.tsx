// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The player's CC toggle (ADR 0011): caption tracks found through the seam, latency raised while on
 * and restored after, native HLS left alone, the queued note, and the viewer's style in
 * `localStorage` (which may throw).
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { locale, uiMessages } from "../src/i18n/index.ts";
import {
  applyCaptionStyle,
  CAPTION_STYLE_KEY,
  CAPTIONS_LATENCY_SECONDS,
  captionsOff,
  captionsOn,
  captionTracks,
  DEFAULT_CAPTION_STYLE,
  DEFAULT_LIVE_LATENCY_SECONDS,
  pickTrack,
  readCaptionStyle,
  writeCaptionStyle,
} from "../src/player/captions-state.ts";
import { CaptionsToggle } from "../src/player/captions-toggle.tsx";
import type { PlayerController, SessionFeatures } from "../src/player/controller.ts";

const track = (kind: string, language: string) => ({ kind, language, mode: "disabled" }) as unknown as TextTrack;

/** hls.js's `setTargetLatency`: applies and returns the clamped value; NaN reports the current target. */
function hlsController(initial: number | null = null) {
  let target = initial;
  const calls: number[] = [];
  return {
    calls,
    setTargetLatency: (s: number) => {
      calls.push(s);
      if (!Number.isFinite(s)) return target ?? Number.NaN;
      target = Math.min(60, Math.max(1, s));
      return target;
    },
    get target() {
      return target;
    },
  };
}
/** Native HLS: no target; the call reports the measured latency and changes nothing. */
const nativeController = () => ({ calls: [] as number[], setTargetLatency: vi.fn<(s: number) => number>(() => 4.2) });

afterEach(() => cleanup());

describe("caption tracks", () => {
  it("are the subtitles and captions tracks; the session's language wins", () => {
    const list = [track("metadata", "en"), track("subtitles", "es"), track("captions", "en")];
    const found = captionTracks(list);
    expect(found.map((t) => t.kind)).toEqual(["subtitles", "captions"]);
    expect(pickTrack(found, "en")?.kind).toBe("captions");
    expect(pickTrack(found, "fr")?.language).toBe("es");
    expect(pickTrack([], "en")).toBeNull();
    expect(captionTracks(null)).toEqual([]);
  });
});

describe("latency", () => {
  it("on raises the target to 9 s and off restores the previous one", () => {
    const c = hlsController(4);
    const tracks = [track("subtitles", "en"), track("subtitles", "es")];
    const session = captionsOn(c, tracks, tracks[0]!);
    expect(CAPTIONS_LATENCY_SECONDS).toBeGreaterThanOrEqual(8);
    expect(CAPTIONS_LATENCY_SECONDS).toBeLessThanOrEqual(10);
    expect(c.target).toBe(CAPTIONS_LATENCY_SECONDS);
    expect(tracks.map((t) => t.mode)).toEqual(["showing", "disabled"]);
    expect(session).toEqual({ previous: 4, native: false });
    captionsOff(c, tracks, session);
    expect(c.target).toBe(4);
    expect(tracks.map((t) => t.mode)).toEqual(["disabled", "disabled"]);
  });

  it("with no target set before, off goes back to the low-latency default", () => {
    const c = hlsController(null);
    const tracks = [track("subtitles", "en")];
    const session = captionsOn(c, tracks, tracks[0]!);
    expect(Number.isNaN(session.previous)).toBe(true);
    captionsOff(c, tracks, session);
    expect(c.target).toBe(DEFAULT_LIVE_LATENCY_SECONDS);
  });

  it("native HLS: the tracks change, the latency does not", () => {
    const c = nativeController();
    const tracks = [track("subtitles", "en")];
    const session = captionsOn(c, tracks, tracks[0]!);
    expect(session.native).toBe(true);
    expect(tracks[0]!.mode).toBe("showing");
    const before = c.setTargetLatency.mock.calls.length;
    captionsOff(c, tracks, session);
    expect(c.setTargetLatency.mock.calls.length).toBe(before);
    expect(tracks[0]!.mode).toBe("disabled");
  });
});

describe("caption style", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    } as unknown as Storage;
  };
  const throwing = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceeded");
    },
  } as unknown as Storage;

  it("round-trips through storage; junk reads as the default", () => {
    const s = memory();
    writeCaptionStyle(() => s, { size: "large", contrast: "high" });
    expect(readCaptionStyle(() => s)).toEqual({ size: "large", contrast: "high" });
    s.setItem(CAPTION_STYLE_KEY, '{"size":"huge","contrast":7}');
    expect(readCaptionStyle(() => s)).toEqual(DEFAULT_CAPTION_STYLE);
    s.setItem(CAPTION_STYLE_KEY, "{");
    expect(readCaptionStyle(() => s)).toEqual(DEFAULT_CAPTION_STYLE);
  });

  it("a storage that throws, or none, never breaks the player", () => {
    expect(readCaptionStyle(() => throwing)).toEqual(DEFAULT_CAPTION_STYLE);
    expect(() => writeCaptionStyle(() => throwing, DEFAULT_CAPTION_STYLE)).not.toThrow();
    expect(readCaptionStyle(() => null)).toEqual(DEFAULT_CAPTION_STYLE);
    expect(
      readCaptionStyle(() => {
        throw new Error("denied");
      }),
    ).toEqual(DEFAULT_CAPTION_STYLE);
  });

  it("applies as root data attributes for ::cue", () => {
    const root = document.createElement("html");
    applyCaptionStyle(root, { size: "small", contrast: "high" });
    expect(root.dataset.ccSize).toBe("small");
    expect(root.dataset.ccContrast).toBe("high");
    expect(() => applyCaptionStyle(null, DEFAULT_CAPTION_STYLE)).not.toThrow();
  });
});

// ------------------------------------------------------------------ the component

class FakeTrackList extends EventTarget {
  items: TextTrack[] = [];
  get length() {
    return this.items.length;
  }
  add(t: TextTrack) {
    this.items.push(t);
    Object.defineProperty(this, this.items.length - 1, { value: t, configurable: true });
    this.dispatchEvent(new Event("addtrack"));
  }
}

function setup(state: SessionFeatures["captions"]["state"], preexisting = false) {
  const list = new FakeTrackList();
  if (preexisting) list.add(track("subtitles", "en"));
  const latency = hlsController(null);
  const listeners = new Set<(l: TextTrackList) => void>();
  const controller = {
    setTargetLatency: latency.setTargetLatency,
    onTextTrack: (cb: (l: TextTrackList) => void) => {
      const fire = () => cb(list as unknown as TextTrackList);
      list.addEventListener("addtrack", fire);
      listeners.add(cb);
      return () => list.removeEventListener("addtrack", fire);
    },
  } as unknown as PlayerController;
  const captions: SessionFeatures["captions"] = {
    tracks: state === "active" ? [{ language: "en", label: "English", url: "captions/en/index.m3u8" }] : [],
    state,
  };
  const Wrap = ({ children }: { children: React.ReactNode }) => (
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <section data-testid="player">
          {/* The player's own video, whose tracks hls.js filled before the control mounted. */}
          <video
            ref={(v) => {
              if (v) Object.defineProperty(v, "textTracks", { value: list, configurable: true });
            }}
          >
            <track kind="captions" />
          </video>
          {children}
        </section>
      </TooltipProvider>
    </LocaleProvider>
  );
  render(<CaptionsToggle controller={controller} captions={captions} />, { wrapper: Wrap });
  return { list, latency };
}

describe("CaptionsToggle", () => {
  it("renders nothing without a track, and the queued note while waiting for capacity", () => {
    setup("off");
    expect(screen.queryByTestId("player-captions-toggle")).toBeNull();
    expect(screen.queryByTestId("player-captions-queued")).toBeNull();
    cleanup();
    setup("queued");
    expect(screen.getByTestId("player-captions-queued").textContent).toBe("Captions waiting for capacity");
  });

  it("appears when the playlist brings a track; on and off move the latency and data-state", () => {
    const { list, latency } = setup("active");
    expect(screen.queryByTestId("player-captions-toggle")).toBeNull();
    act(() => list.add(track("subtitles", "en")));
    const button = screen.getByTestId("player-captions-toggle");
    expect(button.dataset.state).toBe("off");
    fireEvent.click(button);
    expect(button.dataset.state).toBe("on");
    expect(list.items[0]!.mode).toBe("showing");
    expect(latency.target).toBe(CAPTIONS_LATENCY_SECONDS);
    fireEvent.click(button);
    expect(button.dataset.state).toBe("off");
    expect(latency.target).toBe(DEFAULT_LIVE_LATENCY_SECONDS);
  });

  it("finds tracks hls.js added before it mounted", () => {
    setup("active", true);
    expect(screen.getByTestId("player-captions-toggle").dataset.state).toBe("off");
  });
});
