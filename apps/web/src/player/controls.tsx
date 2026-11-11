// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The control bar's shared pieces for the live and VOD players (D2-player, F3 and F5): the
 * fullscreen, PiP, theatre and chat buttons, the settings menu's sections (quality, speed), the
 * data saver chip and the `?` shortcuts dialog. Test ids:
 * `player-controls`, `player-settings`, `player-fullscreen`, `player-theatre`, `player-pip`,
 * `player-shortcuts-dialog`, `player-data-saver-chip` (harness `D_TEST_IDS`).
 */
import { formatNumber, formatPercent, OverlayBadge, Shortcut, useLocale } from "@commonair/ui";
import { PlayerControl, type PlayerChromeProps } from "@commonair/ui/blocks/media";
import { Button } from "@commonair/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@commonair/ui/components/dialog";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@commonair/ui/components/field";
import { RadioGroup, RadioGroupItem } from "@commonair/ui/components/radio-group";
import {
  FullScreenIcon,
  MinimizeScreenIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PictureInPictureExitIcon,
  PictureInPictureOnIcon,
  RectangularIcon,
  Settings02Icon,
  VolumeHighIcon,
  VolumeOffIcon,
} from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../i18n/index.ts";
import type { MessageKey } from "../i18n/keys/index.gen.ts";
import { isPreset, type DataModeChoice } from "./budget.ts";
import type { ScreenModes } from "./fullscreen.ts";
import { PLAYER_SHORTCUTS, VOLUME_STEP, type ShortcutEntry } from "./shortcuts.ts";
import { useTheatre, useTheatreAvailable, useTheatreChat } from "./theatre.ts";

type Volume = NonNullable<PlayerChromeProps["volume"]>;
type Settings = NonNullable<PlayerChromeProps["settings"]>;

/** Mute or unmute the element (the element is the browser's, not React state). */
function flipMute(el: HTMLVideoElement): void {
  el.muted = !el.muted;
  // Unmuting at volume 0 would still be silent.
  if (!el.muted && el.volume === 0) el.volume = VOLUME_STEP * 5;
  if (!el.muted) void el.play().catch(() => undefined);
}

/** Set the element's volume (0 to 1, in hundredths); 0 is muted. */
function applyVolume(el: HTMLVideoElement, next: number): void {
  const v = Math.min(1, Math.max(0, Math.round(next * 100) / 100));
  el.volume = v;
  el.muted = v === 0;
}

/** The video element's volume and mute, followed through `volumechange`. */
export function useVideoVolume(video: React.RefObject<HTMLVideoElement | null>, initiallyMuted: boolean) {
  const [muted, setMuted] = React.useState(initiallyMuted);
  const [level, setLevel] = React.useState(1);
  const sync = React.useCallback((el: HTMLVideoElement) => {
    setMuted(el.muted);
    setLevel(Number.isFinite(el.volume) ? el.volume : 1);
  }, []);
  const toggleMute = React.useCallback(() => {
    const el = video.current;
    if (!el) return;
    flipMute(el);
    sync(el);
  }, [video, sync]);
  const setVolume = React.useCallback(
    (next: number) => {
      const el = video.current;
      if (!el) return;
      applyVolume(el, next);
      sync(el);
    },
    [video, sync],
  );
  return { muted, level, toggleMute, setVolume, sync };
}

/** The bar's volume control (`PlayerChrome`'s `volume`). */
export function useVolumeProps(v: ReturnType<typeof useVideoVolume>): Volume {
  const { locale } = useLocale();
  return {
    muted: v.muted,
    level: v.level,
    onToggleMute: v.toggleMute,
    onLevelChange: v.setVolume,
    muteLabel: t("player.mute"),
    unmuteLabel: t("player.unmute"),
    sliderLabel: t("player.bar.volume"),
    valueText: formatPercent(v.muted ? 0 : v.level, locale),
    muteIcon: VolumeHighIcon,
    unmuteIcon: VolumeOffIcon,
    shortcut: "M",
  };
}

/** "Label (K)": the tooltip names the shortcut. */
const withKey = (label: string, key: string) => t("player.bar.withKey", { label, key });

