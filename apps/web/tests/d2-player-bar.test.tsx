// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D2-player (F3): the control bar. When it shows and hides (`usePlayerBar`, fake timers): on
 * pointer movement, keyboard focus inside it and tap; hidden after 3 s while playing, never while
 * paused, held, focused from the keyboard or under reduced motion. Then the live and VOD bars:
 * which controls each one has, and theatre mode's buttons with and without a page provider.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { PlayerChrome } from "@commonair/ui/blocks/media";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PlayerControllerOptions } from "../src/player/controller.ts";
import { locale, t, uiMessages } from "../src/i18n/index.ts";
import { BAR_HIDE_MS, usePlayerBar } from "../src/player/bar.ts";
import { DATA_MODE_STORAGE_KEY } from "../src/player/budget.ts";
import { setP2PStorage } from "../src/player/p2p/preference.ts";
import {
  THEATRE_CHAT_STORAGE_KEY,
  THEATRE_STORAGE_KEY,
  TheatreProvider,
  resetTheatreForTests,
  useTheatreChat,
} from "../src/player/theatre.ts";

class FakeController {
  static instances: FakeController[] = [];
  start = vi.fn<() => Promise<void>>(async () => undefined);
  stop = vi.fn<() => Promise<void>>(async () => undefined);
  disableP2P = vi.fn<() => void>();
  constructor(public opts: PlayerControllerOptions) {
    FakeController.instances.push(this);
  }
  playheadWallclock = () => null;
  playbackMode = () => "live" as const;
  onPlaybackMode = () => () => undefined;
}

vi.mock("../src/player/controller.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/player/controller.ts")>();
  return { ...real, PlayerController: FakeController };
});
vi.mock("../src/player/p2p/use-p2p.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/player/p2p/use-p2p.ts")>();
  return { ...real, useOperatorP2PDefault: () => "off" };
});
vi.mock("../src/lib/api.ts", () => ({ api: () => ({}), apiKeepalive: () => ({}) }));

const { Player } = await import("../src/player/player.tsx");
const { VodPlayer } = await import("../src/components/vod-watch/vod-player.tsx");

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

let reducedMotion = false;
beforeEach(() => {
  reducedMotion = false;
  FakeController.instances = [];
  window.sessionStorage.clear();
  window.localStorage.clear();
  resetTheatreForTests();
  const data = new Map<string, string>([["commonair:p2p-notice", "seen"]]);
  setP2PStorage(() => ({
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  }));
  window.matchMedia = ((q: string) => ({
    matches: q === "(pointer: fine)" || (reducedMotion && q === "(prefers-reduced-motion: reduce)"),
  })) as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setP2PStorage(null);
});

/** PlayerChrome with the hook's visibility, as the players wire it. */
function Bar({ playing, held = false }: { playing: boolean; held?: boolean }) {
  const bar = usePlayerBar({ playing });
  const { hold } = bar;
  React.useEffect(() => hold("menu", held), [hold, held]);
  return (
    <PlayerChrome
      data-testid="chrome"
      variant="vod"
      controlsVisible={bar.visible}
      controlsProps={{ "data-testid": "player-controls", ...bar.barProps }}
      {...bar.rootProps}
      controls={<button data-testid="in-bar">play</button>}
    >
      <video data-testid="picture">
        <track kind="captions" />
      </video>
    </PlayerChrome>
  );
}

