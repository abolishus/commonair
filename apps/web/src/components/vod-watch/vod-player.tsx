// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The VOD and clip player (W2-vod-watch). `PlayerController` is bound to a live `playback.start`
 * session, so recordings get this small player: a VOD's HLS playlist through hls.js (a dynamic
 * import, as the live player does) or natively where `prefersNativeHls` says so, a clip's MP4 on
 * the element itself. It reports the playhead's wall clock (`wallclock.ts`) to the replay panel
 * and seeks to a wall-clock instant when a replay line's time is pressed.
 *
 * Captions: `Vod.captions` are WebVTT tracks on the element, with a CC toggle of its own (the live
 * `CaptionsToggle` needs a `PlayerController`); the viewer's caption style from the live player
 * applies here too.
 *
 * The control bar is the live player's (D2-player, F3): volume, captions, settings (quality on
 * HLS, speed), PiP, theatre where the page offers it, fullscreen, and the same shortcuts.
 */
import {
  formatDuration,
  IconButton,
  PortalContainerProvider,
  SkeletonGroup,
  SkeletonThumbnail,
  useLocale,
} from "@commonair/ui";
import { PlayerChrome, PlayerControl, PlayerScrubber } from "@commonair/ui/blocks/media";
import type * as D from "@commonair/contracts/dto";
import { ClosedCaptionIcon, PauseIcon, PlayIcon } from "@hugeicons/core-free-icons";
import type Hls from "hls.js";
import * as React from "react";
import type { z } from "zod";
import { activeLocale, baseLanguage, t } from "../../i18n/index.ts";
import { applyCaptionStyle, browserStorage, readCaptionStyle } from "../../player/captions-state.ts";
import "../../player/captions.css";
import { usePlayerBar } from "../../player/bar.ts";
import { localStore, readDataModeChoice } from "../../player/budget.ts";
import {
  QualitySection,
  ScreenButtons,
  ShortcutsButton,
  ShortcutsDialog,
  SpeedSection,
  qualityLabel,
  shortcutsFor,
  useSettings,
  useVideoVolume,
  useVolumeProps,
  type QualityOption,
} from "../../player/controls.tsx";
import { prefersNativeHls } from "../../player/controller.ts";
import { DataModeNotice } from "../../player/data-mode.tsx";
import { useScreenModes } from "../../player/fullscreen.ts";
import { SEEK_STEP_SECONDS, VOLUME_STEP, usePlayerShortcuts } from "../../player/shortcuts.ts";
import { useTheatre, useTheatreAvailable } from "../../player/theatre.ts";
import { ClipButton } from "../watch/clip-button.tsx";
import {
  clipOrigin,
  hlsOrigin,
  hlsWallclock,
  mediaTimeAt,
  nativeOrigin,
  originWallclock,
  type HlsClock,
} from "./wallclock.ts";

export type CaptionTrack = z.infer<typeof D.CaptionTrack>;

export type WatchSource =
  | { kind: "hls"; url: string }
  | { kind: "mp4"; url: string; /** `Clip.windowStartedAt`. */ windowStartedAt: string | null };

/** What the page asks of the player. */
export interface WatchPlayerHandle {
  /** The wall clock under the playhead; null before the first frame. */
  playheadWallclock(): Date | null;
  /** The wall clock at media time 0; null while unknown. */
  originWallclock(): Date | null;
  /** Move to the media at wall clock `t`; false, and nothing moves, when `t` is outside it. */
  seekToWallclock(t: Date): boolean;
}

export interface VodPlayerProps {
  source: WatchSource;
  variant: "vod" | "clip";
  title: string;
  /** Known length (the element's duration wins once loaded). */
  durationSeconds: number;
  captions: readonly CaptionTrack[];
  /** Called whenever the playhead moves (play, seek, metadata), with its wall clock. */
  onPlayhead?: (wallclock: Date | null) => void;
  /** The playhead in media seconds, on every time update and on pause (Continue watching). */
  onProgress?: (progress: PlayerProgress) => void;
  /** Videos only: the viewer's Clip button in the bar (D3.7). */
  clip?: { channel: string; vodId: string; signedIn: boolean; publicUrl?: string };
  handleRef?: React.Ref<WatchPlayerHandle>;
}

type PlayerState = "loading" | "ready" | "error";

export interface PlayerProgress {
  positionSeconds: number;
  /** The element's duration once known, else the known length. */
  durationSeconds: number;
  paused: boolean;
}

