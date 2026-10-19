// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PlayerChrome, PlayerControl } from "@commonair/ui/blocks/media";
import { cn } from "@commonair/ui/lib/utils";
import { VolumeHighIcon, VolumeOffIcon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../i18n/index.ts";
import { api, apiKeepalive } from "../lib/api.ts";
import { PlayerController, type PlayerState } from "./controller.ts";
import { pageLifecycle } from "./lifecycle.ts";
import type { PlayerSource } from "./source.ts";

export interface PlayerProps {
  channel: string;
  /** Whether the channel is live (from `channels.get`); playback starts and stops with it. */
  live: boolean;
  embed?: boolean;
  /** Shown over the video (the player's stage) while offline. */
  offline?: React.ReactNode;
  className?: string;
}

const RETRY_MS = 5_000;

/** Live player: autoplays muted (browsers block audible autoplay) with an unmute control. */
export function Player({ channel, live, embed = false, offline, className }: PlayerProps): React.JSX.Element {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [state, setState] = React.useState<PlayerState>(live ? "loading" : "offline");
  const [muted, setMuted] = React.useState(true);
  // Unknown until `playback.start` answers; each new session reports its own.
  const [source, setSource] = React.useState<PlayerSource | undefined>(undefined);
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
      onSource: setSource,
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
      setSource(undefined);
    };
  }, [channel, live, embed, attempt]);

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
    if (!video.muted) void video.play().catch(() => undefined);
  };

  const stage =
    state === "offline" ? (
      offline
    ) : state === "loading" ? (
      <output>{t("player.loading")}</output>
    ) : state === "error" ? (
      <p role="alert">{t("player.error")}</p>
    ) : undefined;

  return (
    <PlayerChrome
      data-testid="player"
      data-state={state}
      data-source={source}
      variant={live ? "live" : "offline"}
      liveBadgeProps={{ "data-testid": "live-badge" }}
      stage={stage}
      controls={
        state === "playing" ? (
          // The label names the action (Mute / Unmute), so no `pressed` state on top of it.
          <PlayerControl
            label={muted ? t("player.unmute") : t("player.mute")}
            icon={muted ? VolumeOffIcon : VolumeHighIcon}
            onClick={toggleMute}
          />
        ) : undefined
      }
      className={cn("w-full", className)}
    >
      <video
        ref={videoRef}
        data-testid="player-video"
        muted
        autoPlay
        playsInline
        crossOrigin="anonymous"
        onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
      />
    </PlayerChrome>
  );
}
