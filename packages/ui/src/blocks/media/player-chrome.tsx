// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { AspectRatio } from "@commonair/ui/components/aspect-ratio";
import { Slider } from "@commonair/ui/components/slider";
import { PortalContainerProvider, usePortalContainer } from "@commonair/ui/lib/portal-container";
import { cn } from "@commonair/ui/lib/utils";
import { IconButton, LiveBadge, OverlayBadge, ViewerCount, type LiveBadgeProps } from "@commonair/ui";

type DataAttributes = { [key: `data-${string}`]: string | undefined };

export interface PlayerControlProps extends DataAttributes {
  label: string;
  icon: React.ComponentProps<typeof IconButton>["icon"];
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  pressed?: boolean;
  disabled?: boolean;
  /** Tooltip text when it should differ from the label (e.g. to name the shortcut). */
  tooltip?: React.ReactNode;
  /** The control's keyboard shortcut (`aria-keyshortcuts`). */
  shortcut?: string;
  className?: string;
}

export function PlayerControl({
  label,
  icon,
  onClick,
  pressed,
  disabled,
  tooltip,
  shortcut,
  className,
  ...data
}: PlayerControlProps): React.JSX.Element {
  return (
    <IconButton
      label={label}
      icon={icon}
      tooltip={tooltip}
      onClick={onClick}
      aria-pressed={pressed}
      aria-keyshortcuts={shortcut}
      disabled={disabled}
      className={cn("text-overlay-foreground", className)}
      {...data}
    />
  );
}

/** Mute plus a level slider, revealed on hover or focus (always shown on touch screens). */
export interface PlayerVolumeProps {
  muted: boolean;
  /** 0 to 1. */
  level: number;
  onToggleMute: () => void;
  onLevelChange: (level: number) => void;
  muteLabel: string;
  unmuteLabel: string;
  sliderLabel: string;
  /** The level as read aloud (e.g. "40%"). */
  valueText: string;
  muteIcon: PlayerControlProps["icon"];
  unmuteIcon: PlayerControlProps["icon"];
  shortcut?: string;
}

function PlayerVolume(v: PlayerVolumeProps): React.JSX.Element {
  const level = v.muted ? 0 : Math.round(Math.min(1, Math.max(0, v.level)) * 100);
  return (
    <div data-slot="player-volume" className="group/volume flex min-w-0 items-center">
      {/* The label names the action (Mute / Unmute), so no `pressed` state on top of it. */}
      <PlayerControl
        data-testid="player-mute"
        label={v.muted ? v.unmuteLabel : v.muteLabel}
        icon={v.muted ? v.unmuteIcon : v.muteIcon}
        shortcut={v.shortcut}
        onClick={v.onToggleMute}
      />
      <div className="w-0 overflow-hidden opacity-0 transition-all group-focus-within/volume:w-20 group-focus-within/volume:px-2 group-focus-within/volume:opacity-100 group-hover/volume:w-20 group-hover/volume:px-2 group-hover/volume:opacity-100 pointer-coarse:w-16 pointer-coarse:px-2 pointer-coarse:opacity-100 motion-reduce:transition-none">
        <Slider
          data-testid="player-volume"
          aria-label={v.sliderLabel}
          getAriaLabel={() => v.sliderLabel}
          getAriaValueText={() => v.valueText}
          value={[level]}
          min={0}
          max={100}
          step={5}
          onValueChange={(next) => {
            const n = typeof next === "number" ? next : (next[0] ?? 0);
            v.onLevelChange(n / 100);
          }}
        />
      </div>
    </div>
  );
}

/**
 * The settings menu: a gear in the control row opening a panel over the picture (quality, data
 * saver, speed). It lives inside the player, not in a portal, so it shows in fullscreen too, and
 * it stays mounted while closed (hidden), so its state (a half-typed custom budget) survives.
 * Escape or a press outside closes it; Escape and the close button return focus to the gear.
 */
export interface PlayerSettingsProps {
  label: string;
  icon: PlayerControlProps["icon"];
  /** The panel's close button. */
  closeLabel: string;
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Forwarded to the gear (e.g. `data-testid`). */
  triggerProps?: DataAttributes;
  /** Forwarded to the panel. */
  contentProps?: DataAttributes;
  /** Shown just before the gear (e.g. the data saver chip). */
  badge?: React.ReactNode;
  /** A one-time note beside the gear; it never takes focus. */
  hint?: { open: boolean; children: React.ReactNode; props?: DataAttributes };
}

const PANEL =
  "absolute inset-0 z-40 flex flex-col gap-3 overflow-y-auto bg-popover p-3 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden sm:inset-auto sm:end-2 sm:top-2 sm:bottom-14 sm:w-80";
const HINT =
  "absolute end-2 bottom-14 z-40 flex w-64 max-w-full flex-col gap-2 bg-popover p-3 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10";

interface SettingsState {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Close and give focus back to the gear (Escape, the close button). */
  close: () => void;
  setTrigger: (el: HTMLButtonElement | null) => void;
  setPanel: (el: HTMLElement | null) => void;
  id: string;
}

