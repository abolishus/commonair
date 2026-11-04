// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D2-player (F3): the keyboard shortcuts. The map (`shortcutFor`) for every key and every place a
 * key may come from: the page body and the player act, text fields, chat and the rest of the page
 * never do, and a focused control keeps its own keys. Then each shortcut on the live player
 * (DVR's ±5 s included, with `L` still DVR's own and acting once), on the VOD player, and the `?`
 * dialog.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DvrGrant, PlayerControllerOptions, SessionFeatures } from "../src/player/controller.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import { DVR_LIVE_EDGE_SECONDS, seekerFor } from "../src/player/dvr.ts";
import { setP2PStorage } from "../src/player/p2p/preference.ts";
import { PLAYER_SHORTCUTS, SEEK_STEP_SECONDS, shortcutFor, type ShortcutAction } from "../src/player/shortcuts.ts";
import { TheatreProvider, resetTheatreForTests } from "../src/player/theatre.ts";

const GRANT: DvrGrant = { windowSeconds: 1800, playlistUrl: "https://play.example/dvr/v/index.m3u8?t=d" };

class FakeController {
  static instances: FakeController[] = [];
  start = vi.fn<() => Promise<void>>(async () => undefined);
  stop = vi.fn<() => Promise<void>>(async () => undefined);
  disableP2P = vi.fn<() => void>();
  static startMode: "live" | "dvr" = "live";
  mode: "live" | "dvr" = FakeController.startMode;
  behind = 0;
  exitDvr = vi.fn<() => void>();
  enterDvr = vi.fn<(url: string) => Promise<boolean>>(async () => true);
  seekToWallclock = vi.fn<(t: Date) => boolean>(() => true);
  constructor(public opts: PlayerControllerOptions) {
    FakeController.instances.push(this);
  }
  dvrGrant = () => GRANT;
  playheadWallclock = () => new Date(Date.now() - this.behind * 1000);
  playbackMode = () => this.mode;
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
// The CC control needs real text tracks; here it is a button that records presses.
const captionsPressed = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/player/captions-toggle.tsx", () => ({
  CaptionsToggle: () => (
    <button type="button" data-testid="player-captions-toggle" onClick={() => void (captionsPressed.count += 1)}>
      CC
    </button>
  ),
}));

const { Player } = await import("../src/player/player.tsx");
const { VodPlayer } = await import("../src/components/vod-watch/vod-player.tsx");

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

const FEATURES: SessionFeatures = { captions: { tracks: [], state: "active" }, dvr: GRANT };

let fullscreenSpy: ReturnType<typeof vi.fn<() => Promise<void>>>;
beforeEach(() => {
  FakeController.instances = [];
  captionsPressed.count = 0;
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.sessionStorage.setItem("commonair:player-settings-hint", "seen");
  resetTheatreForTests();
  const data = new Map<string, string>([["commonair:p2p-notice", "seen"]]);
  setP2PStorage(() => ({
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  }));
  window.matchMedia = ((q: string) => ({ matches: q === "(pointer: fine)" })) as typeof window.matchMedia;
  fullscreenSpy = vi.fn<() => Promise<void>>(async () => undefined);
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: true });
  Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, value: fullscreenSpy });
});

afterEach(() => {
  cleanup();
  setP2PStorage(null);
  Reflect.deleteProperty(document, "fullscreenEnabled");
  Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
});

const last = () => {
  const c = FakeController.instances.at(-1);
  if (!c) throw new Error("no controller");
  return c;
};

async function playing(node: React.ReactNode = <Player channel="rivertide" live />, features = FEATURES) {
  const view = wrap(node);
  await waitFor(() => expect(FakeController.instances).toHaveLength(1));
  act(() => {
    last().opts.onFeatures?.(features);
    last().opts.onState("playing");
  });
  return view;
}

