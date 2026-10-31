// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PSEUDO_LOCALE } from "@commonair/i18n";
import { formatLanguageName } from "@commonair/ui";
import type * as React from "react";
import { SUPPORTED_LOCALES, activeLocale } from "../../i18n/index.ts";

/** The locales a switcher offers: every supported one but the pseudo-locale (batch 5 decision (g)). */
export function switchableLocales(): string[] {
  return SUPPORTED_LOCALES.filter((tag) => tag !== PSEUDO_LOCALE);
}

/**
 * A language's own name, marked with its `lang` so screen readers pronounce it right, followed by
 * its name in the current UI language when that differs ("Español Spanish" while browsing in English).
 */
export function LanguageLabel({ tag }: { tag: string }): React.JSX.Element {
  const own = formatLanguageName(tag, tag);
  const inUi = formatLanguageName(tag, activeLocale());
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span lang={tag}>{own}</span>
      {inUi !== own ? <span className="text-muted-foreground">{inUi}</span> : null}
    </span>
  );
}
