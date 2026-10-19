// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { Badge } from "@commonair/ui/components/badge";
import { Skeleton } from "@commonair/ui/components/skeleton";
import { Slider } from "@commonair/ui/components/slider";
import { cn } from "@commonair/ui/lib/utils";

export interface ClipTrimmerProps extends Omit<
  React.ComponentProps<typeof Slider>,
  "value" | "defaultValue" | "onValueChange"
> {
  value: [number, number];
  onValueChange: (value: [number, number]) => void;
  duration: number;
  minDuration: number;
  maxDuration: number;
  startLabel: string;
  endLabel: string;
  durationLabel: string;
  formatTime: (seconds: number) => string;
  thumbnails?: Array<string | null>;
}

export function ClipTrimmer({
  value,
  onValueChange,
  duration,
  minDuration,
  maxDuration,
  startLabel,
  endLabel,
  durationLabel,
  formatTime,
  thumbnails = [],
  className,
  ...props
}: ClipTrimmerProps): React.JSX.Element {
  const selected = Math.max(0, value[1] - value[0]);
  return (
    <section data-slot="clip-trimmer" className={cn("flex min-w-0 flex-col gap-3", className)}>
      <div aria-hidden className="grid min-w-0 grid-cols-4 gap-1 overflow-hidden">
        {thumbnails.length
          ? thumbnails.map((src, index) =>
              src ? (
                <img key={index} src={src} alt="" className="aspect-video min-w-0 object-cover" />
              ) : (
                <Skeleton key={index} className="aspect-video min-w-0" />
              ),
            )
          : Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="aspect-video min-w-0" />)}
      </div>
      <Slider
        aria-label={durationLabel}
        aria-valuetext={`${startLabel}, ${formatTime(value[0])}; ${endLabel}, ${formatTime(value[1])}`}
        value={value}
        onValueChange={(next) => {
          const values = Array.isArray(next) ? next : [next, next];
          onValueChange([values[0] ?? 0, values[1] ?? duration]);
        }}
        min={0}
        max={duration}
        minStepsBetweenValues={minDuration}
        {...props}
      />
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {startLabel}: {formatTime(value[0])}
        </span>
        <Badge variant="outline">
          {formatTime(selected)} / {formatTime(maxDuration)}
        </Badge>
        <span>
          {endLabel}: {formatTime(value[1])}
        </span>
      </div>
    </section>
  );
}
