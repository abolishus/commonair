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
 */
import { formatDuration, IconButton } from "@commonair/ui";
import { PlayerChrome, PlayerControl, PlayerScrubber } from "@commonair/ui/blocks/media";
import type * as D from "@commonair/contracts/dto";
import { ClosedCaptionIcon, PauseIcon, PlayIcon, VolumeHighIcon, VolumeOffIcon } from "@hugeicons/core-free-icons";
import type Hls from "hls.js";
import * as React from "react";
import type { z } from "zod";
import { activeLocale, baseLanguage, t } from "../../i18n/index.ts";
import { applyCaptionStyle, browserStorage, readCaptionStyle } from "../../player/captions-state.ts";
import "../../player/captions.css";
import { prefersNativeHls } from "../../player/controller.ts";
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
  handleRef?: React.Ref<WatchPlayerHandle>;
}

type PlayerState = "loading" | "ready" | "error";

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

export function VodPlayer({
  source,
  variant,
  title,
  durationSeconds,
  captions,
  onPlayhead,
  handleRef,
}: VodPlayerProps): React.JSX.Element {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const hlsRef = React.useRef<Hls | null>(null);
  const [state, setState] = React.useState<PlayerState>("loading");
  const [playing, setPlaying] = React.useState(false);
  const [muted, setMuted] = React.useState(true);
  const [time, setTime] = React.useState(0);
  const [duration, setDuration] = React.useState(durationSeconds);
  const [dragging, setDragging] = React.useState<number | null>(null);
  const [playhead, setPlayhead] = React.useState("");
  const [ccOn, setCcOn] = React.useState(false);
  const onPlayheadRef = React.useRef(onPlayhead);
  React.useEffect(() => {
    onPlayheadRef.current = onPlayhead;
  }, [onPlayhead]);

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
    const report = () => {
      const at = playerWallclock(source, video, hlsRef.current);
      setPlayhead(at ? at.toISOString() : "");
      setTime(video.currentTime);
      onPlayheadRef.current?.(at);
    };
    const onMeta = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) setDuration(video.duration);
      setState("ready");
      report();
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
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
  const toggleMute = () => {
    const video = videoRef.current;
    if (video) video.muted = !video.muted;
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

  const shownTime = dragging ?? time;
  const stage =
    state === "error" ? (
      <p className="p-4 text-center text-sm">{t("replay.player.error")}</p>
    ) : state === "loading" ? (
      <p className="p-4 text-center text-sm">{t("replay.player.loading")}</p>
    ) : undefined;

  return (
    <PlayerChrome
      data-testid="vod-player"
      data-playhead={playhead}
      data-state={state}
      variant={variant}
      aria-label={title}
      stage={stage}
      timeLabel={`${formatDuration(shownTime)} / ${formatDuration(duration)}`}
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
      controls={
        <>
          <PlayerControl
            label={playing ? t("replay.player.pause") : t("replay.player.play")}
            icon={playing ? PauseIcon : PlayIcon}
            onClick={togglePlay}
          />
          <PlayerControl
            label={muted ? t("replay.player.unmute") : t("replay.player.mute")}
            icon={muted ? VolumeOffIcon : VolumeHighIcon}
            onClick={toggleMute}
          />
          {captions.length > 0 && (
            <IconButton
              data-testid="vod-captions-toggle"
              data-state={ccOn ? "on" : "off"}
              aria-pressed={ccOn}
              icon={ClosedCaptionIcon}
              label={ccOn ? t("replay.player.captionsOff") : t("replay.player.captionsOn")}
              onClick={toggleCaptions}
              className="text-overlay-foreground"
            />
          )}
        </>
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
      >
        {captions.map((c) => (
          <track key={c.url} kind="subtitles" src={c.url} srcLang={c.language} label={c.label} />
        ))}
      </video>
    </PlayerChrome>
  );
}

const firstValue = (v: number | readonly number[]): number => (typeof v === "number" ? v : (v[0] ?? 0));
