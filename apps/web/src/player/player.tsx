// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { IconButton } from "@commonair/ui";
import { cn } from "@commonair/ui/lib/utils";
import { VolumeHighIcon, VolumeOffIcon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../i18n/index.ts";
import { api, apiKeepalive } from "../lib/api.ts";
import { PlayerController, type PlayerState } from "./controller.ts";
import { pageLifecycle } from "./lifecycle.ts";

export interface PlayerProps {
  channel: string;
  /** Whether the channel is live (from `channels.get`); playback starts and stops with it. */
  live: boolean;
  embed?: boolean;
  /** Shown over the video while offline. */
  offline?: React.ReactNode;
  className?: string;
}

const RETRY_MS = 5_000;

/** Live player: autoplays muted (browsers block audible autoplay) with an unmute control. */
export function Player({ channel, live, embed = false, offline, className }: PlayerProps): React.JSX.Element {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [state, setState] = React.useState<PlayerState>(live ? "loading" : "offline");
  const [muted, setMuted] = React.useState(true);
  // Bumped to start a fresh session after a failure (e.g. the stream is not ready yet).
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!live || !video) {
      setState("offline");
      return;
    }
    let retry: ReturnType<typeof setTimeout> | undefined;
    const controller = new PlayerController({
      channel,
      video,
      api: api(),
      endApi: apiKeepalive(),
      embed,
      onState: (s) => {
        setState(s);
        if (s === "error") retry = setTimeout(() => setAttempt((n) => n + 1), RETRY_MS);
      },
    });
    setState("loading");
    void controller.start();
    const lifecycle = pageLifecycle(
      () => void controller.stop(),
      () => setAttempt((n) => n + 1),
    );
    window.addEventListener("pagehide", lifecycle.pagehide);
    window.addEventListener("pageshow", lifecycle.pageshow);
    return () => {
      clearTimeout(retry);
      window.removeEventListener("pagehide", lifecycle.pagehide);
      window.removeEventListener("pageshow", lifecycle.pageshow);
      void controller.stop();
    };
  }, [channel, live, embed, attempt]);

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
    if (!video.muted) void video.play().catch(() => undefined);
  };

  return (
    <div
      data-testid="player"
      data-state={state}
      className={cn("relative aspect-video w-full overflow-hidden bg-muted", className)}
    >
      <video
        ref={videoRef}
        data-testid="player-video"
        className="size-full"
        muted
        autoPlay
        playsInline
        crossOrigin="anonymous"
        onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
      />
      {state === "offline" && offline && (
        <div className="absolute inset-0 grid place-items-center bg-background">{offline}</div>
      )}
      {state === "loading" && (
        <div
          className="pointer-events-none absolute inset-0 grid place-items-center text-xs text-overlay-foreground"
          aria-live="polite"
        >
          {t("player.loading")}
        </div>
      )}
      {state === "error" && (
        <div className="absolute inset-0 grid place-items-center bg-background/80 text-xs" role="alert">
          {t("player.error")}
        </div>
      )}
      {state === "playing" && (
        <IconButton
          className="absolute right-2 bottom-2"
          variant="secondary"
          label={muted ? t("player.unmute") : t("player.mute")}
          icon={muted ? VolumeOffIcon : VolumeHighIcon}
          onClick={toggleMute}
        />
      )}
    </div>
  );
}