function useSettingsState(s: PlayerSettingsProps | undefined): SettingsState {
  const [inner, setInner] = React.useState(false);
  const open = s?.open ?? inner;
  const onOpenChange = s?.onOpenChange;
  const setOpen = React.useCallback(
    (next: boolean) => {
      setInner(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const [trigger, setTrigger] = React.useState<HTMLButtonElement | null>(null);
  const [panel, setPanel] = React.useState<HTMLElement | null>(null);
  const close = React.useCallback(() => {
    setOpen(false);
    trigger?.focus();
  }, [setOpen, trigger]);
  const id = React.useId();
  React.useEffect(() => {
    if (!open) return;
    panel?.focus();
    const onPress = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (panel?.contains(t) || trigger?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Only while focus is in the menu or on the gear: Escape elsewhere belongs to someone else.
      const t = e.target;
      if (!(t instanceof Node) || !(panel?.contains(t) || trigger?.contains(t))) return;
      e.preventDefault();
      close();
    };
    document.addEventListener("pointerdown", onPress);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPress);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen, close, panel, trigger]);
  return { open, setOpen, close, setTrigger, setPanel, id };
}

function SettingsTrigger({ s, state }: { s: PlayerSettingsProps; state: SettingsState }): React.JSX.Element {
  const { open, setOpen, setTrigger, id } = state;
  return (
    <>
      {s.badge}
      <IconButton
        ref={setTrigger}
        label={s.label}
        icon={s.icon}
        aria-expanded={open}
        aria-controls={`${id}-settings`}
        className="text-overlay-foreground"
        onClick={() => setOpen(!open)}
        {...s.triggerProps}
      />
    </>
  );
}

function SettingsPanel({ s, state }: { s: PlayerSettingsProps; state: SettingsState }): React.JSX.Element {
  const { open, close, setPanel, id } = state;
  return (
    <>
      <section
        ref={setPanel}
        id={`${id}-settings`}
        data-slot="player-settings"
        aria-labelledby={`${id}-settings-title`}
        hidden={!open}
        tabIndex={-1}
        className={PANEL}
        {...s.contentProps}
      >
        <div className="flex items-center justify-between gap-2">
          <h2 id={`${id}-settings-title`} className="text-sm font-medium">
            {s.label}
          </h2>
          <IconButton label={s.closeLabel} icon={Cancel01Icon} size="icon-sm" onClick={close} />
        </div>
        {s.children}
      </section>
      {s.hint?.open && !open && (
        <aside data-slot="player-hint" className={HINT} {...s.hint.props}>
          {s.hint.children}
        </aside>
      )}
    </>
  );
}

function fullscreenElement(): Element | null {
  if (typeof document === "undefined") return null;
  const d = document as Document & { webkitFullscreenElement?: Element | null };
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

/** Whether `el` is the fullscreen element, following `fullscreenchange`. */
function useIsFullscreen(el: HTMLElement | null): boolean {
  const [on, setOn] = React.useState(false);
  React.useEffect(() => {
    if (!el) return;
    const sync = () => setOn(fullscreenElement() === el);
    sync();
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, [el]);
  return on;
}

export interface PlayerChromeProps extends React.ComponentProps<"section"> {
  children: React.ReactNode;
  variant: "live" | "vod" | "clip" | "preview" | "offline";
  topStart?: React.ReactNode;
  topEnd?: React.ReactNode;
  controls?: React.ReactNode;
  /** The far end of the control row (PiP, theatre, fullscreen), after the settings gear. */
  controlsEnd?: React.ReactNode;
  scrubber?: React.ReactNode;
  stage?: React.ReactNode;
  liveLabel?: string;
  /** Forwarded to the built-in live badge (e.g. `data-testid`). */
  liveBadgeProps?: Partial<LiveBadgeProps> & DataAttributes;
  viewerCount?: number;
  timeLabel?: string;
  /**
   * Whether the control bar shows. Omitted: it shows on hover and focus (and always on touch), by
   * CSS alone. Given: the caller decides (auto-hide timing), and keyboard focus inside the bar
   * still shows it. Under reduced motion the bar never fades.
   */
  controlsVisible?: boolean;
  /** Forwarded to the control bar (e.g. `data-testid`, pointer handlers). */
  controlsProps?: React.ComponentProps<"div"> & DataAttributes;
  volume?: PlayerVolumeProps;
  settings?: PlayerSettingsProps;
  /**
   * The player's popup layer (`data-slot="player-portal"`): an absolutely positioned, click-through
   * layer over the player. While fullscreen, popups inside the chrome portal into it; pass it to a
   * `PortalContainerProvider` around the chrome's siblings (dialogs) for the same. It sits out of
   * the fullscreen grid's flow, so a mounted popup never takes a grid row from the picture.
   */
  portalRef?: (layer: HTMLDivElement | null) => void;
}

export function PlayerChrome({
  children,
  variant,
  topStart,
  topEnd,
  controls,
  controlsEnd,
  scrubber,
  stage,
  liveLabel,
  liveBadgeProps,
  viewerCount,
  timeLabel,
  controlsVisible,
  controlsProps,
  volume,
  settings,
  portalRef,
  className,
  ref,
  ...props
}: PlayerChromeProps): React.JSX.Element {
  const [section, setSection] = React.useState<HTMLElement | null>(null);
  const setRef = React.useCallback(
    (el: HTMLElement | null) => {
      setSection(el);
      if (typeof ref === "function") ref(el as HTMLElement & HTMLDivElement);
      else if (ref) (ref as React.RefObject<HTMLElement | null>).current = el;
    },
    [ref],
  );
  const fullscreen = useIsFullscreen(section);
  const [layer, setLayer] = React.useState<HTMLDivElement | null>(null);
  const setLayerRef = React.useCallback(
    (el: HTMLDivElement | null) => {
      setLayer(el);
      portalRef?.(el);
    },
    [portalRef],
  );
  // `<body>` is not painted while the player is fullscreen: popups go to the layer then.
  const inherited = usePortalContainer() ?? null;
  const portalContainer = fullscreen ? layer : inherited;
  const controlled = controlsVisible !== undefined;
  const hasEnd = settings !== undefined || controlsEnd !== undefined;
  const settingsState = useSettingsState(settings);
  return (
    <PortalContainerProvider container={portalContainer}>
      <section
        ref={setRef}
        data-slot="player-chrome"
        data-variant={variant}
        data-fullscreen={fullscreen ? "" : undefined}
        className={cn(
          "group/player relative min-w-0 overflow-hidden bg-muted data-fullscreen:grid data-fullscreen:place-items-center data-fullscreen:bg-overlay",
          className,
        )}
        {...props}
      >
        <AspectRatio
          ratio={16 / 9}
          className="relative isolate group-data-fullscreen/player:aspect-auto group-data-fullscreen/player:size-full"
        >
          <div className="absolute inset-0 [&>video]:size-full [&>video]:object-contain">{children}</div>
          <div className="pointer-events-none absolute inset-x-2 top-2 z-10 flex items-start justify-between gap-2">
            <div className="flex flex-wrap gap-1">
              {topStart}
              {variant === "live" && <LiveBadge label={liveLabel} pulse {...liveBadgeProps} />}
            </div>
            <div className="flex flex-wrap justify-end gap-1">
              {topEnd}
              {viewerCount !== undefined && <ViewerCount count={viewerCount} variant="overlay" />}
            </div>
          </div>
          {stage && <div className="absolute inset-0 z-20 grid place-items-center bg-background/80">{stage}</div>}
          <div
            data-slot="player-controls"
            data-visible={controlled ? String(controlsVisible) : undefined}
            {...controlsProps}
            className={cn(
              "absolute inset-x-0 bottom-0 z-30 flex flex-col gap-1 bg-overlay/90 p-2 text-overlay-foreground transition-opacity motion-reduce:transition-none",
              controlled
                ? controlsVisible
                  ? "opacity-100"
                  : "pointer-events-none opacity-0 has-focus-visible:pointer-events-auto has-focus-visible:opacity-100 motion-reduce:pointer-events-auto motion-reduce:opacity-100"
                : "opacity-0 group-focus-within/player:opacity-100 group-hover/player:opacity-100 pointer-coarse:opacity-100",
              controlsProps?.className,
            )}
          >
            {scrubber}
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {volume && <PlayerVolume {...volume} />}
              {controls}
              {timeLabel && <OverlayBadge className={hasEnd ? undefined : "ms-auto"}>{timeLabel}</OverlayBadge>}
              {hasEnd && (
                <div className="ms-auto flex items-center gap-1">
                  {settings && <SettingsTrigger s={settings} state={settingsState} />}
                  {controlsEnd}
                </div>
              )}
            </div>
          </div>
          {settings && <SettingsPanel s={settings} state={settingsState} />}
        </AspectRatio>
        {/* Absolute, so out of the fullscreen grid's flow; click-through except for the popups. */}
        <div
          ref={setLayerRef}
          data-slot="player-portal"
          className="pointer-events-none absolute inset-0 z-50 *:pointer-events-auto"
        />
      </section>
    </PortalContainerProvider>
  );
}

export interface PlayerScrubberProps extends Omit<React.ComponentProps<typeof Slider>, "value" | "defaultValue"> {
  value: number;
  max: number;
  label: string;
  valueText: string;
}

export function PlayerScrubber({ value, max, label, valueText, ...props }: PlayerScrubberProps): React.JSX.Element {
  // The root is a group; the thumb's range input is the slider, so it takes the name and value text.
  return (
    <Slider
      aria-label={label}
      getAriaLabel={() => label}
      getAriaValueText={() => valueText}
      value={[value]}
      min={0}
      max={max}
      {...props}
    />
  );
}