/** The caption track to show first: the page's language, else the first one. */
export function preferredTrack(tracks: readonly CaptionTrack[], locale: string): number {
  const lang = baseLanguage(locale);
  const i = tracks.findIndex((tr) => baseLanguage(tr.language) === lang);
  return i >= 0 ? i : 0;
}

/** The wall clock under the playhead for this source (`hls` null on native HLS and clips). */
export function playerWallclock(source: WatchSource, video: HTMLVideoElement, hls: HlsClock | null): Date | null {
  if (source.kind === "mp4") return originWallclock(video, clipOrigin(source.windowStartedAt));
  if (hls) return hlsWallclock(hls);
  return originWallclock(video, nativeOrigin(video));
}

export function playerOrigin(source: WatchSource, video: HTMLVideoElement, hls: HlsClock | null): number | null {
  if (source.kind === "mp4") return clipOrigin(source.windowStartedAt);
  if (hls) {
    const fromLevels = hlsOrigin(hls);
    if (fromLevels !== null) return fromLevels;
    const at = hlsWallclock(hls);
    return at ? at.getTime() - video.currentTime * 1000 : null;
  }
  return nativeOrigin(video);
}

// The live player's Data saver choice (it is changed there, never on this page).
const subscribeNothing = () => () => {};
const readDataSaverOn = () => readDataModeChoice(localStore(), null).choice.on;
const serverDataSaverOff = () => false;

