// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/// <reference types="vite/client" />
import { LocaleProvider, NowProvider, TooltipProvider, applyTheme, useResolvedTheme, type Theme } from "@commonair/ui";
import { Toaster } from "@commonair/ui/toast";
import { HeadContent, Outlet, Scripts, createRootRoute, useLocation, useRouter } from "@tanstack/react-router";
import * as React from "react";
import { localeDirection } from "@commonair/i18n";
import { ConsentRoot } from "../components/consent/consent-root.tsx";
import { PwaRoot } from "../components/pwa/pwa-root.tsx";
import { onLocaleApplied, syncLocale } from "../i18n/client.ts";
import { t, uiMessagesFor } from "../i18n/index.ts";
import { getBootstrap } from "../lib/bootstrap.ts";
import { rootChrome } from "../lib/overlay-page.ts";
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
      { name: "viewport", content: "width=device-width, initial-scale=1" },
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
  }),
  component: RootComponent,
});

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
  // Set once React has hydrated: input typed before then is reset by React, so tests (the harness,
  // screen readers' automation) can wait for `html[data-hydrated]` before they interact.
  React.useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
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
    <html
      lang={active.locale}
      dir={localeDirection(active.locale)}
      data-theme={theme}
      data-overlay={chrome.dataOverlay}
      className={chrome.htmlClass}
    >
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