const controls = () => screen.getByTestId("player-controls");
const shown = () => controls().getAttribute("data-visible");
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe("usePlayerBar", () => {
  it("while playing: shown at first, hidden after 3 s without activity; pointer movement shows it again", () => {
    vi.useFakeTimers();
    render(<Bar playing />);
    expect(shown()).toBe("true");
    advance(BAR_HIDE_MS - 1);
    expect(shown()).toBe("true");
    advance(1);
    expect(shown()).toBe("false");
    expect(controls().className).toContain("pointer-events-none");
    fireEvent.pointerMove(screen.getByTestId("chrome"), { pointerType: "mouse" });
    expect(shown()).toBe("true");
    // Each movement restarts the 3 s.
    advance(2_000);
    fireEvent.pointerMove(screen.getByTestId("chrome"), { pointerType: "mouse" });
    advance(2_000);
    expect(shown()).toBe("true");
    advance(1_000);
    expect(shown()).toBe("false");
  });

  it("leaving the player hides it at once while playing", () => {
    vi.useFakeTimers();
    render(<Bar playing />);
    fireEvent.pointerLeave(screen.getByTestId("chrome"), { pointerType: "mouse" });
    expect(shown()).toBe("false");
  });

  it("paused: never hides; resuming arms the timer", () => {
    vi.useFakeTimers();
    const view = render(<Bar playing={false} />);
    advance(60_000);
    fireEvent.pointerLeave(screen.getByTestId("chrome"), { pointerType: "mouse" });
    expect(shown()).toBe("true");
    view.rerender(<Bar playing />);
    advance(BAR_HIDE_MS);
    expect(shown()).toBe("false");
    view.rerender(<Bar playing={false} />);
    expect(shown()).toBe("true");
  });

  it("keyboard focus inside the bar keeps it; leaving the bar lets it hide again", () => {
    vi.useFakeTimers();
    render(<Bar playing />);
    act(() => screen.getByTestId("in-bar").focus());
    advance(BAR_HIDE_MS * 3);
    expect(shown()).toBe("true");
    act(() => screen.getByTestId("in-bar").blur());
    advance(BAR_HIDE_MS);
    expect(shown()).toBe("false");
  });

  it("focus that a click put there does not hold the bar", () => {
    vi.useFakeTimers();
    render(<Bar playing />);
    const button = screen.getByTestId("in-bar");
    fireEvent.pointerDown(button, { pointerType: "mouse" });
    act(() => button.focus());
    advance(BAR_HIDE_MS);
    expect(shown()).toBe("false");
  });

  it("a tap on the picture shows the bar, a second tap hides it; a tap on a control keeps it", () => {
    vi.useFakeTimers();
    render(<Bar playing />);
    advance(BAR_HIDE_MS);
    const picture = screen.getByTestId("picture");
    fireEvent.pointerDown(picture, { pointerType: "touch" });
    expect(shown()).toBe("true");
    fireEvent.pointerDown(screen.getByTestId("in-bar"), { pointerType: "touch" });
    expect(shown()).toBe("true");
    fireEvent.pointerDown(picture, { pointerType: "touch" });
    expect(shown()).toBe("false");
    // A touch never counts as hovering.
    fireEvent.pointerMove(picture, { pointerType: "touch" });
    expect(shown()).toBe("false");
  });

  it("a menu open from the bar holds it", () => {
    vi.useFakeTimers();
    const view = render(<Bar playing held />);
    advance(BAR_HIDE_MS * 2);
    expect(shown()).toBe("true");
    view.rerender(<Bar playing held={false} />);
    advance(BAR_HIDE_MS);
    expect(shown()).toBe("false");
  });

  it("reduced motion: the bar stays, so it never fades", () => {
    reducedMotion = true;
    vi.useFakeTimers();
    render(<Bar playing />);
    advance(BAR_HIDE_MS * 5);
    fireEvent.pointerLeave(screen.getByTestId("chrome"), { pointerType: "mouse" });
    expect(shown()).toBe("true");
    expect(controls().className).toContain("motion-reduce:transition-none");
  });

  it("without controlsVisible the chrome keeps its CSS-only hover behaviour", () => {
    render(
      <PlayerChrome variant="vod" controls={<button>x</button>}>
        <video>
          <track kind="captions" />
        </video>
      </PlayerChrome>,
    );
    const bar = document.querySelector('[data-slot="player-controls"]');
    expect(bar?.hasAttribute("data-visible")).toBe(false);
    expect(bar?.className).toContain("group-hover/player:opacity-100");
  });
});

async function livePlaying(node: React.ReactNode = <Player channel="rivertide" live />) {
  const view = wrap(node);
  await waitFor(() => expect(FakeController.instances).toHaveLength(1));
  const c = FakeController.instances[0];
  if (!c) throw new Error("no controller");
  act(() => c.opts.onState("playing"));
  return view;
}