export function VodPlayer({
  source,
  variant,
  title,
  durationSeconds,
  captions,
  onPlayhead,
  onProgress,
  clip,
  handleRef,
}: VodPlayerProps): React.JSX.Element {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const containerRef = React.useRef<HTMLElement>(null);
  const hlsRef = React.useRef<Hls | null>(null);
  const [state, setState] = React.useState<PlayerState>("loading");
  const [playing, setPlaying] = React.useState(false);
  const [time, setTime] = React.useState(0);
  const [duration, setDuration] = React.useState(durationSeconds);
  const [dragging, setDragging] = React.useState<number | null>(null);
  const [playhead, setPlayhead] = React.useState("");
  const [ccOn, setCcOn] = React.useState(false);
  const onPlayheadRef = React.useRef(onPlayhead);
  React.useEffect(() => {
    onPlayheadRef.current = onPlayhead;
  }, [onPlayhead]);
  const onProgressRef = React.useRef(onProgress);
  React.useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);
  const knownDuration = React.useRef(durationSeconds);
  React.useEffect(() => {
    knownDuration.current = durationSeconds;
  }, [durationSeconds]);

  const handle = React.useMemo<WatchPlayerHandle>(
    () => ({
      playheadWallclock: () => {
        const video = videoRef.current;
        return video ? playerWallclock(source, video, hlsRef.current) : null;
      },
      originWallclock: () => {
        const video = videoRef.current;
        const origin = video ? playerOrigin(source, video, hlsRef.current) : null;
        return origin === null ? null : new Date(origin);
      },
      seekToWallclock: (at) => {
        const video = videoRef.current;
        if (!video) return false;
        const target = mediaTimeAt(playerOrigin(source, video, hlsRef.current), video.duration, at);
        if (target === null) return false;
        video.currentTime = target;
        return true;
      },
    }),
    [source],
  );
  React.useImperativeHandle(handleRef, () => handle, [handle]);

  // Load the source.
  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let stopped = false;
    setState("loading");
    const load = async () => {
      if (source.kind === "mp4") {
        video.src = source.url;
        return;
      }
      const { default: HlsCtor } = await import("hls.js");
      if (stopped) return;
      if (prefersNativeHls(video, HlsCtor.isSupported())) {
        video.src = source.url;
        return;
      }
      const hls = new HlsCtor();
      hlsRef.current = hls;
      hls.on(HlsCtor.Events.ERROR, (_e, data) => {
        if (data.fatal && !stopped) setState("error");
      });
      hls.loadSource(source.url);
      hls.attachMedia(video);
    };
    void load().catch(() => !stopped && setState("error"));
    return () => {
      stopped = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video.removeAttribute("src");
      video.load();
    };
  }, [source]);

  // Follow the playhead.
  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const progress = () => {
      const length = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : knownDuration.current;
      onProgressRef.current?.({ positionSeconds: video.currentTime, durationSeconds: length, paused: video.paused });
    };
    const report = () => {
      const at = playerWallclock(source, video, hlsRef.current);
      setPlayhead(at ? at.toISOString() : "");
      setTime(video.currentTime);
      onPlayheadRef.current?.(at);
      progress();
    };
    const onMeta = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) setDuration(video.duration);
      setState("ready");
      report();
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      progress();
    };
    const onError = () => setState("error");
    const events: [string, () => void][] = [
      ["timeupdate", report],
      ["seeking", report],
      ["seeked", report],
      ["loadedmetadata", onMeta],
      ["durationchange", onMeta],
      ["play", onPlay],
      ["pause", onPause],
      ["ended", onPause],
      ["error", onError],
    ];
    for (const [name, fn] of events) video.addEventListener(name, fn);
    return () => {
      for (const [name, fn] of events) video.removeEventListener(name, fn);
    };
  }, [source]);

  React.useEffect(() => applyCaptionStyle(document.documentElement, readCaptionStyle(browserStorage)), []);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  };
  const toggleCaptions = () => {
    const video = videoRef.current;
    if (!video) return;
    const next = !ccOn;
    const chosen = preferredTrack(captions, activeLocale());
    video.querySelectorAll("track").forEach((el, i) => {
      el.track.mode = next && i === chosen ? "showing" : "disabled";
    });
    setCcOn(next);
  };

  // The control bar (D2-player): the same pieces as the live player, with speed instead of data saver.
  const volume = useVideoVolume(videoRef, true);
  const volumeProps = useVolumeProps(volume);
  const bar = usePlayerBar({ playing });
  const modes = useScreenModes(containerRef, videoRef);
  const { theatre, setTheatre } = useTheatre();
  const theatreAvailable = useTheatreAvailable();
  const [rate, setRate] = React.useState(1);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const { locale } = useLocale();
  const [quality, setQualityState] = React.useState<{ options: QualityOption[]; value: number }>({
    options: [],
    value: -1,
  });
  const readQuality = React.useCallback(() => {
    const hls = hlsRef.current;
    if (!hls) return;
    const options = hls.levels
      .map((l, index) => ({
        index,
        height: l.height > 0 ? l.height : null,
        frameRate: Number.isFinite(l.frameRate) && l.frameRate > 0 ? l.frameRate : null,
        bitrate: Number.isFinite(l.bitrate) ? l.bitrate : 0,
        audioOnly: !l.videoCodec && !((l.width ?? 0) > 0),
      }))
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bitrate - a.bitrate)
      .map((l) => ({ value: l.index, label: qualityLabel(l, locale) }));
    // The viewer's pick (-1 for Auto), not `nextLevel`, which follows ABR's switches.
    setQualityState({ options, value: hls.manualLevel });
  }, [locale]);
  const { hold } = bar;
  const onClipOpen = React.useCallback((open: boolean) => hold("clip", open), [hold]);
  const settings = useSettings({
    onOpenChange: React.useCallback(
      (open: boolean) => {
        hold("settings", open);
        if (open) readQuality();
      },
      [hold, readQuality],
    ),
  });
  // Data saver applies to live streams only (ADR 0018 decision 7): say so where it would be.
  // False on the server and while hydrating, so the first client render matches the server's.
  const dataSaverOn = React.useSyncExternalStore(subscribeNothing, readDataSaverOn, serverDataSaverOff);
  // In fullscreen the player's popups (and this dialog) portal into its popup layer, not <body>.
  const [popupLayer, setPopupLayer] = React.useState<HTMLDivElement | null>(null);
  // Stays in fullscreen: the dialog portals into the player (PortalContainerProvider below).
  const openShortcuts = () => {
    settings.setOpen(false);
    setShortcutsOpen(true);
  };
  const seekBy = (seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    const end = Number.isFinite(video.duration) ? video.duration : duration;
    video.currentTime = Math.min(Math.max(0, video.currentTime + seconds), Math.max(0, end));
  };

  usePlayerShortcuts(containerRef, (action) => {
    const video = videoRef.current;
    const handled = ((): boolean => {
      switch (action) {
        case "playPause":
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
        case "back":
          seekBy(-SEEK_STEP_SECONDS);
          return true;
        case "forward":
          seekBy(SEEK_STEP_SECONDS);
          return true;
        case "fullscreen":
          if (modes.fullscreen.support === "none") return false;
          modes.fullscreen.toggle();
          return true;
        case "theatre":
          if (!theatreAvailable) return false;
          setTheatre(!theatre);
          return true;
        case "captions":
          if (captions.length === 0) return false;
          toggleCaptions();
          return true;
        case "help":
          openShortcuts();
          return true;
        case "backToLive":
          return false;
      }
    })();
    if (handled) bar.poke();
    return handled;
  });

  const shownTime = dragging ?? time;
  const stage =
    state === "error" ? (
      <p className="p-4 text-center text-sm">{t("replay.player.error")}</p>
    ) : state === "loading" ? (
      // The frame's shape while the video loads; the group is aria-busy and names it for screen readers (F28).
      <SkeletonGroup data-testid="vod-player-loading" label={t("replay.player.loading")} className="size-full">
        <SkeletonThumbnail className="size-full" />
      </SkeletonGroup>
    ) : undefined;

  const menu = (
    <>
      <QualitySection
        options={quality.options}
        value={quality.value}
        onChange={(index) => {
          const hls = hlsRef.current;
          if (hls) hls.nextLevel = index;
          readQuality();
        }}
      />
      <SpeedSection
        value={rate}
        onChange={(next) => {
          const video = videoRef.current;
          if (video) video.playbackRate = next;
          setRate(next);
        }}
      />
      {dataSaverOn && <DataModeNotice reason="vod" />}
      <ShortcutsButton onOpen={openShortcuts} />
    </>
  );

  return (
    <PortalContainerProvider container={modes.fullscreen.element ? popupLayer : null}>
      <PlayerChrome
        ref={containerRef}
        portalRef={setPopupLayer}
        data-testid="vod-player"
        data-playhead={playhead}
        data-state={state}
        data-theatre={theatre ? "on" : "off"}
        variant={variant}
        aria-label={title}
        stage={stage}
        timeLabel={`${formatDuration(shownTime)} / ${formatDuration(duration)}`}
        controlsVisible={bar.visible}
        controlsProps={{ "data-testid": "player-controls", ...bar.barProps }}
        {...bar.rootProps}
        scrubber={
          <PlayerScrubber
            value={Math.min(shownTime, duration)}
            max={Math.max(duration, 0)}
            step={1}
            largeStep={10}
            label={t("replay.player.seek")}
            valueText={formatDuration(shownTime)}
            onValueChange={(v) => setDragging(firstValue(v))}
            onValueCommitted={(v) => {
              setDragging(null);
              const video = videoRef.current;
              if (video) video.currentTime = firstValue(v);
            }}
          />
        }
        volume={{ ...volumeProps, muteLabel: t("replay.player.mute"), unmuteLabel: t("replay.player.unmute") }}
        controls={
          <>
            <PlayerControl
              data-testid="player-play"
              label={playing ? t("replay.player.pause") : t("replay.player.play")}
              icon={playing ? PauseIcon : PlayIcon}
              shortcut="K"
              onClick={togglePlay}
            />
            {captions.length > 0 && (
              <IconButton
                data-testid="vod-captions-toggle"
                data-state={ccOn ? "on" : "off"}
                aria-pressed={ccOn}
                aria-keyshortcuts="C"
                icon={ClosedCaptionIcon}
                label={ccOn ? t("replay.player.captionsOff") : t("replay.player.captionsOn")}
                onClick={toggleCaptions}
                className="text-overlay-foreground"
              />
            )}
            {variant === "vod" && clip ? (
              <ClipButton
                target={{
                  kind: "vod",
                  channel: clip.channel,
                  vodId: clip.vodId,
                  durationSeconds,
                  position: () => videoRef.current?.currentTime ?? null,
                }}
                signedIn={clip.signedIn}
                publicUrl={clip.publicUrl}
                defaultTitle={title}
                onOpenChange={onClipOpen}
              />
            ) : null}
          </>
        }
        settings={settings.props(menu)}
        controlsEnd={<ScreenButtons modes={modes} embed={false} />}
        className="w-full"
      >
        <video
          ref={videoRef}
          muted
          autoPlay
          playsInline
          crossOrigin="anonymous"
          onVolumeChange={(e) => volume.sync(e.currentTarget)}
          onRateChange={(e) => setRate(e.currentTarget.playbackRate)}
        >
          {captions.map((c) => (
            <track key={c.url} kind="subtitles" src={c.url} srcLang={c.language} label={c.label} />
          ))}
        </video>
      </PlayerChrome>
      <ShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={setShortcutsOpen}
        entries={shortcutsFor({ seek: true, dvr: false, theatre: theatreAvailable })}
      />
    </PortalContainerProvider>
  );
}

const firstValue = (v: number | readonly number[]): number => (typeof v === "number" ? v : (v[0] ?? 0));
