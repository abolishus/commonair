// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * `VodPlayer`'s sources and states (W2-vod-watch, F28): an element error and a fatal hls.js error
 * show the error state; an HLS VOD goes through hls.js (stubbed: the media element itself runs in
 * happy-dom) with a quality menu built from its levels, or natively where the element plays HLS;
 * play, captions, seeking, and the wall-clock handle the replay panel uses.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { locale, t, uiMessages } from "../src/i18n/index.ts";
import { resetTheatreForTests, TheatreProvider } from "../src/player/theatre.ts";

type Listener = (event: string, data: { fatal: boolean }) => void;
const hlsState = vi.hoisted(() => ({
  supported: true,
  instances: [] as {
    url: string | null;
    media: HTMLVideoElement | null;
    destroyed: boolean;
    nextLevel: number;
    manualLevel: number;
    levels: unknown[];
    playingDate: Date | null;
    currentLevel: number;
    emit: (data: { fatal: boolean }) => void;
  }[],
  throwOnCreate: false,
  levels: null as unknown[] | null,
}));

vi.mock("hls.js", () => {
  class FakeHls {
    static Events = { ERROR: "hlsError" };
    static isSupported = () => hlsState.supported;
    url: string | null = null;
    media: HTMLVideoElement | null = null;
    destroyed = false;
    manualLevel = -1;
    playingDate: Date | null = null;
    currentLevel = 0;
    levels = [
      { height: 360, width: 640, frameRate: 30, bitrate: 800_000, videoCodec: "avc1" },
      { height: 1080, width: 1920, frameRate: 60, bitrate: 6_000_000, videoCodec: "avc1" },
      { height: 0, width: 0, frameRate: Number.NaN, bitrate: 128_000, videoCodec: undefined },
    ] as unknown[];
    private listeners: Listener[] = [];
    constructor() {
      if (hlsState.throwOnCreate) throw new Error("no MSE after all");
      if (hlsState.levels) this.levels = hlsState.levels;
      hlsState.instances.push(this);
    }
    get nextLevel() {
      return this.manualLevel;
    }
    set nextLevel(v: number) {
      this.manualLevel = v;
    }
    on(_event: string, fn: Listener) {
      this.listeners.push(fn);
    }
    emit(data: { fatal: boolean }) {
      for (const fn of this.listeners) fn("hlsError", data);
    }
    loadSource(url: string) {
      this.url = url;
    }
    attachMedia(video: HTMLVideoElement) {
      this.media = video;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return { default: FakeHls };
});

vi.mock("../src/lib/api.ts", () => ({ api: () => ({}), apiKeepalive: () => ({}) }));

const { VodPlayer } = await import("../src/components/vod-watch/vod-player.tsx");
type Props = React.ComponentProps<typeof VodPlayer>;
type Handle = NonNullable<Props["handleRef"]> extends React.Ref<infer H> ? H : never;

function mount(over: Partial<Props> = {}, opts: { theatre?: boolean } = {}) {
  const handleRef = React.createRef<Handle>();
  const props: Props = {
    source: { kind: "hls", url: "/media/vods/v/index.m3u8" },
    variant: "vod",
    title: "Night stream",
    durationSeconds: 120,
    captions: [],
    handleRef,
    ...over,
  };
  const view = render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        {opts.theatre ? (
          <TheatreProvider>
            <VodPlayer {...props} />
          </TheatreProvider>
        ) : (
          <VodPlayer {...props} />
        )}
      </TooltipProvider>
    </LocaleProvider>,
  );
  const video = screen.getByTestId("vod-player").querySelector("video") as HTMLVideoElement;
  return { ...view, video, handle: () => handleRef.current as Handle };
}
const chrome = () => screen.getByTestId("vod-player");
const fire = (video: HTMLVideoElement, name: string) => act(() => void video.dispatchEvent(new Event(name)));
function stubMedia(video: HTMLVideoElement, over: { duration?: number; readyState?: number } = {}) {
  let current = 0;
  Object.defineProperty(video, "duration", { configurable: true, get: () => over.duration ?? 120 });
  Object.defineProperty(video, "readyState", { configurable: true, get: () => over.readyState ?? 4 });
  Object.defineProperty(video, "currentTime", {
    configurable: true,
    get: () => current,
    set: (v: number) => void (current = v),
  });
  return { at: () => current };
}

beforeEach(() => {
  hlsState.supported = true;
  hlsState.instances.length = 0;
  hlsState.throwOnCreate = false;
  hlsState.levels = null;
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetTheatreForTests();
  window.matchMedia = ((q: string) => ({ matches: q === "(pointer: fine)" })) as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("states", () => {
  it("an element error replaces the loading skeleton with the error message", () => {
    const { video } = mount({ source: { kind: "mp4", url: "/media/clips/c.mp4", windowStartedAt: null } });
    expect(chrome().dataset.state).toBe("loading");
    fire(video, "error");
    expect(chrome().dataset.state).toBe("error");
    expect(chrome().textContent).toContain(t("replay.player.error"));
    expect(screen.queryByTestId("vod-player-loading")).toBeNull();
  });

  it("metadata takes the element's duration over the known one", () => {
    const { video } = mount({ source: { kind: "mp4", url: "/media/clips/c.mp4", windowStartedAt: null } });
    stubMedia(video, { duration: 95 });
    fire(video, "loadedmetadata");
    expect(chrome().dataset.state).toBe("ready");
    expect(screen.getByTestId("player-controls").textContent).toContain("0:00 / 1:35");
  });

  it("an mp4 clip plays from the element itself, without hls.js", () => {
    const { video } = mount({ source: { kind: "mp4", url: "/media/clips/c.mp4", windowStartedAt: null } });
    expect(video.getAttribute("src")).toBe("/media/clips/c.mp4");
    expect(hlsState.instances).toHaveLength(0);
  });
});

describe("HLS", () => {
  it("goes through hls.js where MSE works; a fatal error is the error state, a recoverable one is not", async () => {
    const { video } = mount();
    await waitFor(() => expect(hlsState.instances).toHaveLength(1));
    const hls = hlsState.instances[0]!;
    expect(hls.url).toBe("/media/vods/v/index.m3u8");
    expect(hls.media).toBe(video);
    expect(video.getAttribute("src")).toBeNull();
    act(() => hls.emit({ fatal: false }));
    expect(chrome().dataset.state).toBe("loading");
    act(() => hls.emit({ fatal: true }));
    expect(chrome().dataset.state).toBe("error");
    expect(chrome().textContent).toContain(t("replay.player.error"));
  });

  it("the quality menu lists hls.js levels highest first, and a pick sets the next level", async () => {
    const { video } = mount();
    await waitFor(() => expect(hlsState.instances).toHaveLength(1));
    stubMedia(video);
    fire(video, "loadedmetadata");
    fireEvent.click(screen.getByTestId("player-settings"));
    const section = await screen.findByTestId("player-settings-quality");
    expect([...section.querySelectorAll("label")].map((l) => l.textContent)).toEqual([
      t("player.settings.auto"),
      "1080p60",
      "360p",
      t("player.settings.audioOnly"),
    ]);
    expect(screen.getByTestId("player-settings-quality--1").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("player-settings-quality-1"));
    const hls = hlsState.instances[0]!;
    expect(hls.nextLevel).toBe(1);
    await waitFor(() =>
      expect(screen.getByTestId("player-settings-quality-1").getAttribute("aria-checked")).toBe("true"),
    );
  });

  it("hls.js failing to start is the error state", async () => {
    hlsState.throwOnCreate = true;
    mount();
    await waitFor(() => expect(chrome().dataset.state).toBe("error"));
    expect(chrome().textContent).toContain(t("replay.player.error"));
  });

  it("levels of one height order by bitrate; a level with no codec and no width is audio only", async () => {
    hlsState.levels = [
      { height: 720, width: 1280, frameRate: 30, bitrate: 2_000_000, videoCodec: "avc1" },
      { height: 720, width: 1280, frameRate: 30, bitrate: 3_500_000, videoCodec: "avc1" },
      { height: 0, frameRate: 0, bitrate: Number.NaN, videoCodec: "" },
    ];
    const { video } = mount();
    await waitFor(() => expect(hlsState.instances).toHaveLength(1));
    stubMedia(video);
    fire(video, "loadedmetadata");
    fireEvent.click(screen.getByTestId("player-settings"));
    const section = await screen.findByTestId("player-settings-quality");
    const radios = [...section.querySelectorAll<HTMLElement>('[data-testid^="player-settings-quality-"]')];
    expect(radios.map((r) => r.dataset.testid)).toEqual([
      "player-settings-quality--1",
      "player-settings-quality-1",
      "player-settings-quality-0",
      "player-settings-quality-2",
    ]);
    expect(section.textContent).toContain(t("player.settings.audioOnly"));
  });

  it("before any dates the handle knows no wall clock and cannot seek", async () => {
    const { video, handle } = mount();
    await waitFor(() => expect(hlsState.instances).toHaveLength(1));
    const { at } = stubMedia(video);
    expect(handle().originWallclock()).toBeNull();
    expect(handle().seekToWallclock(new Date("2026-11-01T12:00:00Z"))).toBe(false);
    expect(at()).toBe(0);
  });

  it("unmounting destroys hls.js and releases the element", async () => {
    const { video, unmount } = mount();
    await waitFor(() => expect(hlsState.instances).toHaveLength(1));
    const load = vi.spyOn(video, "load");
    unmount();
    expect(hlsState.instances[0]!.destroyed).toBe(true);
    expect(load).toHaveBeenCalled();
  });

  it("natively where the element plays HLS and MSE does not work", async () => {
    hlsState.supported = false;
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
    const { video } = mount();
    await waitFor(() => expect(video.getAttribute("src")).toBe("/media/vods/v/index.m3u8"));
    expect(hlsState.instances).toHaveLength(0);
  });

  it("the handle reads hls.js's wall clock and seeks within the media", async () => {
    const { video, handle } = mount();
    await waitFor(() => expect(hlsState.instances).toHaveLength(1));
    const { at } = stubMedia(video);
    const hls = hlsState.instances[0]!;
    expect(handle().playheadWallclock()).toBeNull();
    const playing = Date.parse("2026-11-01T12:00:30Z");
    hls.playingDate = new Date(playing);
    video.currentTime = 30;
    expect(handle().playheadWallclock()?.toISOString()).toBe("2026-11-01T12:00:30.000Z");
    // No fragment dates: the origin is the playing date less the playhead.
    expect(handle().originWallclock()?.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(handle().seekToWallclock(new Date("2026-11-01T12:01:10Z"))).toBe(true);
    expect(at()).toBe(70);
    expect(handle().seekToWallclock(new Date("2026-11-01T13:00:00Z"))).toBe(false);
    expect(at()).toBe(70);
    // Fragment dates win when the levels have them.
    hls.levels = [{ details: { fragments: [{ programDateTime: Date.parse("2026-11-01T11:59:50Z"), start: 0 }] } }];
    expect(handle().originWallclock()?.toISOString()).toBe("2026-11-01T11:59:50.000Z");
  });
});

describe("controls", () => {
  const mp4 = { kind: "mp4" as const, url: "/media/clips/c.mp4", windowStartedAt: "2026-11-01T12:00:00Z" };

  it("play follows the element; pressing it plays or pauses", () => {
    const { video } = mount({ source: mp4 });
    let paused = true;
    Object.defineProperty(video, "paused", { configurable: true, get: () => paused });
    const play = vi.spyOn(video, "play").mockImplementation(async () => {
      paused = false;
    });
    const pause = vi.spyOn(video, "pause").mockImplementation(() => {
      paused = true;
    });
    const button = screen.getByTestId("player-play");
    expect(button.getAttribute("aria-label")).toBe(t("replay.player.play"));
    fireEvent.click(button);
    expect(play).toHaveBeenCalledOnce();
    fire(video, "play");
    expect(button.getAttribute("aria-label")).toBe(t("replay.player.pause"));
    fireEvent.click(button);
    expect(pause).toHaveBeenCalledOnce();
    fire(video, "ended");
    expect(button.getAttribute("aria-label")).toBe(t("replay.player.play"));
  });

  it("captions: one toggle shows the page language's track and hides the others", () => {
    const { video } = mount({
      source: mp4,
      captions: [
        { language: "es", label: "Español", url: "/c/es.vtt" },
        { language: "en", label: "English", url: "/c/en.vtt" },
      ],
    });
    const tracks = [...video.querySelectorAll("track")];
    const modes = tracks.map(() => "disabled");
    tracks.forEach((el, i) =>
      Object.defineProperty(el, "track", {
        configurable: true,
        value: {
          get mode() {
            return modes[i] ?? "disabled";
          },
          set mode(m: string) {
            modes[i] = m;
          },
        },
      }),
    );
    const toggle = screen.getByTestId("vod-captions-toggle");
    expect(toggle.dataset.state).toBe("off");
    fireEvent.click(toggle);
    expect(toggle.dataset.state).toBe("on");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(modes).toEqual(["disabled", "showing"]);
    fireEvent.click(toggle);
    expect(modes).toEqual(["disabled", "disabled"]);
    expect(toggle.getAttribute("aria-label")).toBe(t("replay.player.captionsOn"));
  });

  it("captions: with no track in the page's language the first one shows", () => {
    const { video } = mount({
      source: mp4,
      captions: [
        { language: "fr", label: "Français", url: "/c/fr.vtt" },
        { language: "de", label: "Deutsch", url: "/c/de.vtt" },
      ],
    });
    const modes = ["disabled", "disabled"];
    [...video.querySelectorAll("track")].forEach((el, i) =>
      Object.defineProperty(el, "track", {
        configurable: true,
        value: {
          set mode(m: string) {
            modes[i] = m;
          },
        },
      }),
    );
    fireEvent.click(screen.getByTestId("vod-captions-toggle"));
    expect(modes).toEqual(["showing", "disabled"]);
  });

  it("no captions: no toggle", () => {
    mount({ source: mp4 });
    expect(screen.queryByTestId("vod-captions-toggle")).toBeNull();
  });

  it("the scrubber seeks the element; the playhead follows the clip's window", () => {
    const onPlayhead = vi.fn<(at: Date | null) => void>();
    const { video, handle } = mount({ source: mp4, onPlayhead });
    const { at } = stubMedia(video, { duration: 30 });
    fire(video, "loadedmetadata");
    const group = screen.getByRole("group", { name: t("replay.player.seek") });
    const thumb = group.querySelector<HTMLInputElement>('input[type="range"]');
    if (!thumb) throw new Error("no slider input");
    fireEvent.keyDown(thumb, { key: "End" });
    expect(at()).toBe(30);
    fire(video, "timeupdate");
    expect(chrome().dataset.playhead).toBe("2026-11-01T12:00:30.000Z");
    expect(onPlayhead).toHaveBeenLastCalledWith(new Date("2026-11-01T12:00:30Z"));
    expect(handle().originWallclock()?.toISOString()).toBe("2026-11-01T12:00:00.000Z");
  });
});

describe("shortcuts", () => {
  const mp4 = { kind: "mp4" as const, url: "/media/clips/c.mp4", windowStartedAt: null };
  /** True when the player left the key alone (the event was not prevented). */
  const press = (key: string) => fireEvent.keyDown(document.body, { key });

  it("up and down step the volume from muted, and unmute", () => {
    const { video } = mount({ source: mp4 });
    expect(video.muted).toBe(true);
    expect(press("ArrowUp")).toBe(false);
    expect(video.muted).toBe(false);
    expect(video.volume).toBeCloseTo(0.1);
    press("ArrowUp");
    expect(video.volume).toBeCloseTo(0.2);
    expect(press("ArrowDown")).toBe(false);
    expect(video.volume).toBeCloseTo(0.1);
  });

  it("arrows clamp to the known length while the element's is unknown", () => {
    const { video } = mount({ source: mp4, durationSeconds: 8 });
    let current = 6;
    Object.defineProperty(video, "duration", { configurable: true, get: () => Number.NaN });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => current,
      set: (v: number) => void (current = v),
    });
    press("ArrowRight");
    expect(current).toBe(8);
  });

  it("captions and theatre keys are left alone when there is nothing to toggle", () => {
    mount({ source: mp4 });
    expect(press("c")).toBe(true);
    expect(press("t")).toBe(true);
    expect(chrome().dataset.theatre).toBe("off");
  });

  it("t toggles theatre where the page offers it", () => {
    mount({ source: mp4 }, { theatre: true });
    expect(press("t")).toBe(false);
    expect(chrome().dataset.theatre).toBe("on");
    press("t");
    expect(chrome().dataset.theatre).toBe("off");
  });

  it("f is left alone without a fullscreen API, and toggles with one", async () => {
    const view = mount({ source: mp4 });
    expect(press("f")).toBe(true);
    view.unmount();
    const request = vi.fn<() => Promise<void>>(async () => undefined);
    Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: request });
    try {
      mount({ source: mp4 });
      expect(press("f")).toBe(false);
      await waitFor(() => expect(request).toHaveBeenCalledOnce());
    } finally {
      Reflect.deleteProperty(document, "fullscreenEnabled");
      Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
    }
  });
});
