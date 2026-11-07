// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/// <reference types="vite/client" />
import { LocaleProvider, NowProvider, TooltipProvider, applyTheme, useResolvedTheme, type Theme } from "@commonair/ui";
import { Toaster } from "@commonair/ui/toast";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
  useLocation,
  useRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import * as React from "react";
import { ConsentRoot } from "../components/consent/consent-root.tsx";
import { ErrorState, NotFoundState, ShellFallback } from "../components/not-found.tsx";
import { PwaRoot } from "../components/pwa/pwa-root.tsx";
import { onLocaleApplied, syncLocale } from "../i18n/client.ts";
import { activeLocale, t, uiMessagesFor } from "../i18n/index.ts";
import { getBootstrap } from "../lib/bootstrap.ts";
import { rootChrome } from "../lib/overlay-page.ts";
import { HYDRATING_CSS, rootHtmlAttributes } from "../lib/root-html.ts";
import { PWA_THEME_COLORS } from "../pwa/theme.ts";
import { storeTheme, tabTheme } from "../lib/theme.ts";
import { ThemeContext } from "../lib/theme-context.ts";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  // Config and session are loaded once per page load; sign-in/out do a full page load.
  loader: () => getBootstrap(),
  staleTime: Number.POSITIVE_INFINITY,
  shouldReload: false,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      // `cover`: the page runs under the home indicator and notches, so the safe-area insets are real
      // numbers the shell and its tab bar pad by (without it they are 0 and the bar sits on the indicator).
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { name: "color-scheme", content: "dark light" },
      { name: "theme-color", content: PWA_THEME_COLORS.dark, media: "(prefers-color-scheme: dark)" },
      { name: "theme-color", content: PWA_THEME_COLORS.light, media: "(prefers-color-scheme: light)" },
      { title: t("app.title") },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      // The installable app (ADR 0028 decision 7): the web server builds the manifest from the instance.
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "icon", href: "/icons/icon.svg", type: "image/svg+xml" },
      { rel: "apple-touch-icon", href: "/icons/apple-touch-icon.png" },
    ],
    styles: [{ children: HYDRATING_CSS }],
  }),
  component: RootComponent,
  notFoundComponent: RootNotFound,
  errorComponent: RootError,
});

/** An unknown URL no layout claimed: inside the root, so with the public chrome. */
function RootNotFound(): React.JSX.Element {
  return (
    <ShellFallback wrap>
      <NotFoundState />
    </ShellFallback>
  );
}

/**
 * The root itself failed (its loader, or a page outside every layout): a whole document, since the
 * root's own `<html>` is gone. No bootstrap here, so no header, and the default theme.
 */
function RootError({ error, reset }: ErrorComponentProps): React.JSX.Element {
  const pathname = useLocation({ select: (location) => location.pathname });
  const locale = activeLocale();
  const chrome = rootChrome(pathname, "dark");
  return (
    <html {...rootHtmlAttributes({ locale, theme: "dark", pathname, hydrating: false })} lang={locale}>
      <head>
        <HeadContent />
      </head>
      <body className={chrome.bodyClass}>
        <LocaleProvider locale={locale} messages={uiMessagesFor(locale)}>
          <TooltipProvider>
            <main id="main-content">
              <ErrorState error={error} reset={reset} />
            </main>
          </TooltipProvider>
        </LocaleProvider>
        <Scripts />
      </body>
    </html>
  );
}

const subscribeNothing = () => () => {};
const tabThemeSnapshot = (): Theme | null => tabTheme() ?? null;
const noTabTheme = (): Theme | null => null;
/** `read`, evaluated on the first call and remembered. */
function latchOnce<T>(read: () => T): () => T {
  let value: { v: T } | null = null;
  return () => (value ??= { v: read() }).v;
}

function RootComponent(): React.JSX.Element {
  const boot = Route.useLoaderData();
  // A theme chosen without Preferences consent lives in this tab only (`sessionStorage`): the
  // server rendered the cookie's theme or the default, and the tab's choice applies right after
  // hydration (the server snapshot is "none", so the first client render matches the HTML).
  const [chosen, setThemeState] = React.useState<Theme | null>(null);
  // Read once: granting consent later moves the value into the cookie and out of the tab.
  const [tabOnce] = React.useState(() => latchOnce(tabThemeSnapshot));
  const tab = React.useSyncExternalStore(subscribeNothing, tabOnce, noTabTheme);
  const theme = chosen ?? tab ?? boot.theme;
  const resolved = useResolvedTheme(theme);
  const pathname = useLocation({ select: (location) => location.pathname });
  const chrome = rootChrome(pathname, theme);
  // Transitions stay off until hydration has settled (`data-hydrating`, F14): two frames, so the
  // tab-only theme applied right after hydration paints without a fade too.
  const [hydrating, setHydrating] = React.useState(true);
  // Set once React has hydrated: input typed before then is reset by React, so tests (the harness,
  // screen readers' automation) can wait for `html[data-hydrated]` before they interact.
  React.useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setHydrating(false));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, []);
  // `t()` is not reactive: a language switch remounts everything under `LocaleProvider` and
  // re-runs the matches so `head()` (the document title) is in the new language too.
  const router = useRouter();
  const [active, setActive] = React.useState({ locale: boot.locale, generation: 0 });
  React.useEffect(
    () =>
      onLocaleApplied((locale) => {
        setActive((s) => ({ locale, generation: s.generation + 1 }));
        void router.invalidate();
      }),
    [router],
  );
  // Also when the loader returns a new locale (a member's `me.update`, then a reload of the root).
  const { locale: bootLocale, localeFromUser } = boot;
  React.useEffect(() => {
    void syncLocale({ locale: bootLocale, localeFromUser });
  }, [bootLocale, localeFromUser]);
  const tabDiffers = chosen === null && tab !== null && tab !== boot.theme;
  React.useEffect(() => {
    if (tabDiffers && tab) applyTheme(tab);
  }, [tabDiffers, tab]);
  const themeValue = React.useMemo(
    () => ({
      theme,
      setTheme: (next: Theme) => {
        setThemeState(next);
        applyTheme(next);
        storeTheme(next);
      },
    }),
    [theme],
  );
  return (
    <html {...rootHtmlAttributes({ locale: active.locale, theme, pathname, hydrating })} lang={active.locale}>
      <head>
        <HeadContent />
      </head>
      <body className={chrome.bodyClass}>
        <LocaleProvider key={active.generation} locale={active.locale} messages={uiMessagesFor(active.locale)}>
          <NowProvider now={boot.now}>
            <TooltipProvider>
              <ThemeContext.Provider value={themeValue}>
                <ConsentRoot consent={boot.consent} signedIn={boot.me !== null} pathname={pathname} />
                <PwaRoot />
                <Outlet />
              </ThemeContext.Provider>
              <Toaster theme={resolved} />
            </TooltipProvider>
          </NowProvider>
        </LocaleProvider>
        <Scripts />
      </body>
    </html>
  );
}
