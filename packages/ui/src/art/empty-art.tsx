// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { cn } from "../lib/utils.ts";
import { Arcs } from "./arcs.tsx";
import { SignalBars } from "./signal-bars.tsx";

export type EmptyArtVariant = "arcs" | "bars" | "glyph";
export type EmptyArtSize = "sm" | "md" | "lg";

export interface EmptyArtProps extends Omit<React.ComponentProps<"span">, "children"> {
  /** `arcs`: the broadcast mark. `bars`: the signal bars. `glyph`: an icon on a tinted plate. */
  variant?: EmptyArtVariant;
  /** The Hugeicons glyph for `glyph` (without one the plate carries the arcs). */
  icon?: IconSvgElement;
  /** sm 56 px (inside panels), md 96 px (lists and sections), lg 160 px (whole pages). */
  size?: EmptyArtSize;
  /** The arcs crossed by one bar: errors and "offline" pages. */
  crossed?: boolean;
}

const BOX: Record<EmptyArtSize, string> = { sm: "size-14", md: "size-24", lg: "size-40" };
const GLYPH: Record<EmptyArtSize, string> = { sm: "size-6", md: "size-10", lg: "size-14" };

/**
 * The picture above an empty or error state, drawn from tokens only. The plate is tinted by the
 * nearest `--channel-accent` (zinc by default, the channel's own accent on creator pages).
 * Decorative: hidden from assistive tech, and static (nothing animates).
 */
export function EmptyArt({
  variant = "arcs",
  icon,
  size = "md",
  crossed = false,
  className,
  ...props
}: EmptyArtProps): React.JSX.Element {
  return (
    <span
      data-slot="empty-art"
      data-variant={variant}
      data-size={size}
      className={cn("relative flex shrink-0 overflow-hidden", BOX[size], className)}
      {...props}
      aria-hidden
    >
      {variant === "arcs" && <Arcs crossed={crossed} className="size-full text-muted-foreground opacity-50" />}
      {variant === "bars" && <SignalBars className="mt-auto h-3/5" />}
      {variant === "glyph" && (
        <span className="relative grid size-full place-items-center bg-card text-channel-accent">
          <span className="absolute inset-0 bg-channel-accent/12 dark:bg-channel-accent/18" />
          {icon ? (
            <HugeiconsIcon icon={icon} strokeWidth={1.5} aria-hidden className={cn("relative", GLYPH[size])} />
          ) : (
            <Arcs crossed={crossed} className={cn("relative opacity-60", GLYPH[size])} />
          )}
          <SignalBars variant="band" className="absolute inset-x-0 bottom-0 h-1" />
        </span>
      )}
    </span>
  );
}