const press = (key: string, target: Element = document.body, init: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(target, { key, ...init });

describe("shortcutFor", () => {
  const root = () => {
    const el = document.createElement("section");
    el.innerHTML =
      '<button data-x="btn">b</button><input data-x="range" type="range"><div role="radiogroup"><span data-x="radio" role="radio"></span></div><span data-x="plain" tabindex="0"></span>';
    document.body.append(el);
    return el;
  };
  const ev = (key: string, target: EventTarget | null, over: Partial<KeyboardEvent> = {}) => ({
    key,
    target,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    defaultPrevented: false,
    ...over,
  });
  const cases: [string, ShortcutAction][] = [
    [" ", "playPause"],
    ["k", "playPause"],
    ["K", "playPause"],
    ["m", "mute"],
    ["f", "fullscreen"],
    ["t", "theatre"],
    ["c", "captions"],
    ["ArrowLeft", "back"],
    ["ArrowRight", "forward"],
    ["ArrowUp", "volumeUp"],
    ["ArrowDown", "volumeDown"],
    ["?", "help"],
  ];

  it.each(cases)("%j on the page body is %s", (key, action) => {
    expect(shortcutFor(ev(key, document.body), null)).toBe(action);
  });

  it("every key in the map is covered above, and L is listed but left to the DVR controls", () => {
    const keys = PLAYER_SHORTCUTS.flatMap((s) => s.keys);
    expect(new Set(keys)).toEqual(new Set(cases.map(([k]) => (k === "K" ? "k" : k))));
    expect(PLAYER_SHORTCUTS.find((s) => s.action === "backToLive")?.caps).toEqual([["l"]]);
    expect(shortcutFor(ev("l", document.body), null)).toBeNull();
  });

  it("inside the player: a plain element acts; a focused control keeps its own keys", () => {
    const r = root();
    const at = (x: string) => r.querySelector(`[data-x="${x}"]`);
    expect(shortcutFor(ev(" ", at("plain")), r)).toBe("playPause");
    expect(shortcutFor(ev("ArrowLeft", at("plain")), r)).toBe("back");
    // Space presses the focused button, arrows move the slider or the radio.
    expect(shortcutFor(ev(" ", at("btn")), r)).toBeNull();
    expect(shortcutFor(ev("k", at("btn")), r)).toBe("playPause");
    expect(shortcutFor(ev("ArrowRight", at("range")), r)).toBeNull();
    expect(shortcutFor(ev("m", at("range")), r)).toBe("mute");
    expect(shortcutFor(ev("ArrowUp", at("radio")), r)).toBeNull();
    r.remove();
  });

  it("never with Ctrl, ⌘ or Alt, never when already handled", () => {
    for (const mod of ["ctrlKey", "metaKey", "altKey", "defaultPrevented"] as const)
      expect(shortcutFor(ev("f", document.body, { [mod]: true }), null)).toBeNull();
  });

  it("never in a text field, a textarea, a select or an editable element, inside the player or not", () => {
    const r = root();
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    Object.defineProperty(editable, "isContentEditable", { value: true });
    for (const el of [input, textarea, select, editable]) {
      r.append(el);
      expect(shortcutFor(ev("k", el), r), el.tagName).toBeNull();
    }
    r.remove();
  });

  it("never from elsewhere on the page (chat, links, buttons)", () => {
    const r = root();
    const chat = document.createElement("div");
    chat.innerHTML = '<ol tabindex="0" data-x="log"></ol><button data-x="send">Send</button>';
    document.body.append(chat);
    for (const el of chat.querySelectorAll("[data-x]"))
      for (const key of ["k", "m", "f", "t", "c", "ArrowLeft", "?"]) expect(shortcutFor(ev(key, el), r)).toBeNull();
    chat.remove();
    r.remove();
  });
});

describe("the live player's shortcuts", () => {
  it("space and k play and pause", async () => {
    await playing();
    const video = screen.getByTestId("player-video") as HTMLVideoElement;
    const pause = vi.spyOn(video, "pause");
    const play = vi.spyOn(video, "play").mockResolvedValue(undefined);
    let paused = false;
    Object.defineProperty(video, "paused", { configurable: true, get: () => paused });
    press("k");
    expect(pause).toHaveBeenCalledTimes(1);
    paused = true;
    press(" ");
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("m mutes and unmutes; up and down change the volume", async () => {
    await playing();
    const video = screen.getByTestId("player-video") as HTMLVideoElement;
    vi.spyOn(video, "play").mockResolvedValue(undefined);
    expect(video.muted).toBe(true);
    press("m");
    expect(video.muted).toBe(false);
    video.volume = 0.5;
    press("ArrowUp");
    expect(video.volume).toBeCloseTo(0.6);
    press("ArrowDown");
    press("ArrowDown");
    expect(video.volume).toBeCloseTo(0.4);
    press("m");
    expect(video.muted).toBe(true);
    // Up from muted starts at the bottom, unmuted.
    press("ArrowUp");
    expect(video.muted).toBe(false);
    expect(video.volume).toBeCloseTo(0.1);
  });

  it("f asks for fullscreen on the player container", async () => {
    await playing();
    await waitFor(() => expect(screen.getByTestId("player-fullscreen")).toBeTruthy());
    press("f");
    expect(fullscreenSpy).toHaveBeenCalledTimes(1);
    expect(fullscreenSpy.mock.contexts[0]).toBe(screen.getByTestId("player"));
  });

  it("t toggles theatre where the page offers it, and does nothing where it does not", async () => {
    await playing(
      <TheatreProvider>
        <Player channel="rivertide" live />
      </TheatreProvider>,
    );
    const player = screen.getByTestId("player");
    press("t");
    expect(player.getAttribute("data-theatre")).toBe("on");
    press("T");
    expect(player.getAttribute("data-theatre")).toBe("off");
    cleanup();
    FakeController.instances = [];
    await playing();
    press("t");
    expect(screen.getByTestId("player").getAttribute("data-theatre")).toBe("off");
  });

  it("below md there is no theatre button, so t does nothing and the dialog leaves it out", async () => {
    window.matchMedia = ((q: string) => ({
      matches: q === "(pointer: fine)" || q === "(max-width: 47.99rem)",
    })) as typeof window.matchMedia;
    await playing(
      <TheatreProvider>
        <Player channel="rivertide" live />
      </TheatreProvider>,
    );
    expect(screen.queryByTestId("player-theatre")).toBeNull();
    press("t");
    expect(screen.getByTestId("player").getAttribute("data-theatre")).toBe("off");
    press("?", document.body, { shiftKey: true });
    const dialog = await screen.findByTestId("player-shortcuts-dialog");
    const actions = [...dialog.querySelectorAll("dd")].map((d) => d.getAttribute("data-action"));
    expect(actions).not.toContain("theatre");
    expect(actions).toContain("fullscreen");
  });

  it("c presses the captions toggle", async () => {
    await playing();
    press("c");
    expect(captionsPressed.count).toBe(1);
  });

  it("DVR: left goes 5 s back (from live, just past the live edge), right 5 s on; L returns to live once", async () => {
    await playing();
    const c = last();
    const seek = vi.spyOn(seekerFor(c), "seek").mockResolvedValue(undefined);
    press("ArrowLeft");
    expect(seek).toHaveBeenLastCalledWith(DVR_LIVE_EDGE_SECONDS + SEEK_STEP_SECONDS);
    // At live there is nowhere forward to go.
    press("ArrowRight");
    expect(seek).toHaveBeenCalledTimes(1);
    c.mode = "dvr";
    c.behind = 60;
    press("ArrowLeft");
    expect(seek.mock.lastCall?.[0]).toBeCloseTo(60 + SEEK_STEP_SECONDS, 0);
    press("ArrowRight");
    expect(seek.mock.lastCall?.[0]).toBeCloseTo(60 - SEEK_STEP_SECONDS, 0);
  });

  it("L stays the DVR controls' key: back to live, once", async () => {
    FakeController.startMode = "dvr";
    try {
      await playing();
      expect(screen.getByTestId("player-dvr-live")).toBeTruthy();
      press("l");
      expect(last().exitDvr).toHaveBeenCalledTimes(1);
    } finally {
      FakeController.startMode = "live";
    }
  });

  it("without DVR (no grant, or data saver on) the arrows do nothing", async () => {
    await playing(<Player channel="rivertide" live />, { ...FEATURES, dvr: null });
    const seek = vi.spyOn(seekerFor(last()), "seek");
    press("ArrowLeft");
    expect(seek).not.toHaveBeenCalled();
  });

  it("none fire from a text field or from chat", async () => {
    await playing();
    const video = screen.getByTestId("player-video") as HTMLVideoElement;
    const pause = vi.spyOn(video, "pause");
    const outside = document.createElement("div");
    outside.innerHTML = '<input data-testid="chat-input"><ol data-testid="chat-log" tabindex="0"></ol>';
    document.body.append(outside);
    for (const id of ["chat-input", "chat-log"]) {
      const el = screen.getByTestId(id);
      for (const key of ["k", " ", "m", "f", "c", "?"]) press(key, el);
    }
    expect(pause).not.toHaveBeenCalled();
    expect(video.muted).toBe(true);
    expect(fullscreenSpy).not.toHaveBeenCalled();
    expect(captionsPressed.count).toBe(0);
    expect(screen.queryByTestId("player-shortcuts-dialog")).toBeNull();
    outside.remove();
  });

  it("? opens the dialog listing the shortcuts, DVR's included while rewinding is possible", async () => {
    await playing(
      <TheatreProvider>
        <Player channel="rivertide" live />
      </TheatreProvider>,
    );
    press("?", document.body, { shiftKey: true });
    const dialog = await screen.findByTestId("player-shortcuts-dialog");
    const actions = [...dialog.querySelectorAll("dd")].map((d) => d.getAttribute("data-action"));
    expect(actions).toEqual([
      "playPause",
      "mute",
      "volumeUp",
      "volumeDown",
      "back",
      "forward",
      "backToLive",
      "captions",
      "fullscreen",
      "theatre",
      "help",
    ]);
    expect(within(dialog).getByText("Play or pause")).toBeTruthy();
    expect(within(dialog).getByText("Keyboard shortcuts")).toBeTruthy();
  });

  it("the settings menu opens the same dialog; without DVR it lists no seeking", async () => {
    await playing(<Player channel="rivertide" live />, { ...FEATURES, dvr: null });
    fireEvent.click(screen.getByTestId("player-settings"));
    fireEvent.click(
      within(screen.getByTestId("player-settings-menu")).getByRole("button", { name: "Keyboard shortcuts" }),
    );
    const dialog = await screen.findByTestId("player-shortcuts-dialog");
    const actions = [...dialog.querySelectorAll("dd")].map((d) => d.getAttribute("data-action"));
    expect(actions).not.toContain("back");
    expect(actions).not.toContain("backToLive");
  });
});

describe("the VOD player's shortcuts", () => {
  function vod() {
    wrap(
      <VodPlayer
        source={{ kind: "mp4", url: "/media/clips/c.mp4", windowStartedAt: null }}
        variant="clip"
        title="The jump"
        durationSeconds={30}
        captions={[{ language: "en", label: "English", url: "/c/en.vtt" }]}
      />,
    );
    const video = screen.getByTestId("vod-player").querySelector("video") as HTMLVideoElement;
    let current = 10;
    Object.defineProperty(video, "duration", { configurable: true, get: () => 30 });
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => current,
      set: (v: number) => void (current = v),
    });
    return { video, at: () => current };
  }

  it("arrows seek 5 s, clamped to the video", () => {
    const { at } = vod();
    press("ArrowLeft");
    expect(at()).toBe(5);
    press("ArrowLeft");
    press("ArrowLeft");
    expect(at()).toBe(0);
    for (let i = 0; i < 8; i += 1) press("ArrowRight");
    expect(at()).toBe(30);
  });

  it("k plays, m mutes, c turns the captions on", () => {
    const { video } = vod();
    const play = vi.spyOn(video, "play").mockResolvedValue(undefined);
    Object.defineProperty(video, "paused", { configurable: true, get: () => true });
    press("k");
    expect(play).toHaveBeenCalled();
    press("m");
    expect(video.muted).toBe(false);
    press("c");
    expect(screen.getByTestId("vod-captions-toggle").getAttribute("data-state")).toBe("on");
  });

  it("? opens the dialog with seeking and without back to live", async () => {
    vod();
    press("?");
    const dialog = await screen.findByTestId("player-shortcuts-dialog");
    const actions = [...dialog.querySelectorAll("dd")].map((d) => d.getAttribute("data-action"));
    expect(actions).toContain("back");
    expect(actions).not.toContain("backToLive");
  });
});
