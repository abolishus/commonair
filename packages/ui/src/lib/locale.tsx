// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { enMessages, type UiMessages } from "./messages.ts";

export interface LocaleContextValue {
  /** BCP 47 tag used for every `Intl` formatter in the design system. */
  locale: string;
  /** IANA time zone for absolute times; `undefined` = the viewer's own. */
  timeZone: string | undefined;
  messages: UiMessages;
}

const LocaleContext = React.createContext<LocaleContextValue>({
  locale: "en",
  timeZone: undefined,
  messages: enMessages,
});

export interface LocaleProviderProps {
  locale: string;
  timeZone?: string;
  /** Translated design-system strings; missing keys fall back to English. */
  messages?: Partial<UiMessages>;
  children: React.ReactNode;
}

/** Provides the locale and design-system strings to every primitive below it. */
export function LocaleProvider({ locale, timeZone, messages, children }: LocaleProviderProps): React.JSX.Element {
  const value = React.useMemo<LocaleContextValue>(
    () => ({ locale, timeZone, messages: { ...enMessages, ...messages } }),
    [locale, timeZone, messages],
  );
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  return React.useContext(LocaleContext);
}

export function useUiMessages(): UiMessages {
  return React.useContext(LocaleContext).messages;
}

/** A `locale` prop wins over the provider, so a primitive can be formatted for another locale. */
export function useResolvedLocale(locale: string | undefined): string {
  const ctx = React.useContext(LocaleContext);
  return locale ?? ctx.locale;
}
