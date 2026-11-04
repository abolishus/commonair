// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D2-player (F5): the settings menu. Quality from the session's renditions with Auto (locked
 * while data saver is on), Data saver moved into the menu (no card under the player any more),
 * the "Data saver · <level>" chip, and the one-time hint on the gear, dismissed per tab.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PlayerControllerOptions, QualityLevel } from "../src/player/controller.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import { DATA_MODE_STORAGE_KEY } from "../src/player/budget.ts";
import { SETTINGS_HINT_KEY, qualityLabel, resetSettingsHintForTests } from "../src/player/controls.tsx";
import { setP2PStorage } from "../src/player/p2p/preference.ts";

const LEVELS: QualityLevel[] = [
  { index: 0, height: 360, frameRate: 30, bitrate: 800_000, audioOnly: false },
  { index: 1, height: 1080, frameRate: 60, bitrate: 6_000_000, audioOnly: false },
  { index: 2, height: 720, frameRate: 30, bitrate: 3_000_000, audioOnly: false },
  { index: 3, height: null, frameRate: null, bitrate: 96_000, audioOnly: true },
];

class FakeController {
  static instances: FakeController[] = [];
  start = vi.fn<() => Promise<void>>(async () => undefined);
  stop = vi.fn<() => Promise<void>>(async () => undefined);
  disableP2P = vi.fn<() => void>();
  setDataMode = vi.fn<(c: number | null) => void>();
  levels: QualityLevel[] = LEVELS;
  pick = -1;
  setQuality = vi.fn<(i: number) => void>((i) => {
    this.pick = i;
  });
  constructor(public opts: PlayerControllerOptions) {
    FakeController.instances.push(this);
  }
  qualityLevels = () => this.levels;
  quality = () => this.pick;
  playheadWallclock = () => null;
  playbackMode = () => "live" as const;
  onPlaybackMode = () => () => undefined;
  dataUsage = () => ({ bytes: 0, mbPerHour: 0 });
  playableLevels = () => [];
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

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  FakeController.instances = [];
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetSettingsHintForTests();
  const data = new Map<string, string>([["commonair:p2p-notice", "seen"]]);
  setP2PStorage(() => ({
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  }));
  window.matchMedia = ((q: string) => ({ matches: q === "(pointer: fine)" })) as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  setP2PStorage(null);
});

const last = () => {
  const c = FakeController.instances.at(-1);
  if (!c) throw new Error("no controller");
  return c;
};

async function playing(node: React.ReactNode = <Player channel="rivertide" live />) {
  const view = wrap(node);
  await waitFor(() => expect(FakeController.instances).toHaveLength(1));
  act(() => last().opts.onState("playing"));
  return view;
}

const menu = () => screen.getByTestId("player-settings-menu");
const openMenu = () => fireEvent.click(screen.getByTestId("player-settings"));
const radioLabels = (testId: string) =>
  [...screen.getByTestId(testId).querySelectorAll("label")].map((l) => l.textContent);

describe("quality", () => {
  it("Auto first, then the renditions highest first, labelled by height and frame rate", async () => {
    await playing();
    openMenu();
    expect(radioLabels("player-settings-quality")).toEqual(["Auto", "1080p60", "720p", "360p", "Audio only"]);
    expect(screen.getByTestId("player-settings-quality--1").getAttribute("aria-checked")).toBe("true");
  });

  it("picking one tells the controller, and the menu shows the pick; Auto goes back", async () => {
    await playing();
    openMenu();
    fireEvent.click(screen.getByTestId("player-settings-quality-2"));
    expect(last().setQuality).toHaveBeenLastCalledWith(2);
    expect(screen.getByTestId("player-settings-quality-2").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("player-settings-quality--1"));
    expect(last().setQuality).toHaveBeenLastCalledWith(-1);
  });

  it("one rendition or none (native HLS): no quality section", async () => {
    await playing();
    act(() => void (last().levels = [LEVELS[0] as QualityLevel]));
    openMenu();
    expect(screen.queryByTestId("player-settings-quality")).toBeNull();
  });

  it("while data saver is on the quality is Auto and locked, with the reason", async () => {
    window.localStorage.setItem(DATA_MODE_STORAGE_KEY, JSON.stringify({ on: true, mbPerHour: 800 }));
    await playing();
    openMenu();
    const section = screen.getByTestId("player-settings-quality");
    expect(section.hasAttribute("disabled") || section.hasAttribute("data-disabled")).toBe(true);
    expect(section.textContent).toContain("Data saver picks the quality while it is on.");
    expect(last().setQuality).toHaveBeenCalledWith(-1);
  });

  it("labels: frame rates of 30 and below are not shown; unknown height falls back to the bitrate", () => {
    expect(qualityLabel({ height: 480, frameRate: 30, bitrate: 1, audioOnly: false }, "en")).toBe("480p");
    expect(qualityLabel({ height: 720, frameRate: 59.94, bitrate: 1, audioOnly: false }, "en")).toBe("720p60");
    expect(qualityLabel({ height: null, frameRate: null, bitrate: 1_500_000, audioOnly: false }, "en")).toBe(
      "1,500 kb/s",
    );
    expect(qualityLabel({ height: null, frameRate: null, bitrate: 1, audioOnly: true }, "en")).toBe("Audio only");
  });
});

