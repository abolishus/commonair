// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The rehearsal player (W2-rehearsal): plays `stream.rehearsal.watch`'s origin-only playlist for the
 * owner or an invitee. It never goes through `playback.start` (which only knows the live broadcast)
 * and never asks for P2P, a relay or the CDN; heartbeats refresh the token the playlist and
 * segment requests carry, as the live player's do.
 */
import { OverlayBadge, SkeletonThumbnail } from "@commonair/ui";
import { PlayerChrome, PlayerControl } from "@commonair/ui/blocks/media";
import { VolumeHighIcon, VolumeOffIcon } from "@hugeicons/core-free-icons";
import type Hls from "hls.js";
import * as React from "react";
import type { RehearsalWatch } from "@commonair/contracts/dto";
import { t } from "../../i18n/index.ts";
import { api, apiKeepalive } from "../../lib/api.ts";
import { withToken } from "../../player/heartbeat.ts";
import { sessionDeviceId } from "../../player/stats.ts";

export type RehearsalPlayerState = "loading" | "playing" | "unavailable" | "error";

export interface RehearsalPlayerProps {
  channel: string;
  /** `rehearsal-player` for the owner; the invitee view (`rehearsal-watch`) wraps an unnamed one. */
  testId?: string;
  /** A refused or failed `watch` (not invited, nothing open, signed out). */
  onUnavailable?: (err: unknown) => void;
  onState?: (state: RehearsalPlayerState) => void;
}

/** Seconds of media played between two readings, never negative, never past a heartbeat's cap. */
export function playedBetween(previous: number, current: number): number {
  return Math.min(120, Math.max(0, current - previous));
}

export function RehearsalPlayer({ channel, testId, onUnavailable, onState }: RehearsalPlayerProps): React.JSX.Element {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [state, setState] = React.useState<RehearsalPlayerState>("loading");
  const onStateRef = React.useRef(onState);
  React.useEffect(() => {
    onStateRef.current = onState;
  }, [onState]);
  React.useEffect(() => onStateRef.current?.(state), [state]);
  const [muted, setMuted] = React.useState(true);
  const onUnavailableRef = React.useRef(onUnavailable);
  React.useEffect(() => {
    onUnavailableRef.current = onUnavailable;
  }, [onUnavailable]);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let stopped = false;
    let hls: Hls | null = null;
    let session: { id: string; token: string } | null = null;
    let beat: ReturnType<typeof setInterval> | undefined;
    let lastTime = 0;

    const start = async () => {
      let w: RehearsalWatch;
      try {
        w = await api().stream.rehearsal.watch({ channel, deviceId: sessionDeviceId() });
      } catch (err) {
        if (!stopped) setState("unavailable");
        onUnavailableRef.current?.(err);
        return;
      }
      if (stopped) return;
      const current = { id: w.sessionId, token: w.token };
      session = current;
      const { default: HlsCtor } = await import("hls.js");
      if (stopped) return;
      if (HlsCtor.isSupported()) {
        const instance = new HlsCtor({
          // Every request carries the newest token (heartbeats replace it before it expires).
          xhrSetup: (xhr, url) => xhr.open("GET", withToken(url, current.token), true),
        });
        hls = instance;
        instance.on(HlsCtor.Events.ERROR, (_e, data) => {
          if (data.fatal && !stopped) setState("error");
        });
        instance.loadSource(w.playlistUrl);
        instance.attachMedia(video);
      } else video.src = w.playlistUrl;
      video.addEventListener("playing", () => !stopped && setState("playing"), { once: true });
      void video.play().catch(() => undefined);
      beat = setInterval(() => {
        const s = session;
        if (!s || stopped) return;
        const played = playedBetween(lastTime, video.currentTime);
        lastTime = video.currentTime;
        const buffered =
          video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) - video.currentTime : 0;
        api()
          .playback.heartbeat({
            sessionId: s.id,
            token: s.token,
            playedSeconds: played,
            bufferSeconds: Math.max(0, buffered),
            stalls: 0,
            bytesHttp: 0,
            bytesP2p: 0,
            rendition: "source",
            latencySeconds: null,
            ttffMs: null,
            visible: document.visibilityState === "visible",
            muted: video.muted,
          })
          .then((res) => {
            if (res.token) s.token = res.token;
          })
          .catch(() => {
            // The rehearsal ended or the session closed: the next watch starts a new one.
          });
      }, w.heartbeatIntervalMs);
    };
    void start().catch(() => !stopped && setState("error"));

    return () => {
      stopped = true;
      if (beat) clearInterval(beat);
      hls?.destroy();
      const s = session;
      if (s)
        void apiKeepalive()
          .playback.end({ sessionId: s.id, token: s.token })
          .catch(() => undefined);
    };
  }, [channel]);

  const toggleMute = () => {
    const video = videoRef.current;
    if (video) video.muted = !video.muted;
  };

  const stage =
    state === "loading" ? (
      <SkeletonThumbnail className="size-full" aria-label={t("rehearsal.player.loading")} />
    ) : state === "error" ? (
      <p className="p-4 text-center text-sm">{t("rehearsal.player.error")}</p>
    ) : state === "unavailable" ? (
      <p className="p-4 text-center text-sm">{t("rehearsal.player.waiting")}</p>
    ) : undefined;

  return (
    <PlayerChrome
      data-testid={testId}
      data-state={state}
      variant="preview"
      aria-label={t("rehearsal.player.title")}
      topStart={<OverlayBadge>{t("rehearsal.player.badge")}</OverlayBadge>}
      stage={stage}
      controls={
        state === "playing" ? (
          <PlayerControl
            label={muted ? t("rehearsal.player.unmute") : t("rehearsal.player.mute")}
            icon={muted ? VolumeOffIcon : VolumeHighIcon}
            onClick={toggleMute}
          />
        ) : undefined
      }
      className="w-full"
    >
      <video
        ref={videoRef}
        muted
        autoPlay
        playsInline
        crossOrigin="anonymous"
        onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
      />
    </PlayerChrome>
  );
}
