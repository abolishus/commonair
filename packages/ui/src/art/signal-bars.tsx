// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { cn } from "../lib/utils.ts";
import type { Accent } from "../primitives/channel-avatar.tsx";
import { artHash } from "./hash.ts";

/** The bars in order: the spectrum of the channel-accent tokens, ending on the neutral one. */
export const SIGNAL_ACCENTS = [
  "red",
  "orange",
  "amber",
  "lime",
  "green",
  "teal",
  "sky",
  "blue",
  "indigo",
  "violet",
  "pink",
  "zinc",
] as const satisfies readonly Accent[];

/** Bar heights in percent, like a test card's level meter. Fixed, so server and browser draw the same. */
export const SIGNAL_HEIGHTS = [30, 55, 80, 100, 70, 45, 65, 90, 60, 40, 75, 35] as const;

export interface SignalBarsProps extends Omit<React.ComponentProps<"svg">, "children"> {
  /** `bars`: twelve bars of different heights. `band`: a flat strip, for edges and section dividers. */
  variant?: "bars" | "band";
  /** Rotates the heights so neighbouring tiles differ; the same seed always draws the same bars. */
  seed?: string;
}

const BAR = 3;
const GAP = 1;

/**
 * The "signal bars" motif: twelve bars, each painted by its channel-accent token (a `data-accent`
 * on the bar scopes `--channel-accent`, and `fill-channel-accent` reads it). Decorative only.
 * It stretches to its box (`preserveAspectRatio="none"`), so size it with classes.
 */
export function SignalBars({ variant = "bars", seed, className, ...props }: SignalBarsProps): React.JSX.Element {
  const band = variant === "band";
  const offset = seed ? artHash(seed) % SIGNAL_HEIGHTS.length : 0;
  const step = band ? 1 : BAR + GAP;
  const width = band ? SIGNAL_ACCENTS.length : SIGNAL_ACCENTS.length * step - GAP;
  return (
    <svg
      viewBox={`0 0 ${width} 100`}
      preserveAspectRatio="none"
      // Adjacent band cells would show hairline seams when antialiased.
      shapeRendering={band ? "crispEdges" : undefined}
      data-slot="art-signal-bars"
      data-variant={variant}
      className={cn("block w-full shrink-0", band ? "h-1.5" : "h-6", className)}
      {...props}
      aria-hidden
      focusable="false"
    >
      {SIGNAL_ACCENTS.map((accent, i) => {
        const height = band ? 100 : (SIGNAL_HEIGHTS[(i + offset) % SIGNAL_HEIGHTS.length] ?? 100);
        return (
          <rect
            key={accent}
            data-accent={accent}
            className="fill-channel-accent"
            x={i * step}
            y={100 - height}
            width={band ? 1 : BAR}
            height={height}
          />
        );
      })}
    </svg>
  );
}
