// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/// <reference types="vite/client" />
import { LocaleProvider, NowProvider, TooltipProvider, applyTheme, useResolvedTheme, type Theme } from "@commonair/ui";
import { Toaster } from "@commonair/ui/toast";
import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import * as React from "react";
import { locale, t, uiMessages } from "../i18n/index.ts";
import { getBootstrap } from "../lib/bootstrap.ts";
import { storeTheme } from "../lib/theme.ts";
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
      { title: t("app.title") },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent(): React.JSX.Element {
  const boot = Route.useLoaderData();
  const [theme, setThemeState] = React.useState<Theme>(boot.theme);
  const resolved = useResolvedTheme(theme);
  // Set once React has hydrated: input typed before then is reset by React, so tests (the harness,
  // screen readers' automation) can wait for `html[data-hydrated]` before they interact.
  React.useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);
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
    <html lang={locale} data-theme={theme} className={theme === "light" ? "light" : undefined}>
      <head>
        <HeadContent />
      </head>
      <body className="min-h-dvh bg-background font-sans text-foreground antialiased">
        <LocaleProvider locale={locale} messages={uiMessages}>
          <NowProvider now={boot.now}>
            <TooltipProvider>
              <ThemeContext.Provider value={themeValue}>
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
