// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D2-player (F3): fullscreen and picture-in-picture support. A browser without the API gets no
 * button (never a disabled one); the standard API goes on the player container; iOS Safari falls
 * back to the video element's `webkitEnterFullscreen`; Safari's PiP presentation mode works where
 * the standard PiP API is missing; refusals change nothing.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { VodPlayer } from "../src/components/vod-watch/vod-player.tsx";
import { locale, uiMessages } from "../src/i18n/index.ts";
import {
  fullscreenSupport,
  isFullscreen,
  isPip,
  pipSupport,
  toggleFullscreen,
  togglePip,
} from "../src/player/fullscreen.ts";

type Stub = Record<string, unknown>;
const doc = (over: Stub = {}) => over as unknown as Document;
const el = (over: Stub = {}) => over as unknown as HTMLElement;
const vid = (over: Stub = {}) => over as unknown as HTMLVideoElement;

describe("fullscreenSupport", () => {
  it("the standard API on the container, prefixed or not", () => {
    expect(fullscreenSupport(doc({ fullscreenEnabled: true }), el({ requestFullscreen: () => {} }), null)).toBe(
      "container",
    );
    expect(
      fullscreenSupport(doc({ webkitFullscreenEnabled: true }), el({ webkitRequestFullscreen: () => {} }), null),
    ).toBe("container");
  });

  it("iOS: no element fullscreen, but the video can go fullscreen by itself", () => {
    expect(fullscreenSupport(doc({ fullscreenEnabled: false }), el({}), vid({ webkitEnterFullscreen: () => {} }))).toBe(
      "video",
    );
  });

  it("none: the API is disabled (an iframe without allowfullscreen) or missing", () => {
    expect(fullscreenSupport(doc({ fullscreenEnabled: false }), el({ requestFullscreen: () => {} }), vid())).toBe(
      "none",
    );
    expect(fullscreenSupport(doc({}), el({}), vid())).toBe("none");
    expect(fullscreenSupport(doc({ fullscreenEnabled: true }), null, null)).toBe("none");
  });
});

