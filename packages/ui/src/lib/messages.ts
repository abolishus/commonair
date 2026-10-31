// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DISCOVERY_REASONS } from "@commonair/contracts/dto";
import { type MessageArgs, createTranslator } from "@commonair/i18n";
import english from "../locales/en/ui.json" with { type: "json" };

export type DiscoveryReason = (typeof DISCOVERY_REASONS)[number];

/**
 * Strings the design system itself needs (screen-reader labels, built-in
 * buttons). Components never inline them: they read this catalog through
 * `LocaleProvider`, so the app supplies the active locale's messages.
 * The source is `src/locales/<lang>/ui.json` (flat `ui.*` keys, the ICU subset of
 * `@commonair/i18n`); `uiMessagesFromCatalog` builds this typed object from one.
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

/** One locale's `ui.json`: `"ui.close": "Close"`, … */
export type UiCatalog = Readonly<Record<string, string>>;

/** The English `ui.json`, the source of truth and every other locale's per-key fallback. */
export const enUiCatalog: UiCatalog = english;

type UiKey = keyof typeof english;

/**
 * Every bundled `ui.json`, loaded on demand (one chunk per locale in the app). Listed by hand,
 * not `import.meta.glob`, so the map also works outside Vite; `tests/ui-messages.test.ts`
 * fails when a `locales/<lang>/ui.json` is missing here.
 */
export const UI_CATALOGS: Readonly<Record<string, () => Promise<UiCatalog>>> = {
  en: async () => enUiCatalog,
  es: async () => (await import("../locales/es/ui.json", { with: { type: "json" } })).default,
};

/**
 * Build `UiMessages` for `locale` from its `ui.json`. A key the catalog lacks (or whose
 * translation is empty or does not parse) falls back to `fallback`, English by default; the
 * viewer count's plural follows `locale`'s rules.
 */
export function uiMessagesFromCatalog(
  locale: string,
  catalog: UiCatalog,
  fallback: UiCatalog = enUiCatalog,
): UiMessages {
  const translate = createTranslator<string>({ locale, messages: catalog, fallback });
  const m = (key: UiKey, args?: MessageArgs): string => translate(key, args);
  const reason = (key: DiscoveryReason): string => translate(`ui.discoveryReason.${key}`);
  return {
    close: m("ui.close"),
    cancel: m("ui.cancel"),
    confirm: m("ui.confirm"),
    more: m("ui.more"),
    morePages: m("ui.morePages"),
    previous: m("ui.previous"),
    next: m("ui.next"),
    previousPage: m("ui.previousPage"),
    nextPage: m("ui.nextPage"),
    breadcrumb: m("ui.breadcrumb"),
    pagination: m("ui.pagination"),
    loading: m("ui.loading"),
    notifications: m("ui.notifications"),
    closeNotification: m("ui.closeNotification"),
    mature: m("ui.mature"),
    live: m("ui.live"),
    viewerCount: (formatted, count) => m("ui.viewerCount", { formatted, count }),
    // Spelled out so the contract stays a type-only import; the Record type makes the compiler
    // reject a missing or extra reason.
    discoveryReason: {
      popular: reason("popular"),
      spotlight: reason("spotlight"),
      new: reason("new"),
      following: reason("following"),
      random: reason("random"),
      category: reason("category"),
      search: reason("search"),
    },
    theme: {
      label: m("ui.theme.label"),
      dark: m("ui.theme.dark"),
      light: m("ui.theme.light"),
      system: m("ui.theme.system"),
    },
    commandPalette: {
      title: m("ui.commandPalette.title"),
      description: m("ui.commandPalette.description"),
      placeholder: m("ui.commandPalette.placeholder"),
      empty: m("ui.commandPalette.empty"),
    },
    sidebar: {
      toggle: m("ui.sidebar.toggle"),
      title: m("ui.sidebar.title"),
      description: m("ui.sidebar.description"),
    },
  };
}

/** English `UiMessages`: the default outside a `LocaleProvider`, for stories and tests. */
export const enMessages: UiMessages = uiMessagesFromCatalog("en", enUiCatalog);
