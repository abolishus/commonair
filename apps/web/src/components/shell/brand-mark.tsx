// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cn } from "@commonair/ui/lib/utils";
import type * as React from "react";

/**
 * The broadcast-arcs mark from `public/icons/icon.svg`, strokes only in `currentColor`: the
 * foreground until the art direction's `--brand-text` token lands (then `text-brand-text`).
 * Decorative; the link around it carries the name.
 */
export function BrandMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="80 80 352 352"
      fill="none"
      aria-hidden="true"
      focusable="false"
      data-slot="brand-mark"
      className={cn("size-6 shrink-0 text-foreground", className)}
    >
      <circle cx="256" cy="256" r="44" fill="currentColor" />
      <g stroke="currentColor" strokeWidth="36" strokeLinecap="round">
        <path d="M185.3 185.3A100 100 0 0 0 185.3 326.7" />
        <path d="M326.7 185.3A100 100 0 0 1 326.7 326.7" />
        <path d="M135.8 135.8A170 170 0 0 0 135.8 376.2" />
        <path d="M376.2 135.8A170 170 0 0 1 376.2 376.2" />
      </g>
    </svg>
  );
}
