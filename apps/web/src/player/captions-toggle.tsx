// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The CC control in the player's control row (ADR 0011; docs/testing/w2-selectors.md "Captions"):
 * shown only once the stream's playlist brings a caption track (found through the seam's
 * `onTextTrack`), with a style menu (size, contrast; kept per viewer). While the media host has no
 * free captions slot it says so instead (`captionsState` `queued`). `captions-state.ts` holds the
 * logic; this file only renders it.
 */
import { IconButton } from "@commonair/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@commonair/ui/components/dropdown-menu";
import { ClosedCaptionIcon, TextFontIcon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../i18n/index.ts";
import type { MessageKey } from "../i18n/keys/index.gen.ts";
import "./captions.css";
import {
  applyCaptionStyle,
  browserStorage,
  CAPTION_CONTRASTS,
  CAPTION_SIZES,
  captionsOff,
  captionsOn,
  captionTracks,
  isShowing,
  pickTrack,
  readCaptionStyle,
  writeCaptionStyle,
  type CaptionContrast,
  type CaptionSize,
  type CaptionsSession,
  type CaptionStyle,
} from "./captions-state.ts";
import type { PlayerController, SessionFeatures } from "./controller.ts";

export interface CaptionsToggleProps {
  /** The playing session (seam: `onTextTrack`, `setTargetLatency`). */
  controller: PlayerController;
  /** The session's live caption tracks and why there are none (`PlaybackStart.captionsState`). */
  captions: SessionFeatures["captions"];
}

const SIZE_KEYS: Record<CaptionSize, MessageKey> = {
  small: "captions.player.size.small",
  medium: "captions.player.size.medium",
  large: "captions.player.size.large",
};
const CONTRAST_KEYS: Record<CaptionContrast, MessageKey> = {
  standard: "captions.player.contrast.standard",
  high: "captions.player.contrast.high",
};

export function CaptionsToggle({ controller, captions }: CaptionsToggleProps): React.JSX.Element | null {
  const anchor = React.useRef<HTMLSpanElement>(null);
  const [tracks, setTracks] = React.useState<TextTrack[]>([]);
  const [on, setOn] = React.useState(false);
  const [native, setNative] = React.useState(false);
  const [style, setStyle] = React.useState<CaptionStyle>(() => readCaptionStyle(browserStorage));
  const session = React.useRef<CaptionsSession | null>(null);

  React.useEffect(() => {
    // hls.js adds its tracks when the playlist loads, before this control mounts: read the list
    // once from the player's video, then follow the seam's events.
    const video = anchor.current?.closest('[data-testid="player"]')?.querySelector("video");
    const sync = (list: ArrayLike<TextTrack> | undefined) => {
      const found = captionTracks(list);
      setTracks(found);
      setOn(isShowing(found));
    };
    sync(video?.textTracks);
    // A controller without the seam (an older fake in tests) simply has no captions.
    return typeof controller.onTextTrack === "function" ? controller.onTextTrack((list) => sync(list)) : undefined;
  }, [controller]);

  React.useEffect(() => applyCaptionStyle(document.documentElement, style), [style]);

  const language = captions.tracks[0]?.language ?? null;
  const toggle = () => {
    if (on) {
      captionsOff(controller, tracks, session.current);
      session.current = null;
      setOn(false);
      return;
    }
    const track = pickTrack(tracks, language);
    if (!track) return;
    session.current = captionsOn(controller, tracks, track);
    setNative(session.current.native);
    setOn(true);
  };
  const choose = (next: CaptionStyle) => {
    setStyle(next);
    writeCaptionStyle(browserStorage, next);
  };

  if (tracks.length === 0) {
    return (
      <span ref={anchor} className="contents">
        {captions.state === "queued" && (
          <output data-testid="player-captions-queued" className="text-2xs text-overlay-foreground">
            {t("captions.player.queued")}
          </output>
        )}
      </span>
    );
  }
  return (
    <span ref={anchor} className="contents">
      <IconButton
        data-testid="player-captions-toggle"
        data-state={on ? "on" : "off"}
        aria-pressed={on}
        icon={ClosedCaptionIcon}
        label={on ? t("captions.player.off") : t("captions.player.on")}
        tooltip={on && native ? t("captions.player.nativeLate") : undefined}
        onClick={toggle}
        className="text-overlay-foreground"
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <IconButton
              data-testid="player-captions-style"
              icon={TextFontIcon}
              label={t("captions.player.style")}
              className="text-overlay-foreground"
            />
          }
        />
        <DropdownMenuContent align="end" side="top">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("captions.player.sizeLabel")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={style.size}
              onValueChange={(v: unknown) => {
                if ((CAPTION_SIZES as readonly unknown[]).includes(v)) choose({ ...style, size: v as CaptionSize });
              }}
            >
              {CAPTION_SIZES.map((s) => (
                <DropdownMenuRadioItem key={s} value={s} data-testid={`player-captions-size-${s}`}>
                  {t(SIZE_KEYS[s])}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("captions.player.contrastLabel")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={style.contrast}
              onValueChange={(v: unknown) => {
                if ((CAPTION_CONTRASTS as readonly unknown[]).includes(v))
                  choose({ ...style, contrast: v as CaptionContrast });
              }}
            >
              {CAPTION_CONTRASTS.map((c) => (
                <DropdownMenuRadioItem key={c} value={c} data-testid={`player-captions-contrast-${c}`}>
                  {t(CONTRAST_KEYS[c])}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