describe("toggleFullscreen", () => {
  it("enters on the container and leaves through the document", async () => {
    const container = el({ requestFullscreen: vi.fn<() => Promise<void>>(async () => undefined) });
    const exitFullscreen = vi.fn<() => Promise<void>>(async () => undefined);
    const d = doc({ fullscreenEnabled: true, fullscreenElement: null, exitFullscreen });
    await toggleFullscreen(d, container, null);
    expect((container as unknown as Stub).requestFullscreen).toHaveBeenCalledTimes(1);
    (d as unknown as Stub).fullscreenElement = container;
    expect(isFullscreen(d, container, null)).toBe(true);
    await toggleFullscreen(d, container, null);
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("iOS: enters and leaves on the video element", async () => {
    const video = vid({
      webkitEnterFullscreen: vi.fn<(...args: unknown[]) => void>(),
      webkitExitFullscreen: vi.fn<(...args: unknown[]) => void>(),
      webkitDisplayingFullscreen: false,
    });
    const d = doc({ fullscreenEnabled: false });
    await toggleFullscreen(d, el({}), video);
    expect((video as unknown as Stub).webkitEnterFullscreen).toHaveBeenCalledTimes(1);
    (video as unknown as Stub).webkitDisplayingFullscreen = true;
    expect(isFullscreen(d, el({}), video)).toBe(true);
    await toggleFullscreen(d, el({}), video);
    expect((video as unknown as Stub).webkitExitFullscreen).toHaveBeenCalledTimes(1);
  });

  it("a refusal (no user gesture) is swallowed", async () => {
    const container = el({
      requestFullscreen: vi.fn<() => Promise<void>>(async () => Promise.reject(new TypeError("denied"))),
    });
    await expect(toggleFullscreen(doc({ fullscreenEnabled: true }), container, null)).resolves.toBeUndefined();
  });
});

describe("picture in picture", () => {
  it("standard, Safari's presentation mode, or none", () => {
    expect(pipSupport(doc({ pictureInPictureEnabled: true }), vid({ requestPictureInPicture: () => {} }))).toBe(
      "standard",
    );
    expect(
      pipSupport(doc({}), vid({ webkitSupportsPresentationMode: (m: string) => m === "picture-in-picture" })),
    ).toBe("webkit");
    expect(pipSupport(doc({ pictureInPictureEnabled: false }), vid({ requestPictureInPicture: () => {} }))).toBe(
      "none",
    );
    expect(
      pipSupport(
        doc({ pictureInPictureEnabled: true }),
        vid({ requestPictureInPicture: () => {}, disablePictureInPicture: true }),
      ),
    ).toBe("none");
    expect(pipSupport(doc({ pictureInPictureEnabled: true }), null)).toBe("none");
  });

  it("standard: enters on the video and leaves through the document", async () => {
    const video = vid({ requestPictureInPicture: vi.fn<() => Promise<object>>(async () => ({})) });
    const exitPictureInPicture = vi.fn<() => Promise<void>>(async () => undefined);
    const d = doc({ pictureInPictureEnabled: true, pictureInPictureElement: null, exitPictureInPicture });
    await togglePip(d, video);
    expect((video as unknown as Stub).requestPictureInPicture).toHaveBeenCalledTimes(1);
    (d as unknown as Stub).pictureInPictureElement = video;
    expect(isPip(d, video)).toBe(true);
    await togglePip(d, video);
    expect(exitPictureInPicture).toHaveBeenCalledTimes(1);
  });

  it("Safari: switches the presentation mode", async () => {
    const setMode = vi.fn<(...args: unknown[]) => void>();
    const video = vid({
      webkitSupportsPresentationMode: () => true,
      webkitSetPresentationMode: setMode,
      webkitPresentationMode: "inline",
    });
    await togglePip(doc({}), video);
    expect(setMode).toHaveBeenLastCalledWith("picture-in-picture");
    (video as unknown as Stub).webkitPresentationMode = "picture-in-picture";
    await togglePip(doc({}), video);
    expect(setMode).toHaveBeenLastCalledWith("inline");
  });
});

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

const player = () =>
  wrap(
    <VodPlayer
      source={{ kind: "mp4", url: "/media/clips/c.mp4", windowStartedAt: null }}
      variant="clip"
      title="The jump"
      durationSeconds={30}
      captions={[]}
    />,
  );

const defined: [object, string][] = [];
function define(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  defined.push([target, key]);
}

afterEach(() => {
  cleanup();
  for (const [target, key] of defined.splice(0)) Reflect.deleteProperty(target, key);
});

describe("the buttons", () => {
  it("a browser without either API shows neither button", async () => {
    define(document, "fullscreenEnabled", false);
    define(document, "pictureInPictureEnabled", false);
    player();
    // Support is read after mount; give it a turn.
    await act(async () => undefined);
    expect(screen.queryByTestId("player-fullscreen")).toBeNull();
    expect(screen.queryByTestId("player-pip")).toBeNull();
    expect(screen.getByTestId("player-controls").querySelector("button[disabled]")).toBeNull();
  });

  it("with both: fullscreen on the container, PiP on the video", async () => {
    const request = vi.fn<() => Promise<void>>(async () => undefined);
    const pip = vi.fn<() => Promise<object>>(async () => ({}));
    define(document, "fullscreenEnabled", true);
    define(HTMLElement.prototype, "requestFullscreen", request);
    define(document, "pictureInPictureEnabled", true);
    define(HTMLVideoElement.prototype, "requestPictureInPicture", pip);
    player();
    const fs = await screen.findByTestId("player-fullscreen");
    expect(fs.getAttribute("data-mode")).toBe("container");
    expect(fs.getAttribute("aria-label")).toBe("Fullscreen");
    fireEvent.click(fs);
    expect(request.mock.contexts[0]).toBe(screen.getByTestId("vod-player"));
    fireEvent.click(screen.getByTestId("player-pip"));
    expect(pip.mock.contexts[0]).toBe(screen.getByTestId("vod-player").querySelector("video"));
  });

  it("entering fullscreen relabels the button and marks the chrome", async () => {
    define(document, "fullscreenEnabled", true);
    define(HTMLElement.prototype, "requestFullscreen", async () => undefined);
    player();
    await screen.findByTestId("player-fullscreen");
    define(document, "fullscreenElement", screen.getByTestId("vod-player"));
    act(() => void document.dispatchEvent(new Event("fullscreenchange")));
    await waitFor(() =>
      expect(screen.getByTestId("player-fullscreen").getAttribute("aria-label")).toBe("Exit fullscreen"),
    );
    expect(screen.getByTestId("vod-player").hasAttribute("data-fullscreen")).toBe(true);
  });

  it("iOS: the fullscreen button uses the video element's own fullscreen", async () => {
    const enter = vi.fn<(...args: unknown[]) => void>();
    define(document, "fullscreenEnabled", false);
    define(HTMLVideoElement.prototype, "webkitEnterFullscreen", enter);
    player();
    const fs = await screen.findByTestId("player-fullscreen");
    expect(fs.getAttribute("data-mode")).toBe("video");
    fireEvent.click(fs);
    expect(enter).toHaveBeenCalledTimes(1);
  });
});
