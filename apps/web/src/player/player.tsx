// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PortalContainerProvider, useLocale } from "@commonair/ui";
import { PlayerChrome, PlayerControl } from "@commonair/ui/blocks/media";
import { cn } from "@commonair/ui/lib/utils";
import { PauseIcon, PlayIcon } from "@hugeicons/core-free-icons";
import * as React from "react";
import type { LegalDoc } from "../components/legal-document-link.tsx";
import { ClipButton } from "../components/watch/clip-button.tsx";
import { t } from "../i18n/index.ts";
import { api, apiKeepalive } from "../lib/api.ts";
import {
  ceilingOf,
  connectionHints,
  localStore,
  readDataModeChoice,
  saveDataModeChoice,
  type DataModeChoice,
  type LevelInfo,
} from "./budget.ts";
import { usePlayerBar } from "./bar.ts";
import { CaptionsToggle } from "./captions-toggle.tsx";
import {
  DataSaverChip,
  QualitySection,
  ScreenButtons,
  ShortcutsButton,
  ShortcutsDialog,
  qualityLabel,
  shortcutsFor,
  useSettings,
  useVideoVolume,
  useVolumeProps,
  type QualityOption,
} from "./controls.tsx";
import {
  NO_SESSION_FEATURES,
  P2P_STATUS_OFF,
  PlayerController,
  diagnosticParams,
  prefersNativeHls,
  type P2PStatus,
  type PlayerState,
  type SessionFeatures,
} from "./controller.ts";
import { DataModePanel } from "./data-mode.tsx";
import { DvrControls, DvrScrubber } from "./dvr-controls.tsx";
import { behindLiveSeconds, DVR_LIVE_EDGE_SECONDS, seekerFor } from "./dvr.ts";
import { useScreenModes } from "./fullscreen.ts";
import { SEEK_STEP_SECONDS, VOLUME_STEP, usePlayerShortcuts } from "./shortcuts.ts";
import { useTheatre, useTheatreAvailable } from "./theatre.ts";
import { pageLifecycle } from "./lifecycle.ts";
import { registerMediaClock, type PlaybackMode } from "./media-clock.ts";
import { registerRoomPlayer } from "./room-sync-registry.ts";
import { P2PDialog, P2PIndicator, P2PNotice } from "./p2p/p2p-ui.tsx";
import { deviceSignals, noticeDue, p2pAllowed, type DeviceSignals } from "./p2p/policy.ts";
import { markP2PNoticeSeen, readP2PPrefs, setP2PPreference } from "./p2p/preference.ts";
import { useMounted, useOperatorP2PDefault, useP2PPrefs } from "./p2p/use-p2p.ts";
import type { PlayerSource } from "./source.ts";
import { nativeMediaBytes, type DataUsage } from "./stats.ts";

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
  /**
   * The viewer's Clip button in the bar (D3.7): the last 30 seconds. Left out without it, and
   * never in the embed.
   */
  clip?: { signedIn: boolean; publicUrl?: string };
  /** Over the picture's top corners (the embed's channel name and "Watch on"). */
  topStart?: React.ReactNode;
  topEnd?: React.ReactNode;
}