describe("data saver in the menu", () => {
  it("lives inside the settings menu, not under the player", async () => {
    await playing();
    const toggle = screen.getByTestId("data-mode-toggle");
    expect(menu().contains(toggle)).toBe(true);
    // Inside the player (so it shows in fullscreen), hidden until the gear opens it.
    expect(screen.getByTestId("player").contains(menu())).toBe(true);
    expect(menu().hidden).toBe(true);
    expect(
      screen.getByTestId("player").nextElementSibling?.querySelector('[data-testid="data-mode-toggle"]') ?? null,
    ).toBeNull();
    // The card's border is gone inside the menu.
    expect(toggle.closest("section")?.className).not.toContain("border");
    openMenu();
    expect(menu().hidden).toBe(false);
    expect(screen.getByTestId("player-settings").getAttribute("aria-expanded")).toBe("true");
    expect(within(menu()).getByText("Data saver")).toBeTruthy();
  });

  it("opening moves focus into the menu; Escape and the close button return it to the gear; a press outside closes", async () => {
    await playing();
    const gear = screen.getByTestId("player-settings");
    openMenu();
    await waitFor(() => expect(menu().contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(menu(), { key: "Escape" });
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(gear);
    openMenu();
    fireEvent.click(within(menu()).getByRole("button", { name: "Close settings" }));
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(gear);
    openMenu();
    fireEvent.pointerDown(document.body);
    expect(menu().hidden).toBe(true);
    expect(gear.getAttribute("aria-expanded")).toBe("false");
  });

  it("an embed has the menu (quality) but no data saver", async () => {
    await playing(<Player channel="rivertide" live embed />);
    openMenu();
    expect(screen.getByTestId("player-settings-quality")).toBeTruthy();
    expect(screen.queryByTestId("data-mode-toggle")).toBeNull();
  });
});

describe("the data saver chip", () => {
  it("shows the level while a budget is on and goes when it is turned off", async () => {
    window.localStorage.setItem(DATA_MODE_STORAGE_KEY, JSON.stringify({ on: true, mbPerHour: 800 }));
    await playing();
    const chip = screen.getByTestId("player-data-saver-chip");
    expect(chip.textContent).toBe("Data saver · Low");
    expect(screen.getByTestId("player-controls").contains(chip)).toBe(true);
    fireEvent.click(screen.getByTestId("data-mode-toggle"));
    expect(screen.queryByTestId("player-data-saver-chip")).toBeNull();
  });

  it("names every preset, and a custom budget by its number", async () => {
    for (const [mb, text] of [
      [50, "Data saver · Audio"],
      [1900, "Data saver · Medium"],
      [300, "Data saver · 300 MB/h"],
    ] as const) {
      window.localStorage.setItem(DATA_MODE_STORAGE_KEY, JSON.stringify({ on: true, mbPerHour: mb }));
      FakeController.instances = [];
      await playing();
      expect(screen.getByTestId("player-data-saver-chip").textContent).toBe(text);
      cleanup();
    }
  });

  it("off: no chip; turning it on in the menu adds it", async () => {
    await playing();
    expect(screen.queryByTestId("player-data-saver-chip")).toBeNull();
    fireEvent.click(screen.getByTestId("data-mode-toggle"));
    expect(screen.getByTestId("player-data-saver-chip").textContent).toBe("Data saver · Low");
  });

  it("an embed never shows it", async () => {
    window.localStorage.setItem(DATA_MODE_STORAGE_KEY, JSON.stringify({ on: true, mbPerHour: 800 }));
    await playing(<Player channel="rivertide" live embed />);
    expect(screen.queryByTestId("player-data-saver-chip")).toBeNull();
  });
});

describe("the one-time hint", () => {
  it("appears on the gear once playing, not before; Got it dismisses it for the tab", async () => {
    wrap(<Player channel="rivertide" live />);
    await waitFor(() => expect(FakeController.instances).toHaveLength(1));
    expect(screen.queryByTestId("player-settings-hint")).toBeNull();
    act(() => last().opts.onState("playing"));
    const hint = await screen.findByTestId("player-settings-hint");
    expect(hint.textContent).toContain("Quality and Data saver moved");
    // It never takes focus from the viewer.
    expect(hint.contains(document.activeElement)).toBe(false);
    fireEvent.click(within(hint).getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(screen.queryByTestId("player-settings-hint")).toBeNull());
    expect(window.sessionStorage.getItem(SETTINGS_HINT_KEY)).toBe("seen");
    cleanup();
    FakeController.instances = [];
    await playing();
    expect(screen.queryByTestId("player-settings-hint")).toBeNull();
  });

  it("opening the menu dismisses it too", async () => {
    await playing();
    await screen.findByTestId("player-settings-hint");
    openMenu();
    await waitFor(() => expect(screen.queryByTestId("player-settings-hint")).toBeNull());
    expect(window.sessionStorage.getItem(SETTINGS_HINT_KEY)).toBe("seen");
  });

  it("says why when the browser asked to save data", async () => {
    Object.defineProperty(navigator, "connection", { configurable: true, value: { saveData: true } });
    try {
      await playing();
      expect((await screen.findByTestId("player-settings-hint")).textContent).toContain(
        "Your browser asked to save data",
      );
    } finally {
      Reflect.deleteProperty(navigator, "connection");
    }
  });

  it("embeds get no hint; blocked storage still dismisses it for the page", async () => {
    await playing(<Player channel="rivertide" live embed />);
    expect(screen.queryByTestId("player-settings-hint")).toBeNull();
    cleanup();
    FakeController.instances = [];
    const spy = vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    try {
      await playing();
      const hint = await screen.findByTestId("player-settings-hint");
      fireEvent.click(within(hint).getByRole("button", { name: "Got it" }));
      cleanup();
      FakeController.instances = [];
      await playing();
      expect(screen.queryByTestId("player-settings-hint")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
