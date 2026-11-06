// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Fullscreen and picture-in-picture for the player (D2-player, F3). Fullscreen goes on the player
 * container (the standard API), so the control bar and captions stay on screen; iOS Safari, which
 * only lets the video element itself go fullscreen, falls back to `webkitEnterFullscreen` (the
 * system player then draws its own controls). PiP is the video element's. A browser without
 * either gets no button at all, never a disabled one.
 */
import * as React from "react";

type WebkitDocument = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type WebkitElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type WebkitVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitDisplayingFullscreen?: boolean;
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
};

/** `container`: the standard API on the player; `video`: iOS, the element alone; `none`: no button. */
export type FullscreenSupport = "container" | "video" | "none";

export function fullscreenSupport(
  doc: Document,
  container: HTMLElement | null,
  video: HTMLVideoElement | null,
): FullscreenSupport {
  const d = doc as WebkitDocument;
  const c = container as WebkitElement | null;
  const enabled = d.fullscreenEnabled === true || d.webkitFullscreenEnabled === true;
  if (c && enabled && (typeof c.requestFullscreen === "function" || typeof c.webkitRequestFullscreen === "function"))
    return "container";
  if (video && typeof (video as WebkitVideo).webkitEnterFullscreen === "function") return "video";
  return "none";
}

function fullscreenElement(doc: Document): Element | null {
  const d = doc as WebkitDocument;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

export function isFullscreen(doc: Document, container: HTMLElement | null, video: HTMLVideoElement | null): boolean {
  const el = fullscreenElement(doc);
  if (container && el === container) return true;
  return (video as WebkitVideo | null)?.webkitDisplayingFullscreen === true;
}

/** Enter or leave fullscreen; resolves once the browser answered (a refusal is ignored). */
export async function toggleFullscreen(
  doc: Document,
  container: HTMLElement | null,
  video: HTMLVideoElement | null,
): Promise<void> {
  const support = fullscreenSupport(doc, container, video);
  const d = doc as WebkitDocument;
  try {
    if (isFullscreen(doc, container, video)) {
      if (support === "video") (video as WebkitVideo).webkitExitFullscreen?.();
      else if (typeof d.exitFullscreen === "function") await d.exitFullscreen();
      else await d.webkitExitFullscreen?.();
      return;
    }
    if (support === "container" && container) {
      const c = container as WebkitElement;
      if (typeof c.requestFullscreen === "function") await c.requestFullscreen();
      else await c.webkitRequestFullscreen?.();
    } else if (support === "video" && video) {
      (video as WebkitVideo).webkitEnterFullscreen?.();
    }
  } catch {
    // Refused (no user gesture, a permissions policy): nothing changes.
  }
}

/** `standard`: `requestPictureInPicture`; `webkit`: Safari's presentation mode; `none`: no button. */
export type PipSupport = "standard" | "webkit" | "none";

export function pipSupport(doc: Document, video: HTMLVideoElement | null): PipSupport {
  if (!video) return "none";
  const v = video as WebkitVideo;
  if (v.disablePictureInPicture) return "none";
  const d = doc as Document & { pictureInPictureEnabled?: boolean };
  if (d.pictureInPictureEnabled === true && typeof v.requestPictureInPicture === "function") return "standard";
  if (typeof v.webkitSupportsPresentationMode === "function" && v.webkitSupportsPresentationMode("picture-in-picture"))
    return "webkit";
  return "none";
}

export function isPip(doc: Document, video: HTMLVideoElement | null): boolean {
  if (!video) return false;
  const d = doc as Document & { pictureInPictureElement?: Element | null };
  return d.pictureInPictureElement === video || (video as WebkitVideo).webkitPresentationMode === "picture-in-picture";
}

export async function togglePip(doc: Document, video: HTMLVideoElement | null): Promise<void> {
  const support = pipSupport(doc, video);
  if (!video || support === "none") return;
  const v = video as WebkitVideo;
  try {
    if (support === "webkit") {
      v.webkitSetPresentationMode?.(isPip(doc, video) ? "inline" : "picture-in-picture");
      return;
    }
    if (isPip(doc, video))
      await (doc as Document & { exitPictureInPicture?: () => Promise<void> }).exitPictureInPicture?.();
    else await v.requestPictureInPicture();
  } catch {
    // Refused (no metadata yet, no user gesture): nothing changes.
  }
}

export interface ScreenModes {
  fullscreen: {
    support: FullscreenSupport;
    active: boolean;
    /**
     * The player container while it is the fullscreen element, else null: the portal container
     * for the player's popups, since `<body>` is not painted in fullscreen.
     */
    element: HTMLElement | null;
    toggle: () => void;
  };
  pip: { support: PipSupport; active: boolean; toggle: () => void };
}

const FULLSCREEN_EVENTS = ["fullscreenchange", "webkitfullscreenchange"] as const;
const VIDEO_EVENTS = [
  "enterpictureinpicture",
  "leavepictureinpicture",
  "webkitpresentationmodechanged",
  "webkitbeginfullscreen",
  "webkitendfullscreen",
  "loadedmetadata",
] as const;

/** Support (read once mounted, so the server renders no buttons) and state of both modes. */
export function useScreenModes(
  container: React.RefObject<HTMLElement | null>,
  video: React.RefObject<HTMLVideoElement | null>,
): ScreenModes {
  const [state, setState] = React.useState({
    fullscreen: "none" as FullscreenSupport,
    fullscreenOn: false,
    element: null as HTMLElement | null,
    pip: "none" as PipSupport,
    pipOn: false,
  });
  React.useEffect(() => {
    const v = video.current;
    const sync = () => {
      const c = container.current;
      const fullscreenOn = isFullscreen(document, c, v);
      const next = {
        fullscreen: fullscreenSupport(document, c, v),
        fullscreenOn,
        // iOS's video-only fullscreen draws the system player: nothing of ours to portal into.
        element: fullscreenOn && fullscreenElement(document) === c ? c : null,
        pip: pipSupport(document, v),
        pipOn: isPip(document, v),
      };
      setState((prev) =>
        prev.fullscreen === next.fullscreen &&
        prev.fullscreenOn === next.fullscreenOn &&
        prev.element === next.element &&
        prev.pip === next.pip &&
        prev.pipOn === next.pipOn
          ? prev
          : next,
      );
    };
    sync();
    for (const e of FULLSCREEN_EVENTS) document.addEventListener(e, sync);
    for (const e of VIDEO_EVENTS) v?.addEventListener(e, sync);
    return () => {
      for (const e of FULLSCREEN_EVENTS) document.removeEventListener(e, sync);
      for (const e of VIDEO_EVENTS) v?.removeEventListener(e, sync);
    };
  }, [container, video]);
  return {
    fullscreen: {
      support: state.fullscreen,
      active: state.fullscreenOn,
      element: state.element,
      toggle: () => void toggleFullscreen(document, container.current, video.current),
    },
    pip: {
      support: state.pip,
      active: state.pipOn,
      toggle: () => void togglePip(document, video.current),
    },
  };
}
