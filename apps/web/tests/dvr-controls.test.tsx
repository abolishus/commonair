// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The DVR scrubber and controls (docs/testing/w2-selectors.md "Live DVR"): keyboard on the slider,
 * back to live by button and `L`, the behind-live readout, hidden in data mode and with window 0.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { locale, t, uiMessages } from "../src/i18n/index.ts";
import type { DvrGrant, PlayerController } from "../src/player/controller.ts";
import { DvrControls, DvrScrubber, type DvrSlotProps } from "../src/player/dvr-controls.tsx";
import type { PlaybackMode } from "../src/player/media-clock.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const GRANT: DvrGrant = { windowSeconds: 1800, playlistUrl: "https://origin.test/dvr/v/index.m3u8?t=dvr" };

function fakeController(initial: { mode?: PlaybackMode; behind?: number } = {}) {
  let mode: PlaybackMode = initial.mode ?? "live";
  let behind = initial.behind ?? 0;
  const c = {
    enterDvr: vi.fn<(url: string) => Promise<boolean>>(async () => {
      mode = "dvr";
      return true;
    }),
    exitDvr: vi.fn<() => void>(() => {
      mode = "live";
      behind = 0;
    }),
    seekToWallclock: vi.fn<(at: Date) => boolean>((at: Date) => {
      behind = (Date.now() - at.getTime()) / 1000;
      return true;
    }),
    playheadWallclock: () => new Date(Date.now() - behind * 1000),
    playbackMode: () => mode,
    dvrGrant: () => GRANT,
  };
  return { c, controller: c as unknown as PlayerController };
}

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

function slot(controller: PlayerController, over: Partial<DvrSlotProps> = {}): DvrSlotProps {
  return { controller, grant: GRANT, dataMode: false, playbackMode: "live", ...over };
}

const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
/** The slider's thumb input (`type="range"`, implicitly `role="slider"`; Base UI puts the keys on it). */
const thumb = () => {
  const el = document.querySelector<HTMLInputElement>('[data-testid="player-dvr-scrubber"] input[type="range"]');
  if (!el) throw new Error("no slider thumb");
  return el;
};
const settle = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

describe("DvrScrubber", () => {
  it("is hidden without a grant, with window 0 and in data mode", () => {
    const { controller } = fakeController();
    wrap(
      <>
        <DvrScrubber {...slot(controller, { grant: null })} />
        <DvrScrubber {...slot(controller, { grant: { ...GRANT, windowSeconds: 0 } })} />
        <DvrScrubber {...slot(controller, { dataMode: true })} />
        <DvrControls {...slot(controller, { dataMode: true, playbackMode: "dvr" })} />
        <DvrControls {...slot(controller, { grant: null, playbackMode: "dvr" })} />
      </>,
    );
    expect(byId("player-dvr-scrubber")).toBeNull();
    expect(byId("player-dvr-live")).toBeNull();
    expect(document.querySelector('input[type="range"]')).toBeNull();
  });

  it("at live: the thumb at the window's end, labelled, with the window and distance as data", () => {
    const { controller } = fakeController();
    wrap(<DvrScrubber {...slot(controller)} />);
    const el = byId("player-dvr-scrubber");
    expect(el?.dataset.windowSeconds).toBe("1800");
    expect(el?.dataset.behindSeconds).toBe("0");
    expect(el?.getAttribute("aria-label")).toBe(t("dvr.scrubber.label"));
    expect(el?.getAttribute("aria-valuetext")).toBe(t("dvr.atLive"));
    const slider = thumb();
    expect(slider.getAttribute("aria-valuenow")).toBe("1800");
    expect([slider.min, slider.max, slider.step]).toEqual(["0", "1800", "10"]);
  });

  it("Page Down rewinds 60 s into DVR; Home goes to the window start; End returns to live", async () => {
    const { c, controller } = fakeController();
    const { rerender } = wrap(<DvrScrubber {...slot(controller)} />);
    fireEvent.keyDown(thumb(), { key: "PageDown" });
    await settle();
    expect(c.enterDvr).toHaveBeenCalledWith(GRANT.playlistUrl);
    const lastBehind = () => (Date.now() - (c.seekToWallclock.mock.lastCall?.[0]?.getTime() ?? 0)) / 1000;
    expect(lastBehind()).toBeCloseTo(60, 0);
    // The player passes the new mode down (`onPlaybackMode`).
    rerender(
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>
          <DvrScrubber {...slot(controller, { playbackMode: "dvr" })} />
        </TooltipProvider>
      </LocaleProvider>,
    );
    expect(byId("player-dvr-scrubber")?.dataset.behindSeconds).toBe("60");

    fireEvent.keyDown(thumb(), { key: "Home" });
    await settle();
    expect(lastBehind()).toBeCloseTo(1800, 0);
    expect(c.enterDvr).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(thumb(), { key: "End" });
    await settle();
    expect(c.exitDvr).toHaveBeenCalled();
  });

  it("arrow keys move 10 s; a step that stays near the live edge stays live", async () => {
    const { c, controller } = fakeController();
    const { rerender } = wrap(<DvrScrubber {...slot(controller)} />);
    fireEvent.keyDown(thumb(), { key: "ArrowLeft" });
    await settle();
    // 10 s back is inside the live edge: the live playlist keeps playing.
    expect(c.enterDvr).not.toHaveBeenCalled();
    expect(c.exitDvr).toHaveBeenCalled();

    // From 600 s back, one step left goes 610 s back.
    const behind = fakeController({ mode: "dvr", behind: 600 });
    rerender(
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>
          <DvrScrubber {...slot(behind.controller, { playbackMode: "dvr" })} />
        </TooltipProvider>
      </LocaleProvider>,
    );
    expect(byId("player-dvr-scrubber")?.dataset.behindSeconds).toBe("600");
    fireEvent.keyDown(thumb(), { key: "ArrowLeft" });
    await settle();
    const at = behind.c.seekToWallclock.mock.lastCall?.[0];
    expect((Date.now() - (at?.getTime() ?? 0)) / 1000).toBeCloseTo(610, 0);
  });
});

