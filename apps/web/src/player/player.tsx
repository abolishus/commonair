// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PlayerChrome, PlayerControl } from "@commonair/ui/blocks/media";
import { cn } from "@commonair/ui/lib/utils";
import { VolumeHighIcon, VolumeOffIcon } from "@hugeicons/core-free-icons";
import * as React from "react";
import type { LegalDoc } from "../components/legal-document-link.tsx";
import { t } from "../i18n/index.ts";
import { api, apiKeepalive } from "../lib/api.ts";
import {
  P2P_STATUS_OFF,
  PlayerController,
  diagnosticParams,
  prefersNativeHls,
  type P2PStatus,
  type PlayerState,
} from "./controller.ts";
import { pageLifecycle } from "./lifecycle.ts";
import { registerMediaClock, type PlaybackMode } from "./media-clock.ts";
import { P2PDialog, P2PIndicator, P2PNotice } from "./p2p/p2p-ui.tsx";
import { deviceSignals, noticeDue, p2pAllowed, type DeviceSignals } from "./p2p/policy.ts";
import { markP2PNoticeSeen, readP2PPrefs, setP2PPreference } from "./p2p/preference.ts";
import { useMounted, useOperatorP2PDefault, useP2PPrefs } from "./p2p/use-p2p.ts";
import type { PlayerSource } from "./source.ts";

export interface PlayerProps {
  channel: string;
  /** Whether the channel is live (from `channels.get`); playback starts and stops with it. */
  live: boolean;
  embed?: boolean;
  /** Shown over the video (the player's stage) while offline. */
  offline?: React.ReactNode;
  className?: string;
  /** A failed `playback.start` (the channel page shows the 18+ gate for `mature_gate`). */
  onStartError?: (err: unknown) => void;
}

const RETRY_MS = 5_000;

async function loadPrivacyPolicy(): Promise<LegalDoc | null> {
  return (await api().legal.current()).find((d) => d.kind === "privacy") ?? null;
}

/** What the browser says about this device, read once on the client. */
interface DeviceEnv {
  signals: DeviceSignals;
  /** A best guess before hls.js loads; the controller decides for real. */
  native: boolean;
}

function readDeviceEnv(): DeviceEnv {
  const mse = "MediaSource" in window || "ManagedMediaSource" in window;
  return { signals: deviceSignals(), native: prefersNativeHls(document.createElement("video"), mse) };
}

