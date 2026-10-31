// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatLanguageName } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@commonair/ui/components/dropdown-menu";
import { toast } from "@commonair/ui/toast";
import { LanguageSquareIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMatch, useRouter } from "@tanstack/react-router";
import * as React from "react";
import { applyLocale, rememberLocale } from "../../i18n/client.ts";
import { activeLocale, t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { preferencesAllowed } from "../../lib/consent.ts";
import { LanguageLabel, switchableLocales } from "./language-label.tsx";

/**
 * The footer's language switcher (ADR 0029 decision 3; batch 5 decision (f)), on every page.
 * `SiteFooter` clones it with the label ("Language") as its child, which names the trigger for
 * screen readers next to the current language's own name. A visitor's choice is kept with
 * `rememberLocale` (the cookie only with Preferences consent, else this tab); a member's is
 * saved to `users.locale` first, and a failed save switches nothing.
 *
 * Known edge: where the root has no loader data (its error page) a member counts as signed out,
 * so the choice is kept for the visitor but not saved; once the root loads again, the member's
 * saved `users.locale` wins and the page switches back.
 */
export function FooterLocaleSwitcher(props: { children?: React.ReactNode }): React.JSX.Element {
  // Not `useBootstrap()`: the footer also renders where the root has no match yet (an error page).
  const signedIn = useMatch({ from: "__root__", shouldThrow: false, select: (m) => Boolean(m.loaderData?.me) });
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const current = activeLocale();

  const choose = async (tag: string): Promise<void> => {
    if (busy || tag === current) return;
    setBusy(true);
    if (signedIn) {
      try {
        await api().me.update({ locale: tag });
      } catch {
        setBusy(false);
        toast.error(t("localeSwitcher.saveFailed"));
        return;
      }
    }
    try {
      // Remounts the tree, this menu included.
      await applyLocale(tag);
    } catch {
      setBusy(false);
      if (signedIn) {
        // Saved, but not shown: let the root sync from the server, and say a reload applies it.
        await router.invalidate();
        toast.error(t("localeSwitcher.appliesOnReload"));
      } else {
        // Nothing was kept, so the message is true as it stands.
        toast.error(t("localeSwitcher.saveFailed"));
      }
      return;
    }
    // Kept only once the switch worked. This runs in the microtask after `applyLocale`, before the
    // remounted root's `syncLocale` (an effect after a render) reads the tab choice.
    rememberLocale(tag, { preferencesAllowed: preferencesAllowed() });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={busy}
        render={
          <Button
            type="button"
            variant="link"
            data-testid="footer-locale-switcher"
            data-locale={current}
            className="h-auto gap-1.5 px-0 font-normal text-inherit"
          />
        }
      >
        <HugeiconsIcon icon={LanguageSquareIcon} strokeWidth={2} aria-hidden />
        {props.children ? <span className="sr-only">{props.children}</span> : null}
        <span lang={current}>{formatLanguageName(current, current)}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top">
        <DropdownMenuRadioGroup
          value={current}
          onValueChange={(v: unknown) => {
            if (typeof v === "string") void choose(v);
          }}
        >
          {switchableLocales().map((tag) => (
            <DropdownMenuRadioItem key={tag} value={tag} data-testid={`footer-locale-option-${tag}`}>
              <LanguageLabel tag={tag} />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
