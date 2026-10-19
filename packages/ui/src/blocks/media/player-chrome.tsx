// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { AspectRatio } from "@commonair/ui/components/aspect-ratio";
import { Slider } from "@commonair/ui/components/slider";
import { cn } from "@commonair/ui/lib/utils";
import { IconButton, LiveBadge, OverlayBadge, ViewerCount, type LiveBadgeProps } from "@commonair/ui";

export interface PlayerControlProps {
  label: string;
  icon: React.ComponentProps<typeof IconButton>["icon"];
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  pressed?: boolean;
  disabled?: boolean;
}

export function PlayerControl({ label, icon, onClick, pressed, disabled }: PlayerControlProps): React.JSX.Element {
  return (
    <IconButton
      label={label}
      icon={icon}
      onClick={onClick}
      aria-pressed={pressed}
      disabled={disabled}
      className="text-overlay-foreground"
    />
  );
}

export interface PlayerChromeProps extends React.ComponentProps<"section"> {
  children: React.ReactNode;
  variant: "live" | "vod" | "clip" | "preview" | "offline";
  topStart?: React.ReactNode;
  topEnd?: React.ReactNode;
  controls?: React.ReactNode;
  scrubber?: React.ReactNode;
  stage?: React.ReactNode;
  liveLabel?: string;
  /** Forwarded to the built-in live badge (e.g. `data-testid`). */
  liveBadgeProps?: Partial<LiveBadgeProps> & { [key: `data-${string}`]: string | undefined };
  viewerCount?: number;
  timeLabel?: string;
}

export function PlayerChrome({
  children,
  variant,
  topStart,
  topEnd,
  controls,
  scrubber,
  stage,
  liveLabel,
  liveBadgeProps,
  viewerCount,
  timeLabel,
  className,
  ...props
}: PlayerChromeProps): React.JSX.Element {
  return (
    <section
      data-slot="player-chrome"
      data-variant={variant}
      className={cn("group/player relative min-w-0 overflow-hidden bg-muted", className)}
      {...props}
    >
      <AspectRatio ratio={16 / 9} className="relative isolate">
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
        <div className="absolute inset-x-0 bottom-0 z-10 flex flex-col gap-1 bg-overlay/90 p-2 text-overlay-foreground opacity-0 transition-opacity group-hover/player:opacity-100 group-focus-within/player:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none">
          {scrubber}
          <div className="flex min-w-0 items-center gap-2">
            {controls}
            {timeLabel && <OverlayBadge className="ms-auto">{timeLabel}</OverlayBadge>}
          </div>
        </div>
      </AspectRatio>
    </section>
  );
}

export interface PlayerScrubberProps extends Omit<React.ComponentProps<typeof Slider>, "value" | "defaultValue"> {
  value: number;
  max: number;
  label: string;
  valueText: string;
}

export function PlayerScrubber({ value, max, label, valueText, ...props }: PlayerScrubberProps): React.JSX.Element {
  return <Slider aria-label={label} aria-valuetext={valueText} value={[value]} min={0} max={max} {...props} />;
}