/** PiP, theatre (and chat while in theatre) and fullscreen, at the end of the bar. */
export function ScreenButtons({ modes, embed }: { modes: ScreenModes; embed: boolean }): React.JSX.Element {
  const { theatre, setTheatre } = useTheatre();
  const theatreAvailable = useTheatreAvailable() && !embed;
  const { chatHidden, setChatHidden } = useTheatreChat();
  return (
    <>
      {modes.pip.support !== "none" && (
        <PlayerControl
          data-testid="player-pip"
          data-state={modes.pip.active ? "on" : "off"}
          label={modes.pip.active ? t("player.bar.exitPip") : t("player.bar.pip")}
          icon={modes.pip.active ? PictureInPictureExitIcon : PictureInPictureOnIcon}
          pressed={modes.pip.active}
          onClick={modes.pip.toggle}
        />
      )}
      {theatreAvailable && theatre && (
        <PlayerControl
          data-testid="player-theatre-chat"
          label={chatHidden ? t("player.bar.showChat") : t("player.bar.hideChat")}
          icon={chatHidden ? PanelRightOpenIcon : PanelRightCloseIcon}
          pressed={chatHidden}
          onClick={() => setChatHidden(!chatHidden)}
          className="hidden lg:inline-flex"
        />
      )}
      {theatreAvailable && (
        <PlayerControl
          data-testid="player-theatre"
          data-state={theatre ? "on" : "off"}
          label={theatre ? t("player.bar.exitTheatre") : t("player.bar.theatre")}
          tooltip={withKey(theatre ? t("player.bar.exitTheatre") : t("player.bar.theatre"), "T")}
          icon={RectangularIcon}
          shortcut="T"
          pressed={theatre}
          onClick={() => setTheatre(!theatre)}
          className="hidden lg:inline-flex"
        />
      )}
      {modes.fullscreen.support !== "none" && (
        <PlayerControl
          data-testid="player-fullscreen"
          data-state={modes.fullscreen.active ? "on" : "off"}
          data-mode={modes.fullscreen.support}
          label={modes.fullscreen.active ? t("player.bar.exitFullscreen") : t("player.bar.fullscreen")}
          tooltip={withKey(modes.fullscreen.active ? t("player.bar.exitFullscreen") : t("player.bar.fullscreen"), "F")}
          icon={modes.fullscreen.active ? MinimizeScreenIcon : FullScreenIcon}
          shortcut="F"
          onClick={modes.fullscreen.toggle}
        />
      )}
    </>
  );
}

export interface QualityOption {
  /** `-1` is Auto. */
  value: number;
  label: string;
}

/** A radio list in the settings menu. */
function RadioSection<V extends number>({
  legend,
  value,
  options,
  onChange,
  disabled,
  note,
  testId,
}: {
  legend: string;
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (v: V) => void;
  disabled?: boolean;
  note?: string | undefined;
  testId: string;
}): React.JSX.Element {
  const id = React.useId();
  return (
    <FieldSet disabled={disabled} data-testid={testId}>
      <FieldLegend variant="label">{legend}</FieldLegend>
      <RadioGroup
        value={String(value)}
        disabled={disabled}
        onValueChange={(v) => {
          const found = options.find((o) => String(o.value) === v);
          if (found) onChange(found.value);
        }}
      >
        {options.map((o) => (
          <Field key={o.value} orientation="horizontal">
            <RadioGroupItem id={`${id}-${o.value}`} value={String(o.value)} data-testid={`${testId}-${o.value}`} />
            <FieldLabel htmlFor={`${id}-${o.value}`} className="font-normal">
              {o.label}
            </FieldLabel>
          </Field>
        ))}
      </RadioGroup>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </FieldSet>
  );
}

/** Quality: Auto plus the source's renditions, highest first. Hidden with one rendition or none. */
export function QualitySection({
  options,
  value,
  onChange,
  locked,
}: {
  options: readonly QualityOption[];
  value: number;
  onChange: (index: number) => void;
  /** Why the quality is not the viewer's to pick now (data saver, DVR), or undefined. */
  locked?: string | undefined;
}): React.JSX.Element | null {
  if (options.length < 2) return null;
  const all: QualityOption[] = [{ value: -1, label: t("player.settings.auto") }, ...options];
  return (
    <RadioSection
      testId="player-settings-quality"
      legend={t("player.settings.quality")}
      value={locked ? -1 : value}
      options={all}
      onChange={onChange}
      disabled={locked !== undefined}
      note={locked}
    />
  );
}

export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** Playback speed (VOD only). */
export function SpeedSection({
  value,
  onChange,
}: {
  value: number;
  onChange: (rate: number) => void;
}): React.JSX.Element {
  const { locale } = useLocale();
  return (
    <RadioSection
      testId="player-settings-speed"
      legend={t("player.settings.speed")}
      value={value}
      options={PLAYBACK_RATES.map((r) => ({
        value: r,
        label:
          r === 1 ? t("player.settings.speedNormal") : t("player.settings.rate", { rate: formatNumber(r, locale) }),
      }))}
      onChange={onChange}
    />
  );
}

