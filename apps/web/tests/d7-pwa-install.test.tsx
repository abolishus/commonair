// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * "Install CommonAir" (README D7.6): the account menu and You sheet entry, the browser glue
 * (beforeinstallprompt, iOS steps, watched time from media events) and the offer in context.
 */
import type { UserMenuItem } from "@commonair/ui/layouts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const track = vi.hoisted(() => vi.fn<(surface: string, action: string) => void>());
vi.mock("../src/lib/ui-metrics.ts", () => ({ trackUi: track }));

const consent = vi.hoisted(() => ({ ready: true, stored: { version: "1" }, policy: { version: "1" } }));
vi.mock("../src/lib/consent.ts", () => ({
  useConsent: () => consent,
  consentPrompt: (stored: { version: string } | null, version: string | null) =>
    stored && stored.version === version ? null : "none",
}));

import {
  InstallOfferCard,
  InstallRoot,
  IosInstallDialog,
  offerAllowedOn,
} from "../src/components/pwa/install-offer.tsx";
import { INSTALL_STORAGE_KEY, WATCH_THRESHOLD_MS, parseEngagement } from "../src/components/pwa/install-rule.ts";
import {
  type InstallPromptEvent,
  requestInstall,
  resetInstallStore,
  startInstallWatch,
  useInstall,
} from "../src/components/pwa/install-store.ts";
import { installItem, withInstallItem } from "../src/components/shell/account-items.tsx";
import { YouSheet } from "../src/components/shell/you-sheet.tsx";

let stop: () => void = () => undefined;

function stored() {
  return parseEngagement(window.localStorage.getItem(INSTALL_STORAGE_KEY));
}

function promptEvent(outcome: "accepted" | "dismissed") {
  const event = new Event("beforeinstallprompt", { cancelable: true }) as InstallPromptEvent;
  const prompt = vi.fn<() => Promise<void>>(() => Promise.resolve());
  Object.assign(event, { prompt, userChoice: Promise.resolve({ outcome }) });
  return { event, prompt };
}

function Probe(): React.JSX.Element {
  const state = useInstall();
  return <output data-testid="probe">{`${state.mode} ${String(state.offerDue)} ${String(state.iosOpen)}`}</output>;
}

function setAppleStandalone(value: boolean | undefined): void {
  if (value === undefined) Reflect.deleteProperty(navigator, "standalone");
  else Object.defineProperty(navigator, "standalone", { value, configurable: true });
}

beforeEach(() => {
  window.localStorage.clear();
  track.mockClear();
  resetInstallStore();
});

afterEach(() => {
  stop();
  stop = () => undefined;
  cleanup();
  setAppleStandalone(undefined);
  Reflect.deleteProperty(window, "onbeforeinstallprompt");
});