/** Live player: autoplays muted (browsers block audible autoplay) with an unmute control. */
export function Player({
  channel,
  live,
  embed = false,
  offline,
  className,
  onStartError,
}: PlayerProps): React.JSX.Element {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [state, setState] = React.useState<PlayerState>(live ? "loading" : "offline");
  const [muted, setMuted] = React.useState(true);
  // Unknown until `playback.start` answers; each new session reports its own.
  const [source, setSource] = React.useState<PlayerSource | undefined>(undefined);
  // Bumped to start a fresh session after a failure (e.g. the stream is not ready yet).
  const [attempt, setAttempt] = React.useState(0);
  const [playbackMode, setPlaybackMode] = React.useState<PlaybackMode>("live");
  // Latest callback without restarting the session when the parent re-renders.
  const onStartErrorRef = React.useRef(onStartError);
  React.useEffect(() => {
    onStartErrorRef.current = onStartError;
  });

  // P2P (ADR 0005 amendment 1): the viewer's choice, the operator default, the first-run notice.
  const operatorDefault = useOperatorP2PDefault();
  const prefs = useP2PPrefs();
  const [p2p, setP2P] = React.useState<P2PStatus>(P2P_STATUS_OFF);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const mounted = useMounted();
  const env = React.useMemo(() => (mounted ? readDeviceEnv() : null), [mounted]);
  const noticeShown = React.useRef(false);
  const [noticeOnScreen, setNoticeOnScreen] = React.useState(false);
  const controllerRef = React.useRef<PlayerController | null>(null);
  const policy = env && { ...prefs, ...env.signals, operatorDefault, dataMode: false, native: env.native };
  const showNotice = policy !== null && noticeDue(policy);
  // Sessions start once the device is known and, when the notice is due, once it is on screen:
  // P2P never starts before the disclosure. Latched, so a later prefs change never restarts one.
  const [gateOpen, setGateOpen] = React.useState(false);
  if (!gateOpen && env && (!showNotice || noticeOnScreen)) setGateOpen(true);

  // The decision for each new session, read fresh at its start (this effect runs before the
  // session effect below).
  const p2pWanted = React.useRef<(native: boolean) => boolean>(() => false);
  React.useEffect(() => {
    p2pWanted.current = (native) => {
      const now = readP2PPrefs();
      const allowed = p2pAllowed({ ...now, ...deviceSignals(), operatorDefault, dataMode: false, native });
      // An explicit "on" was chosen next to the disclosure; the default needs it seen or shown.
      return allowed && (now.preference === "on" || now.noticeSeen || noticeShown.current);
    };
  });

  // "Off" anywhere (dialog, notice, settings, another tab) stops P2P in this session at once.
  React.useEffect(() => {
    if (prefs.preference === "off") controllerRef.current?.disableP2P();
  }, [prefs.preference]);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!live || !video) {
      setState("offline");
      return;
    }
    // Not yet: the device is unknown, or the first-run notice is not on screen yet.
    if (!gateOpen) return;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // Diagnostics for the harness (`timeline-sync` step 2), read straight from the URL so the
    // route's search schema stays untouched; see `diagnosticParams`.
    const diag = diagnosticParams(window.location.search);
    const controller = new PlayerController({
      channel,
      video,
      api: api(),
      endApi: apiKeepalive(),
      embed,
      onSource: setSource,
      onStartError: (err) => onStartErrorRef.current?.(err),
      onState: (s) => {
        setState(s);
        if (s === "error") retry = setTimeout(() => setAttempt((n) => n + 1), RETRY_MS);
      },
      p2pWanted: (native) => p2pWanted.current(native),
      onP2P: setP2P,
      targetLatency: diag.targetLatency,
      rendition: diag.rendition,
    });
    controllerRef.current = controller;
    // The chat panel reads this channel's playhead at send time (`chat/connection.ts`).
    const unregisterClock = registerMediaClock(channel, controller);
    setPlaybackMode(controller.playbackMode());
    const unsubscribeMode = controller.onPlaybackMode(setPlaybackMode);
    // `start` reports `loading` first, so a retry after an error shows loading again.
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
      unsubscribeMode();
      unregisterClock();
      if (controllerRef.current === controller) controllerRef.current = null;
      void controller.stop();
      setSource(undefined);
      setP2P(P2P_STATUS_OFF);
    };
  }, [channel, live, embed, attempt, gateOpen]);

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
    if (!video.muted) void video.play().catch(() => undefined);
  };

  const onNoticeShown = React.useCallback(() => {
    noticeShown.current = true;
    setNoticeOnScreen(true);
  }, []);

  const stage =
    state === "offline" ? (
      offline
    ) : state === "loading" ? (
      <output>{t("player.loading")}</output>
    ) : state === "error" ? (
      <p role="alert">{t("player.error")}</p>
    ) : undefined;

  return (
    <>
      <PlayerChrome
        data-testid="player"
        data-state={state}
        data-source={source}
        data-p2p={p2p.state}
        data-playback-mode={playbackMode}
        variant={live ? "live" : "offline"}
        liveBadgeProps={{ "data-testid": "live-badge" }}
        stage={stage}
        controls={
          state === "playing" ? (
            <>
              {/* The label names the action (Mute / Unmute), so no `pressed` state on top of it. */}
              <PlayerControl
                label={muted ? t("player.unmute") : t("player.mute")}
                icon={muted ? VolumeOffIcon : VolumeHighIcon}
                onClick={toggleMute}
              />
              {p2p.available && <P2PIndicator status={p2p} onOpen={() => setDialogOpen(true)} />}
            </>
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
        {live && showNotice && (
          <P2PNotice onShown={onNoticeShown} onDismiss={markP2PNoticeSeen} onTurnOff={() => setP2PPreference("off")} />
        )}
      </PlayerChrome>
      {(p2p.available || dialogOpen) && (
        <P2PDialog open={dialogOpen} onOpenChange={setDialogOpen} status={p2p} loadPrivacyPolicy={loadPrivacyPolicy} />
      )}
    </>
  );
}
