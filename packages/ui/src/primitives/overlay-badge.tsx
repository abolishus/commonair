// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { cva, type VariantProps } from "class-variance-authority";
import { Badge } from "../components/badge.tsx";
import { cn } from "../lib/utils.ts";

export const overlayBadgeVariants = cva("bg-overlay text-overlay-foreground tabular-nums [a]:hover:bg-overlay", {
  variants: {
    size: {
      sm: "h-4 gap-0.5 px-1 text-2xs [&>svg]:size-3!",
      md: "h-5 px-1.5 text-xs",
    },
  },
  defaultVariants: { size: "md" },
});

export interface OverlayBadgeProps
  extends Omit<React.ComponentProps<typeof Badge>, "variant">, VariantProps<typeof overlayBadgeVariants> {
  /** Optional leading Hugeicon (decorative). */
  icon?: IconSvgElement;
}

/**
 * Text over video or thumbnails (durations, viewer counts, "Mature"): the
 * `--overlay` scrim keeps it AA over any frame, white or black, in both themes.
 */
export function OverlayBadge({ size, icon, className, children, ...props }: OverlayBadgeProps): React.JSX.Element {
  return (
    <Badge variant="secondary" data-overlay="" className={cn(overlayBadgeVariants({ size }), className)} {...props}>
      {icon && <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden data-icon="inline-start" />}
      {children}
    </Badge>
  );
}