describe("the menu entry", () => {
  const signOut: UserMenuItem = { id: "signOut", label: "Sign out", separatorBefore: true };
  const settings: UserMenuItem = { id: "settings", label: "Settings" };

  it("is absent where the browser cannot install", () => {
    expect(installItem("none", "Riverside")).toBeNull();
    expect(withInstallItem([settings, signOut], null)).toEqual([settings, signOut]);
  });

  it.each(["prompt", "ios"] as const)("is 'Install {site}' in %s mode, just before Sign out", (mode) => {
    const item = installItem(mode, "Riverside");
    expect(item).toMatchObject({ id: "install", label: "Install Riverside", testId: "account-install" });
    expect(withInstallItem([settings, signOut], item).map((i) => i.id)).toEqual(["settings", "install", "signOut"]);
    expect(withInstallItem([settings], item).map((i) => i.id)).toEqual(["settings", "install"]);
  });

  it("closes the You sheet and starts installing when chosen there", () => {
    const onSelect = vi.fn<() => void>();
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const item = { ...installItem("prompt", "Riverside"), onSelect } as UserMenuItem;
    render(<YouSheet open onOpenChange={onOpenChange} items={[item]} />);
    fireEvent.click(screen.getByTestId("you-install"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("install state", () => {
  it("is 'none' until the browser offers to install", () => {
    Object.defineProperty(window, "onbeforeinstallprompt", { value: null, configurable: true });
    stop = startInstallWatch();
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("none false false");
  });

  it("holds beforeinstallprompt, prompts on Install and goes away once accepted", async () => {
    Object.defineProperty(window, "onbeforeinstallprompt", { value: null, configurable: true });
    stop = startInstallWatch();
    render(<Probe />);
    const { event, prompt } = promptEvent("accepted");
    act(() => {
      window.dispatchEvent(event);
    });
    // The browser's own install bar is held back: the menus and the offer ask instead.
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByTestId("probe").textContent).toBe("prompt false false");

    const accepted = vi.fn<() => void>();
    let outcome = "";
    await act(async () => {
      outcome = await requestInstall(accepted);
    });
    expect(outcome).toBe("accepted");
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith("pwa.install", "click");
    expect(screen.getByTestId("probe").textContent).toBe("none false false");
    expect(stored().dismissed).toBe(true);
  });

  it("counts a dismissed browser dialog and stops offering in context", async () => {
    Object.defineProperty(window, "onbeforeinstallprompt", { value: null, configurable: true });
    stop = startInstallWatch();
    act(() => {
      window.dispatchEvent(promptEvent("dismissed").event);
    });
    expect(await requestInstall()).toBe("dismissed");
    expect(track).toHaveBeenCalledWith("pwa.install", "dismiss");
    expect(stored().dismissed).toBe(true);
  });

  it("holds a beforeinstallprompt fired before the watch starts (before hydration)", () => {
    Object.defineProperty(window, "onbeforeinstallprompt", { value: null, configurable: true });
    const { event } = promptEvent("accepted");
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    stop = startInstallWatch();
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("prompt false false");
  });

  it("goes away when the app is installed from the browser's own menu", () => {
    Object.defineProperty(window, "onbeforeinstallprompt", { value: null, configurable: true });
    stop = startInstallWatch();
    render(<Probe />);
    act(() => {
      window.dispatchEvent(promptEvent("accepted").event);
    });
    act(() => {
      window.dispatchEvent(new Event("appinstalled"));
    });
    expect(screen.getByTestId("probe").textContent).toBe("none false false");
  });

  it("shows the Add to Home Screen steps on Apple's mobile WebKit, and never once installed", async () => {
    setAppleStandalone(false);
    stop = startInstallWatch();
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("ios false false");
    await act(async () => {
      expect(await requestInstall()).toBe("ios");
    });
    expect(screen.getByTestId("probe").textContent).toBe("ios false true");

    stop();
    cleanup();
    resetInstallStore();
    setAppleStandalone(true);
    stop = startInstallWatch();
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("none false false");
  });

  it("does nothing on Install where nothing can be installed", async () => {
    stop = startInstallWatch();
    expect(await requestInstall()).toBe("unavailable");
  });
});

describe("the visit and watch-time rule in the browser", () => {
  it("records this page load as a visit, and a later one after 30 minutes as the second", () => {
    let now = 1_000_000;
    stop = startInstallWatch(() => now);
    expect(stored().visits).toBe(1);
    stop();
    now += 31 * 60_000;
    stop = startInstallWatch(() => now);
    expect(stored().visits).toBe(2);
  });

  it("times playing videos from their media events and saves it on pause", () => {
    let now = 0;
    stop = startInstallWatch(() => now);
    const video = document.createElement("video");
    document.body.append(video);
    video.dispatchEvent(new Event("playing"));
    now = 90_000;
    video.dispatchEvent(new Event("pause"));
    expect(stored().watchedMs).toBe(90_000);
    // Other elements' events are not watching.
    const audio = document.createElement("audio");
    document.body.append(audio);
    audio.dispatchEvent(new Event("playing"));
    now = 200_000;
    audio.dispatchEvent(new Event("pause"));
    expect(stored().watchedMs).toBe(90_000);
    video.remove();
    audio.remove();
  });

  it("stops the clock when a playing video leaves the page without its pause", () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      stop = startInstallWatch(() => now);
      const video = document.createElement("video");
      Object.defineProperty(video, "paused", { value: false, configurable: true });
      document.body.append(video);
      video.dispatchEvent(new Event("playing"));
      now = 30_000;
      vi.advanceTimersByTime(30_000);
      expect(stored().watchedMs).toBe(30_000);
      // An SPA navigation unmounts the player: the element leaves first, so its teardown's
      // pause never reaches the document.
      video.remove();
      video.dispatchEvent(new Event("pause"));
      for (let step = 0; step < 10; step += 1) {
        now += 30_000;
        vi.advanceTimersByTime(30_000);
      }
      expect(stored().watchedMs).toBe(30_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the clock for a video found paused or ended at a flush", () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      stop = startInstallWatch(() => now);
      const video = document.createElement("video");
      let paused = false;
      Object.defineProperty(video, "paused", { get: () => paused, configurable: true });
      document.body.append(video);
      video.dispatchEvent(new Event("playing"));
      now = 30_000;
      vi.advanceTimersByTime(30_000);
      paused = true;
      now = 120_000;
      vi.advanceTimersByTime(90_000);
      expect(stored().watchedMs).toBe(30_000);
      video.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes the offer due on a second visit with 3 minutes watched", () => {
    window.localStorage.setItem(
      INSTALL_STORAGE_KEY,
      JSON.stringify({ visits: 1, lastSeenAt: 1, watchedMs: WATCH_THRESHOLD_MS, dismissed: false }),
    );
    setAppleStandalone(false);
    stop = startInstallWatch(() => 1 + 60 * 60_000);
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("ios true false");
  });

  it("survives storage that throws", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => {
      stop = startInstallWatch();
    }).not.toThrow();
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("none false false");
    spy.mockRestore();
    set.mockRestore();
  });
});

describe("the offer in context", () => {
  it("is allowed on browse pages only, so never over a player", () => {
    for (const path of ["/", "/directory", "/following", "/search"]) expect(offerAllowedOn(path), path).toBe(true);
    for (const path of ["/somebody", "/somebody/vods/x", "/dashboard", "/settings", "/signin", "/admin/coop"])
      expect(offerAllowedOn(path), path).toBe(false);
  });

  it("counts a view, installs or dismisses", () => {
    const onInstall = vi.fn<() => void>();
    const onDismiss = vi.fn<() => void>();
    render(<InstallOfferCard site="Riverside" aboveTabBar onInstall={onInstall} onDismiss={onDismiss} />);
    const card = screen.getByTestId("pwa-install-offer");
    expect(card.textContent).toContain("Install Riverside");
    expect(card.className).toContain("bottom-safe-tab-bar");
    expect(card.className).toContain("motion-safe:");
    expect(track).toHaveBeenCalledWith("pwa.install", "view");
    fireEvent.click(screen.getByTestId("pwa-install-offer-install"));
    fireEvent.click(screen.getByTestId("pwa-install-offer-dismiss"));
    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("shows when due on a browse page, not on a watch page, and is remembered once dismissed", () => {
    window.localStorage.setItem(
      INSTALL_STORAGE_KEY,
      JSON.stringify({ visits: 2, lastSeenAt: Date.now(), watchedMs: WATCH_THRESHOLD_MS, dismissed: false }),
    );
    setAppleStandalone(false);
    const { rerender } = render(<InstallRoot pathname="/somebody" site="Riverside" />);
    expect(screen.queryByTestId("pwa-install-offer")).toBeNull();
    rerender(<InstallRoot pathname="/" site="Riverside" />);
    expect(screen.getByTestId("pwa-install-offer")).toBeTruthy();
    fireEvent.click(screen.getByTestId("pwa-install-offer-dismiss"));
    expect(screen.queryByTestId("pwa-install-offer")).toBeNull();
    expect(stored().dismissed).toBe(true);
    expect(track).toHaveBeenCalledWith("pwa.install", "dismiss");
  });

  it("waits while the cookie banner asks", () => {
    window.localStorage.setItem(
      INSTALL_STORAGE_KEY,
      JSON.stringify({ visits: 2, lastSeenAt: Date.now(), watchedMs: WATCH_THRESHOLD_MS, dismissed: false }),
    );
    setAppleStandalone(false);
    consent.stored = { version: "0" };
    try {
      render(<InstallRoot pathname="/" site="Riverside" />);
      expect(screen.queryByTestId("pwa-install-offer")).toBeNull();
    } finally {
      consent.stored = { version: "1" };
    }
  });

  it("lists the Add to Home Screen steps", () => {
    const onOpenChange = vi.fn<(open: boolean) => void>();
    render(<IosInstallDialog site="Riverside" open onOpenChange={onOpenChange} />);
    const dialog = screen.getByTestId("pwa-install-ios");
    expect(dialog.textContent).toContain("Add Riverside to your Home Screen");
    expect(dialog.querySelectorAll("li")).toHaveLength(3);
    fireEvent.click(screen.getByTestId("pwa-install-ios-done"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