describe("the live bar", () => {
  it("play, mute with a volume slider, settings; no time readout", async () => {
    await livePlaying();
    const bar = screen.getByTestId("player-controls");
    for (const id of ["player-play", "player-mute", "player-volume", "player-settings"])
      expect(bar.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    expect(screen.getByTestId("player-volume").querySelector("input[type=range]")?.getAttribute("aria-label")).toBe(
      "Volume",
    );
    expect(bar.textContent).not.toMatch(/\d:\d\d \/ /);
    expect(screen.getByTestId("player-mute").getAttribute("aria-label")).toBe("Unmute");
  });

  it("before playback only the settings gear; offline no bar controls at all", async () => {
    wrap(<Player channel="rivertide" live />);
    await waitFor(() => expect(FakeController.instances).toHaveLength(1));
    expect(screen.getByTestId("player-settings")).toBeTruthy();
    expect(screen.queryByTestId("player-play")).toBeNull();
    cleanup();
    wrap(<Player channel="rivertide" live={false} />);
    expect(screen.queryByTestId("player-settings")).toBeNull();
    expect(screen.queryByTestId("player-play")).toBeNull();
  });

  it("mute and the slider drive the video element", async () => {
    await livePlaying();
    const video = screen.getByTestId("player-video") as HTMLVideoElement;
    expect(video.muted).toBe(true);
    fireEvent.click(screen.getByTestId("player-mute"));
    expect(video.muted).toBe(false);
    expect(screen.getByTestId("player-mute").getAttribute("aria-label")).toBe("Mute");
  });

  it("play and pause follow the element", async () => {
    await livePlaying();
    const video = screen.getByTestId("player-video") as HTMLVideoElement;
    const pause = vi.spyOn(video, "pause");
    Object.defineProperty(video, "paused", { configurable: true, get: () => false });
    fireEvent.click(screen.getByTestId("player-play"));
    expect(pause).toHaveBeenCalled();
    act(() => void video.dispatchEvent(new Event("pause")));
    expect(screen.getByTestId("player-play").getAttribute("aria-label")).toBe("Play");
  });

  it("theatre: no button without a page provider (or in an embed); with one it toggles, and chat can collapse", async () => {
    await livePlaying();
    expect(screen.queryByTestId("player-theatre")).toBeNull();
    cleanup();
    FakeController.instances = [];
    await livePlaying(
      <TheatreProvider>
        <Player channel="rivertide" live embed />
      </TheatreProvider>,
    );
    expect(screen.queryByTestId("player-theatre")).toBeNull();
    cleanup();
    FakeController.instances = [];

    function ChatState() {
      const { chatHidden } = useTheatreChat();
      return <output data-testid="chat-state">{String(chatHidden)}</output>;
    }
    await livePlaying(
      <TheatreProvider>
        <Player channel="rivertide" live />
        <ChatState />
      </TheatreProvider>,
    );
    const button = screen.getByTestId("player-theatre");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("player-theatre-chat")).toBeNull();
    fireEvent.click(button);
    expect(screen.getByTestId("player").getAttribute("data-theatre")).toBe("on");
    expect(window.sessionStorage.getItem(THEATRE_STORAGE_KEY)).toBe("on");
    fireEvent.click(screen.getByTestId("player-theatre-chat"));
    expect(screen.getByTestId("chat-state").textContent).toBe("true");
    expect(window.sessionStorage.getItem(THEATRE_CHAT_STORAGE_KEY)).toBe("on");
    // Leaving theatre shows chat again, whatever was chosen inside it.
    fireEvent.click(screen.getByTestId("player-theatre"));
    expect(screen.getByTestId("chat-state").textContent).toBe("false");
    expect(window.sessionStorage.getItem(THEATRE_STORAGE_KEY)).toBeNull();
  });

  it("theatre is kept for the tab: a new page starts in it", async () => {
    window.sessionStorage.setItem(THEATRE_STORAGE_KEY, "on");
    await livePlaying(
      <TheatreProvider>
        <Player channel="rivertide" live />
      </TheatreProvider>,
    );
    expect(screen.getByTestId("player").getAttribute("data-theatre")).toBe("on");
  });

  it("theatre still toggles when storage throws (kept in memory)", async () => {
    const spy = vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    await livePlaying(
      <TheatreProvider>
        <Player channel="rivertide" live />
      </TheatreProvider>,
    );
    fireEvent.click(screen.getByTestId("player-theatre"));
    expect(screen.getByTestId("player").getAttribute("data-theatre")).toBe("on");
    spy.mockRestore();
  });
});

describe("the VOD bar", () => {
  it("play, volume, elapsed / total, settings with speed; no live-only controls", async () => {
    wrap(
      <VodPlayer
        source={{ kind: "mp4", url: "/media/clips/c.mp4", windowStartedAt: null }}
        variant="clip"
        title="The jump"
        durationSeconds={30}
        captions={[]}
      />,
    );
    const bar = screen.getByTestId("player-controls");
    for (const id of ["player-play", "player-mute", "player-volume", "player-settings"])
      expect(bar.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    expect(bar.textContent).toContain("0:00 / 0:30");
    expect(screen.getByTestId("player-settings-speed")).toBeTruthy();
    expect(screen.queryByTestId("player-data-saver-chip")).toBeNull();
    expect(screen.queryByTestId("data-mode-toggle")).toBeNull();
    // Speed applies to the element.
    const video = screen.getByTestId("vod-player").querySelector("video") as HTMLVideoElement;
    fireEvent.click(screen.getByTestId("player-settings-speed-1.5"));
    expect(video.playbackRate).toBe(1.5);
  });

  it("loading is a busy skeleton named for screen readers, then gone once the video has metadata (F28)", () => {
    wrap(
      <VodPlayer
        source={{ kind: "mp4", url: "/media/clips/c.mp4", windowStartedAt: null }}
        variant="clip"
        title="The jump"
        durationSeconds={30}
        captions={[]}
      />,
    );
    const loading = screen.getByTestId("vod-player-loading");
    expect(loading.getAttribute("aria-busy")).toBe("true");
    expect(loading.textContent).toBe(t("replay.player.loading"));
    expect(loading.querySelector('[data-slot="skeleton-thumbnail"]')).not.toBeNull();
    const video = screen.getByTestId("vod-player").querySelector("video") as HTMLVideoElement;
    act(() => {
      video.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(screen.queryByTestId("vod-player-loading")).toBeNull();
  });

  it("says data saver does not apply to videos when it is on", () => {
    window.localStorage.setItem(DATA_MODE_STORAGE_KEY, JSON.stringify({ on: true, mbPerHour: 50 }));
    wrap(
      <VodPlayer
        source={{ kind: "mp4", url: "/media/clips/c.mp4", windowStartedAt: null }}
        variant="clip"
        title="The jump"
        durationSeconds={30}
        captions={[]}
      />,
    );
    expect(screen.getByTestId("data-mode-notice").getAttribute("data-reason")).toBe("vod");
  });
});
