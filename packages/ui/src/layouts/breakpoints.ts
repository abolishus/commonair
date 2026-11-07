// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The shell's breakpoints in px (design overhaul decisions log): Tailwind's own `sm`…`2xl`, so
 * `md:` in a class and `BREAKPOINTS.md` in a media query mean the same width.
 *
 * - base (<640): one column, the bottom tab bar on browsing pages;
 * - sm 640: two-column grids;
 * - md 768: the header nav inline, the bottom tab bar gone;
 * - lg 1024: watch in two columns (player | chat);
 * - xl 1280: the rail expands;
 * - 2xl 1536: content reaches its cap, `CONTENT_MAX`.
 */
export const BREAKPOINTS = { sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536 } as const;

/** Grids and boards stop growing here (`PageContainer width="page"`). */
export const CONTENT_MAX = 1600;

/**
 * Below this header width the logo mark stands without the name: the `@sm` container size
 * (24rem), the nearest to the decisions log's 400 px that needs no arbitrary value.
 */
export const WORDMARK_MIN = 384;

/** The bottom tab bar's height before the safe-area inset, in px. */
export const TAB_BAR_HEIGHT = 56;

/** A media query that matches below `breakpoint` (the `max-*:` variant). */
export function below(breakpoint: keyof typeof BREAKPOINTS): string {
  return `(max-width: ${BREAKPOINTS[breakpoint] - 0.02}px)`;
}
