// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where the consent banner sits (overhaul wave 2, the cookie banner redesign). It floats as a
 * card in the bottom corner: the end corner from `md` up, a bottom sheet inside the 16 px gutter
 * below. Pages with a player (watch pages and the studio, whose control room and rehearsal show
 * one) get it in the page flow above everything instead, so it can never cover the video at any
 * width, theatre mode included.
 */
import { shellArea, tabBarVisible } from "../../lib/nav.ts";

export type BannerPlacement = "floating" | "inline";

export interface BannerLayout {
  placement: BannerPlacement;
  /** Below `md` the bottom tab bar is on screen, so the sheet sits above it. */
  aboveTabBar: boolean;
}

export function bannerLayout(pathname: string): BannerLayout {
  const area = shellArea(pathname);
  if (area === "watch" || area === "studio") return { placement: "inline", aboveTabBar: false };
  return { placement: "floating", aboveTabBar: tabBarVisible(pathname) };
}

// The tab bar is 56 px (`h-14`) plus the bottom safe-area inset (`BottomTabBar`); the sheet keeps
// the 16 px gutter above it, or above the inset where there is no bar. From `md` the bar is gone.
const BOTTOM_CLEAR = "bottom-safe-gutter";
const BOTTOM_ABOVE_TAB_BAR = "bottom-safe-tab-bar";

/**
 * Over the bottom tab bar (`z-30`), under dialogs and sheets (`z-50`). The height is capped so
 * a short phone keeps most of the page; the card scrolls inside itself if it must.
 */
const FLOATING =
  "fixed inset-x-4 z-40 max-h-sheet overflow-y-auto md:inset-x-auto md:end-6 md:bottom-6 md:w-96 md:max-w-viewport-6";
const INLINE = "relative z-20 mx-4 mt-4 lg:mx-auto lg:max-w-3xl";

/** The position classes for a layout (the surface and motion classes are the banner's own). */
export function placementClasses(layout: BannerLayout): string {
  if (layout.placement === "inline") return INLINE;
  return `${FLOATING} ${layout.aboveTabBar ? BOTTOM_ABOVE_TAB_BAR : BOTTOM_CLEAR}`;
}