const RETRY_MS = 5_000;
/** How often the data meter refreshes while playing. */
const USAGE_REFRESH_MS = 2_000;

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
  clip,
  topStart,
  topEnd,
}: PlayerProps): React.JSX.Element {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const containerRef = React.useRef<HTMLElement>(null);
  const [state, setState] = React.useState<PlayerState>(live ? "loading" : "offline");
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
  // The same controller as state, for the W2 slots (captions toggle, DVR controls) to render with.
  const [controller, setController] = React.useState<PlayerController | null>(null);
  const [features, setFeatures] = React.useState<SessionFeatures>(NO_SESSION_FEATURES);

  // Data mode (ADR 0018): the viewer's choice on this device, read once mounted.
  const savedDataMode = React.useMemo(
    () => (mounted ? readDataModeChoice(localStore(), connectionHints()) : null),
    [mounted],
  );
  const [dataChoice, setDataChoice] = React.useState<DataModeChoice | null>(null);
  if (dataChoice === null && savedDataMode) setDataChoice(savedDataMode.choice);
  const [dataChosen, setDataChosen] = React.useState(false);
  // Embeds have no data-saver panel, so they never play under the site's saved choice: a viewer
  // who chose Audio on the site would otherwise get an unexplained audio-only embed.
  const wantedCeiling = embed ? null : ceilingOf(dataChoice);
  const dataModeOn = wantedCeiling !== null;
  // Read at each session's start without restarting the session when it changes.
  const wantedCeilingRef = React.useRef(wantedCeiling);
  React.useEffect(() => {
    wantedCeilingRef.current = wantedCeiling;
  });
  const [appliedCeiling, setAppliedCeiling] = React.useState<number | null>(null);
  const [usage, setUsage] = React.useState<DataUsage | null | undefined>(undefined);
  const [levels, setLevels] = React.useState<readonly LevelInfo[]>([]);
  const onDataChoice = React.useCallback(
    (next: DataModeChoice) => {
      setDataChoice(next);
      setDataChosen(true);
      saveDataModeChoice(localStore(), next);
      if (embed) return;
      wantedCeilingRef.current = ceilingOf(next);
      controllerRef.current?.setDataMode(ceilingOf(next));
    },
    [embed],
  );

  const policy = env && {
    ...prefs,
    ...env.signals,
    operatorDefault,
    dataMode: wantedCeiling !== null,
    native: env.native,
  };
  const showNotice = policy !== null && noticeDue(policy);
  // Sessions start once the device is known and, when the notice is due, once it is on screen:
  // P2P never starts before the disclosure. Latched, so a later prefs change never restarts one.
  const [gateOpen, setGateOpen] = React.useState(false);
  // The data-mode choice is read too, so the session starts under it.
  if (!gateOpen && env && dataChoice && (!showNotice || noticeOnScreen)) setGateOpen(true);

  // The decision for each new session, read fresh at its start (this effect runs before the
  // session effect below).
  const p2pWanted = React.useRef<(native: boolean) => boolean>(() => false);
  React.useEffect(() => {
    p2pWanted.current = (native) => {
      const now = readP2PPrefs();
      const allowed = p2pAllowed({
        ...now,
        ...deviceSignals(),
        operatorDefault,
        dataMode: wantedCeilingRef.current !== null,
        native,
      });
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
      dataMode: wantedCeilingRef.current,
      onDataMode: setAppliedCeiling,
      onFeatures: setFeatures,
    });
    controllerRef.current = controller;
    setController(controller);
    // The chat panel reads this channel's playhead at send time (`chat/connection.ts`).
    const unregisterClock = registerMediaClock(channel, controller);
    // Watch rooms steer this player's hold-back (decision (r)); native HLS corrects by seek only.
    const unregisterRoom = registerRoomPlayer(
      channel,
      {
        setTargetLatency: (seconds, opts) => controller.setTargetLatency(seconds, opts),
        seekToWallclock: (t) => controller.seekToWallclock(t),
        playheadWallclock: () => controller.playheadWallclock(),
        playbackMode: () => controller.playbackMode(),
        latencySeconds: () => controller.hlsLatencySeconds(),
        seekBy: (ms) => controller.seekBy(ms),
        setPlaybackRate: (rate) => controller.setLivePlaybackRate(rate),
      },
      env?.native ?? false,
    );
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
      unregisterRoom();
      if (controllerRef.current === controller) controllerRef.current = null;
      setController((current) => (current === controller ? null : current));
      void controller.stop();
      setFeatures(NO_SESSION_FEATURES);
      setSource(undefined);
      setP2P(P2P_STATUS_OFF);
      setAppliedCeiling(null);
    };
  }, [channel, live, embed, attempt, gateOpen, env]);

  // The meter and the levels the estimate is judged against, while playing in data mode.
  React.useEffect(() => {
    if (state !== "playing" || !dataModeOn) return;
    const read = () => {
      const c = controllerRef.current;
      const video = videoRef.current;
      if (!c || !video) return;
      // Native HLS downloads out of the page's sight; without WebKit's counters nothing is known.
      setUsage(env?.native && nativeMediaBytes(video) === null ? null : c.dataUsage());
      setLevels(c.playableLevels());
    };
    read();
    const timer = setInterval(read, USAGE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [state, env, dataModeOn]);

  const volume = useVideoVolume(videoRef, true);
  const volumeProps = useVolumeProps(volume);
  const [paused, setPaused] = React.useState(false);
  const playing = state === "playing" && !paused;
  const bar = usePlayerBar({ playing });
  const modes = useScreenModes(containerRef, videoRef);
  const { theatre, setTheatre } = useTheatre();
  const theatreAvailable = useTheatreAvailable() && !embed;
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);

  // Quality: Auto plus hls.js's renditions, read when the menu opens (levels arrive with the playlist).
  const [quality, setQualityState] = React.useState<{ options: QualityOption[]; value: number }>({
    options: [],
    value: -1,
  });
  const { locale } = useLocale();
  const readQuality = React.useCallback(() => {
    const c = controllerRef.current;
    // A controller without the seam (an older fake in tests) simply offers no quality menu.
    if (!c || typeof c.qualityLevels !== "function") return;
    const options = [...c.qualityLevels()]
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bitrate - a.bitrate)
      .map((l) => ({ value: l.index, label: qualityLabel(l, locale) }));
    setQualityState({ options, value: c.quality() });
  }, [locale]);
  React.useEffect(() => {
    if (state === "playing") readQuality();
  }, [state, readQuality]);
  const pickQuality = (index: number) => {
    controllerRef.current?.setQuality(index);
    readQuality();
  };
  const inDvr = playbackMode === "dvr";
  const qualityLocked = dataModeOn ? t("player.settings.qualityDataSaver") : inDvr ? t("dvr.sourceOnly") : undefined;
  // Data saver picks the quality while it is on, so a manual pick goes back to Auto.
  React.useEffect(() => {
    if (dataModeOn && typeof controllerRef.current?.setQuality === "function") controllerRef.current.setQuality(-1);
  }, [dataModeOn]);

  const { hold } = bar;
  const onClipOpen = React.useCallback((open: boolean) => hold("clip", open), [hold]);
  const onSettingsOpen = React.useCallback(
    (open: boolean) => {
      hold("settings", open);
      if (open) readQuality();
    },
    [hold, readQuality],
  );
  const settings = useSettings({ onOpenChange: onSettingsOpen });

  const dvrShown = features.dvr !== null && features.dvr.windowSeconds > 0 && !(dataModeOn || appliedCeiling !== null);
  // In fullscreen the player's popups (and this dialog) portal into its popup layer, not <body>.
  const [popupLayer, setPopupLayer] = React.useState<HTMLDivElement | null>(null);
  // Stays in fullscreen: the dialog portals into the player (PortalContainerProvider below).
  const openShortcuts = () => {
    settings.setOpen(false);
    setShortcutsOpen(true);
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  };

  usePlayerShortcuts(
    containerRef,
    (action) => {
      const video = videoRef.current;
      const c = controllerRef.current;
      const handled = ((): boolean => {
        switch (action) {
          case "playPause":
            if (state !== "playing") return false;
            togglePlay();
            return true;
          case "mute":
            volume.toggleMute();
            return true;
          case "volumeUp":
          case "volumeDown": {
            if (!video) return false;
            const from = video.muted ? 0 : video.volume;
            volume.setVolume(from + (action === "volumeUp" ? VOLUME_STEP : -VOLUME_STEP));
            return true;
          }
          case "fullscreen":
            if (modes.fullscreen.support === "none") return false;
            modes.fullscreen.toggle();
            return true;
          case "theatre":
            if (!theatreAvailable) return false;
            setTheatre(!theatre);
            return true;
          case "captions": {
            const toggle = containerRef.current?.querySelector<HTMLElement>('[data-testid="player-captions-toggle"]');
            if (!toggle) return false;
            toggle.click();
            return true;
          }
          case "back":
          case "forward": {
            if (!dvrShown || !c || state !== "playing") return false;
            const behind = behindLiveSeconds(c, Date.now());
            if (action === "forward") {
              if (c.playbackMode() !== "dvr") return false;
              void seekerFor(c).seek(behind - SEEK_STEP_SECONDS);
            } else {
              // From the live edge, the first step back lands just past it (closer plays live).
              void seekerFor(c).seek(Math.max(behind, DVR_LIVE_EDGE_SECONDS) + SEEK_STEP_SECONDS);
            }
            return true;
          }
          case "help":
            openShortcuts();
            return true;
          case "backToLive":
            return false;
        }
      })();
      if (handled) bar.poke();
      return handled;
    },
    live,
  );

  const onNoticeShown = React.useCallback(() => {
    noticeShown.current = true;
    setNoticeOnScreen(true);
  }, []);

  // The W2 slots render while a session plays; each unit's component decides what it shows.
  const slot =
    state === "playing" && controller !== null
      ? {
          controller,
          dvr: {
            controller,
            grant: features.dvr,
            dataMode: dataModeOn || appliedCeiling !== null,
            playbackMode,
          },
        }
      : null;

  const stage =
    state === "offline" ? (
      offline
    ) : state === "loading" ? (
      <output>{t("player.loading")}</output>
    ) : state === "error" ? (
      <p role="alert">{t("player.error")}</p>
    ) : undefined;

  const menu = (
    <>
      <QualitySection options={quality.options} value={quality.value} onChange={pickQuality} locked={qualityLocked} />
      {/* Data saver (ADR 0018) lives here since F5; kept mounted with the menu, so its state stays. */}
      {live && !embed && dataChoice && (
        <DataModePanel
          compact
          choice={dataChoice}
          onChoice={onDataChoice}
          applied={appliedCeiling}
          wanted={state === "playing" ? wantedCeiling : appliedCeiling}
          native={env?.native ?? false}
          suggested={!dataChosen && savedDataMode?.saved === false && savedDataMode.suggested !== null}
          levels={levels}
          usage={state === "playing" && dataModeOn ? usage : undefined}
          dvr={inDvr}
        />
      )}
      <ShortcutsButton onOpen={openShortcuts} />
    </>
  );

  return (
    <PortalContainerProvider container={modes.fullscreen.element ? popupLayer : null}>
      <PlayerChrome
        ref={containerRef}
        portalRef={setPopupLayer}
        data-testid="player"
        data-state={state}
        data-source={source}
        data-p2p={p2p.state}
        data-playback-mode={playbackMode}
        data-data-mode={appliedCeiling === null ? "" : String(appliedCeiling)}
        data-dvr-window={String(features.dvr?.windowSeconds ?? 0)}
        data-captions={features.captions.state}
        data-theatre={theatre ? "on" : "off"}
        variant={live ? "live" : "offline"}
        liveBadgeProps={{ "data-testid": "live-badge" }}
        topStart={topStart}
        topEnd={topEnd}
        stage={stage}
        scrubber={slot ? <DvrScrubber {...slot.dvr} /> : undefined}
        controlsVisible={bar.visible}
        controlsProps={{ "data-testid": "player-controls", ...bar.barProps }}
        {...bar.rootProps}
        volume={state === "playing" ? volumeProps : undefined}
        controls={
          state === "playing" ? (
            <>
              <PlayerControl
                data-testid="player-play"
                label={paused ? t("player.bar.play") : t("player.bar.pause")}
                tooltip={withKey(paused ? t("player.bar.play") : t("player.bar.pause"), "K")}
                icon={paused ? PlayIcon : PauseIcon}
                shortcut="K"
                onClick={togglePlay}
              />
              {p2p.available && <P2PIndicator status={p2p} onOpen={() => setDialogOpen(true)} />}
              {slot && <CaptionsToggle controller={slot.controller} captions={features.captions} />}
              {slot && <DvrControls {...slot.dvr} />}
              {live && !embed && clip ? (
                <ClipButton
                  target={{ kind: "live", channel }}
                  signedIn={clip.signedIn}
                  publicUrl={clip.publicUrl}
                  onOpenChange={onClipOpen}
                />
              ) : null}
            </>
          ) : undefined
        }
        settings={
          live && state !== "offline"
            ? settings.props(menu, !embed && dataChoice ? <DataSaverChip choice={dataChoice} /> : undefined)
            : undefined
        }
        controlsEnd={state === "playing" ? <ScreenButtons modes={modes} embed={embed} /> : undefined}
        className={cn("w-full", className)}
      >
        <video
          ref={videoRef}
          data-testid="player-video"
          muted
          autoPlay
          playsInline
          crossOrigin="anonymous"
          onVolumeChange={(e) => volume.sync(e.currentTarget)}
          onPlay={() => setPaused(false)}
          onPause={() => setPaused(true)}
        />
        {live && showNotice && (
          <P2PNotice onShown={onNoticeShown} onDismiss={markP2PNoticeSeen} onTurnOff={() => setP2PPreference("off")} />
        )}
      </PlayerChrome>
      {(p2p.available || dialogOpen) && (
        <P2PDialog open={dialogOpen} onOpenChange={setDialogOpen} status={p2p} loadPrivacyPolicy={loadPrivacyPolicy} />
      )}
      {live && (
        <ShortcutsDialog
          open={shortcutsOpen}
          onOpenChange={setShortcutsOpen}
          entries={shortcutsFor({ seek: dvrShown, dvr: dvrShown, theatre: theatreAvailable })}
        />
      )}
    </PortalContainerProvider>
  );
}

/** "Label (K)": the tooltip names the shortcut. */
const withKey = (label: string, key: string) => t("player.bar.withKey", { label, key });
