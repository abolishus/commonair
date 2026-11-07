// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { cn } from "../lib/utils.ts";

export interface ArcsProps extends Omit<React.ComponentProps<"svg">, "children"> {
  /** One bar across the mark: the error and offline pages ("the signal is down"). */
  crossed?: boolean;
}

/**
 * The broadcast-arcs mark from `apps/web/public/icons/icon.svg` (strokes only), drawn in
 * `currentColor` so a text-color token paints it. Always decorative: it is hidden from assistive
 * tech and never focusable. The viewBox is cropped to the mark, so it scales edge to edge.
 */
export function Arcs({ crossed = false, className, ...props }: ArcsProps): React.JSX.Element {
  return (
    <svg
      viewBox="80 80 352 352"
      fill="none"
      data-slot="art-arcs"
      data-crossed={crossed || undefined}
      className={cn("aspect-square shrink-0", className)}
      {...props}
      aria-hidden
      focusable="false"
    >
      <circle cx="256" cy="256" r="44" fill="currentColor" />
      <g stroke="currentColor" strokeWidth="36" strokeLinecap="round">
        <path d="M185.3 185.3A100 100 0 0 0 185.3 326.7" />
        <path d="M326.7 185.3A100 100 0 0 1 326.7 326.7" />
        <path d="M135.8 135.8A170 170 0 0 0 135.8 376.2" />
        <path d="M376.2 135.8A170 170 0 0 1 376.2 376.2" />
        {crossed && <path data-slot="art-arcs-cross" d="M112 400 400 112" />}
      </g>
    </svg>
  );
}
