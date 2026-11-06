// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Popups in fullscreen: `<body>` is not painted while the player is the fullscreen element, so the
 * captions style menu, the `?` shortcuts dialog and the tooltips portal into the player's popup
 * layer then (`data-slot="player-portal"`, out of the fullscreen grid's flow), and to `<body>`
 * otherwise. `?` no longer leaves fullscreen, and keys pressed inside a popup
 * portalled into the player are the popup's, not shortcuts. `document.fullscreenElement` is stubbed.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PlayerControllerOptions, SessionFeatures } from "../src/player/controller.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import { setP2PStorage } from "../src/player/p2p/preference.ts";
import { shortcutFor } from "../src/player/shortcuts.ts";
import { resetTheatreForTests } from "../src/player/theatre.ts";

class FakeController {
  static instances: FakeController[] = [];
  start = vi.fn<() => Promise<void>>(async () => undefined);
  stop = vi.fn<() => Promise<void>>(async () => undefined);
  disableP2P = vi.fn<() => void>();
  textTracks: ((tracks: TextTrackList) => void) | null = null;
  constructor(public opts: PlayerControllerOptions) {
    FakeController.instances.push(this);
  }
  dvrGrant = () => null;
  playheadWallclock = () => new Date();
  playbackMode = () => "live" as const;
  onPlaybackMode = () => () => undefined;
  onTextTrack = (cb: (tracks: TextTrackList) => void) => {
    this.textTracks = cb;
    return () => undefined;
  };
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

const FEATURES: SessionFeatures = { captions: { tracks: [], state: "active" }, dvr: null };

const defined: [object, string][] = [];
function define(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  defined.push([target, key]);
}

let exitSpy: ReturnType<typeof vi.fn<() => Promise<void>>>;
beforeEach(() => {
  FakeController.instances = [];
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
  exitSpy = vi.fn<() => Promise<void>>(async () => undefined);
  define(document, "fullscreenEnabled", true);
  define(document, "fullscreenElement", null);
  define(document, "exitFullscreen", exitSpy);
  define(HTMLElement.prototype, "requestFullscreen", async () => undefined);
});

afterEach(() => {
  cleanup();
  setP2PStorage(null);
  for (const [target, key] of defined.splice(0)) Reflect.deleteProperty(target, key);
});

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

async function playingLive() {
  wrap(<Player channel="rivertide" live />);
  await waitFor(() => expect(FakeController.instances).toHaveLength(1));
  const c = FakeController.instances[0]!;
  act(() => {
    c.opts.onFeatures?.(FEATURES);
    c.opts.onState("playing");
  });
  await screen.findByTestId("player-fullscreen");
  return c;
}

function layerOf(root: HTMLElement): Element {
  const layer = root.querySelector(':scope > [data-slot="player-portal"]');
  if (!layer) throw new Error("no popup layer");
  return layer;
}

/** The browser made `el` the fullscreen element. */
async function enterFullscreen(el: HTMLElement) {
  define(document, "fullscreenElement", el);
  act(() => void document.dispatchEvent(new Event("fullscreenchange")));
  await waitFor(() => expect(screen.getByTestId("player-fullscreen").getAttribute("data-state")).toBe("on"));
}

describe("the live player in fullscreen", () => {
  it("? opens the shortcuts dialog inside the player and stays in fullscreen", async () => {
    await playingLive();
    const root = screen.getByTestId("player");
    await enterFullscreen(root);
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    const dialog = await screen.findByTestId("player-shortcuts-dialog");
    expect(layerOf(root).contains(dialog)).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
    // Keys inside the portalled dialog are the dialog's: f does not toggle fullscreen from there.
    fireEvent.keyDown(dialog, { key: "f" });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("outside fullscreen the dialog portals to <body>, outside the player", async () => {
    await playingLive();
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    const dialog = await screen.findByTestId("player-shortcuts-dialog");
    expect(screen.getByTestId("player").contains(dialog)).toBe(false);
  });

  it("the captions style menu opens inside the player", async () => {
    const c = await playingLive();
    const track = { kind: "captions", language: "en", label: "English", mode: "disabled" } as unknown as TextTrack;
    act(() => c.textTracks?.([track] as unknown as TextTrackList));
    const root = screen.getByTestId("player");
    await enterFullscreen(root);
    act(() => void fireEvent.click(screen.getByTestId("player-captions-style")));
    const size = await screen.findByTestId("player-captions-size-large");
    expect(layerOf(root).contains(size)).toBe(true);
  });

  it("tooltips portal into the player too", async () => {
    await playingLive();
    const root = screen.getByTestId("player");
    await enterFullscreen(root);
    const fs = screen.getByTestId("player-fullscreen");
    act(() => {
      fireEvent.pointerEnter(fs);
      fireEvent.mouseEnter(fs);
      fireEvent.focus(fs);
    });
    const tip = await waitFor(() => {
      const el = document.querySelector('[data-slot="tooltip-content"]');
      if (!el) throw new Error("no tooltip");
      return el;
    });
    expect(layerOf(root).contains(tip)).toBe(true);
  });
});

describe("the VOD player in fullscreen", () => {
  it("? opens the dialog inside the player and stays in fullscreen", async () => {
    wrap(
      <VodPlayer
        source={{ kind: "mp4", url: "/media/clips/c.mp4", windowStartedAt: null }}
        variant="clip"
        title="The jump"
        durationSeconds={30}
        captions={[]}
      />,
    );
    const root = await screen.findByTestId("vod-player");
    await screen.findByTestId("player-fullscreen");
    await enterFullscreen(root);
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    const dialog = await screen.findByTestId("player-shortcuts-dialog");
    expect(layerOf(root).contains(dialog)).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("shortcutFor and portalled popups", () => {
  it("ignores keys from a dialog or menu inside the player, not from the player itself", () => {
    const root = document.createElement("section");
    root.innerHTML = '<div role="dialog"><button>x</button></div><div role="menu"><span tabindex="0">m</span></div>';
    document.body.append(root);
    const ev = (target: Element) => ({
      key: "k",
      target,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      defaultPrevented: false,
    });
    expect(shortcutFor(ev(root.querySelector("button")!), root)).toBeNull();
    expect(shortcutFor(ev(root.querySelector("[role=menu] span")!), root)).toBeNull();
    expect(shortcutFor(ev(root), root)).toBe("playPause");
    root.remove();
  });
});