/** A quality label from a rendition: `720p60`, `480p`, or "Audio only". */
export function qualityLabel(
  level: { height: number | null; frameRate: number | null; audioOnly: boolean; bitrate: number },
  locale: string,
): string {
  if (level.audioOnly) return t("player.settings.audioOnly");
  if (level.height !== null && level.height > 0) {
    const fps = level.frameRate !== null && level.frameRate > 31 ? String(Math.round(level.frameRate)) : "";
    return `${level.height}p${fps}`;
  }
  return t("player.settings.kbps", { kbps: formatNumber(Math.round(level.bitrate / 1000), locale) });
}

const CHIP_LEVELS: Record<number, MessageKey> = {
  50: "player.chip.audio",
  800: "player.chip.low",
  1900: "player.chip.medium",
};

/** "Data saver · Low", in the bar while a budget is on. */
export function DataSaverChip({ choice }: { choice: DataModeChoice }): React.JSX.Element | null {
  const { locale } = useLocale();
  if (!choice.on) return null;
  const preset = CHIP_LEVELS[choice.mbPerHour];
  const level =
    isPreset(choice.mbPerHour) && preset
      ? t(preset)
      : t("player.chip.custom", { mb: formatNumber(choice.mbPerHour, locale) });
  return (
    <OverlayBadge data-testid="player-data-saver-chip" data-mb-per-hour={String(choice.mbPerHour)}>
      {t("player.chip.dataSaver", { level })}
    </OverlayBadge>
  );
}

/**
 * The settings menu's state and props. The one-time hint is gone (D4.2): `ready`, `hintEnabled`
 * and `suggested` are still accepted from the players and ignored, and `hintOpen` is always false.
 */
export function useSettings({
  onOpenChange,
}: {
  ready?: boolean;
  hintEnabled?: boolean;
  suggested?: boolean;
  onOpenChange?: (open: boolean) => void;
}): {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Always false: kept so the players' bar hold keeps compiling. */
  hintOpen: boolean;
  props: (children: React.ReactNode, badge?: React.ReactNode) => Settings;
} {
  const [open, setOpenState] = React.useState(false);
  const setOpen = React.useCallback(
    (next: boolean) => {
      setOpenState(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  return {
    open,
    setOpen,
    hintOpen: false,
    props: (children, badge) => ({
      label: t("player.settings.label"),
      icon: Settings02Icon,
      open,
      onOpenChange: setOpen,
      triggerProps: { "data-testid": "player-settings", "data-state": open ? "open" : "closed" },
      closeLabel: t("player.settings.close"),
      contentProps: { "data-testid": "player-settings-menu" },
      badge,
      children,
    }),
  };
}

/** The "Keyboard shortcuts" entry at the foot of the settings menu. */
export function ShortcutsButton({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  return (
    <Button size="sm" variant="ghost" className="self-start" aria-keyshortcuts="Shift+?" onClick={onOpen}>
      {t("player.settings.shortcuts")}
    </Button>
  );
}

/** Which shortcuts apply to this player. */
export function shortcutsFor(kind: { seek: boolean; dvr: boolean; theatre: boolean }): ShortcutEntry[] {
  return PLAYER_SHORTCUTS.filter(
    (s) =>
      (s.action !== "theatre" || kind.theatre) &&
      (s.when === "all" || (s.when === "seek" && kind.seek) || (s.when === "dvr" && kind.dvr)),
  );
}

/** The `?` dialog listing the shortcuts. */
export function ShortcutsDialog({
  open,
  onOpenChange,
  entries,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: readonly ShortcutEntry[];
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="player-shortcuts-dialog">
        <DialogHeader>
          <DialogTitle>{t("player.shortcuts.title")}</DialogTitle>
          <DialogDescription>{t("player.shortcuts.description")}</DialogDescription>
        </DialogHeader>
        <dl className="flex flex-col gap-2">
          {entries.map((s) => (
            <div key={s.action} className="flex items-center gap-4">
              <dt className="flex w-24 shrink-0 gap-1">
                {s.caps.map((keys) => (
                  <Shortcut key={keys.join("+")} keys={keys} />
                ))}
              </dt>
              <dd data-action={s.action}>{t(s.label)}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
