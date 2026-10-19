// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DISCOVERY_REASONS } from "@commonair/contracts/dto";

export type DiscoveryReason = (typeof DISCOVERY_REASONS)[number];

/**
 * Strings the design system itself needs (screen-reader labels, built-in
 * buttons). Components never inline them: they read this catalog through
 * `LocaleProvider`, so the app supplies translations from its i18n catalog.
 * `enMessages` is only the fallback for stories and tests.
 */
export interface UiMessages {
  close: string;
  cancel: string;
  confirm: string;
  more: string;
  morePages: string;
  previous: string;
  next: string;
  previousPage: string;
  nextPage: string;
  breadcrumb: string;
  pagination: string;
  loading: string;
  notifications: string;
  closeNotification: string;
  mature: string;
  live: string;
  /** Accessible label for a verified viewer count, e.g. "1,234 verified viewers". */
  viewerCount: (formatted: string, count: number) => string;
  /** Visible label for the "why is this shown" chip on stream cards. */
  discoveryReason: Record<DiscoveryReason, string>;
  theme: { label: string; dark: string; light: string; system: string };
  commandPalette: { title: string; description: string; placeholder: string; empty: string };
  /** `sidebar` component: the toggle button/rail label and the mobile sheet's hidden title. */
  sidebar: { toggle: string; title: string; description: string };
}

export const enMessages: UiMessages = {
  close: "Close",
  cancel: "Cancel",
  confirm: "Confirm",
  more: "More",
  morePages: "More pages",
  previous: "Previous",
  next: "Next",
  previousPage: "Go to previous page",
  nextPage: "Go to next page",
  breadcrumb: "Breadcrumb",
  pagination: "Pagination",
  loading: "Loading",
  notifications: "Notifications",
  closeNotification: "Close notification",
  mature: "Mature",
  live: "Live",
  viewerCount: (formatted, count) => `${formatted} verified ${count === 1 ? "viewer" : "viewers"}`,
  discoveryReason: {
    popular: "Popular",
    spotlight: "Spotlight",
    new: "New streamer",
    following: "Following",
    random: "Random pick",
    category: "In this category",
    search: "Search result",
  },
  theme: { label: "Theme", dark: "Dark", light: "Light", system: "System" },
  commandPalette: {
    title: "Command palette",
    description: "Search for a page or an action",
    placeholder: "Type a command or search…",
    empty: "No results found.",
  },
  sidebar: { toggle: "Toggle sidebar", title: "Sidebar", description: "Site navigation" },
};