describe("DvrControls", () => {
  it("shows nothing at live", () => {
    const { controller } = fakeController();
    wrap(<DvrControls {...slot(controller)} />);
    expect(byId("player-dvr-live")).toBeNull();
    expect(byId("player-dvr-behind")).toBeNull();
    expect(byId("player-dvr-source-note")).toBeNull();
  });

  it("in DVR: back to live, the behind-live readout and the source-only note", () => {
    const { c, controller } = fakeController({ mode: "dvr", behind: 754 });
    wrap(<DvrControls {...slot(controller, { playbackMode: "dvr" })} />);
    const readout = byId("player-dvr-behind");
    expect(readout?.dataset.seconds).toBe("754");
    expect(readout?.textContent).toBe(t("dvr.behind", { time: "12:34" }));
    expect(byId("player-dvr-source-note")?.textContent).toBe(t("dvr.sourceOnly"));
    const live = byId("player-dvr-live");
    expect(live?.textContent).toBe(t("dvr.backToLive"));
    expect(live?.getAttribute("aria-keyshortcuts")).toBe("L");
    fireEvent.click(live as HTMLElement);
    expect(c.exitDvr).toHaveBeenCalledTimes(1);
  });

  it("L goes back to live, except while typing", () => {
    const { c, controller } = fakeController({ mode: "dvr", behind: 120 });
    wrap(
      <>
        <DvrControls {...slot(controller, { playbackMode: "dvr" })} />
        <textarea data-testid="chat-input" />
      </>,
    );
    fireEvent.keyDown(byId("chat-input") as HTMLElement, { key: "l" });
    expect(c.exitDvr).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "l", ctrlKey: true });
    expect(c.exitDvr).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "L" });
    expect(c.exitDvr).toHaveBeenCalledTimes(1);
  });

  it("the readout follows the playhead every second", () => {
    vi.useFakeTimers();
    const { controller } = fakeController({ mode: "dvr", behind: 100 });
    wrap(<DvrControls {...slot(controller, { playbackMode: "dvr" })} />);
    expect(byId("player-dvr-behind")?.dataset.seconds).toBe("100");
    // The playhead plays at 1x, so the distance holds; a paused one falls behind.
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(byId("player-dvr-behind")?.dataset.seconds).toBe("100");
  });
});
