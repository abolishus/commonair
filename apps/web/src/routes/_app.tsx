// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AppShell } from "@commonair/ui/layouts";
import { Outlet, createFileRoute, useLocation, type ErrorComponentProps } from "@tanstack/react-router";
import type * as React from "react";
import { LegalPending } from "../components/legal-pending.tsx";
import { ErrorState, NotFoundState, ShellFallback } from "../components/not-found.tsx";
import { AppTabBar } from "../components/shell/tab-bar.tsx";
import { AppFooter, AppHeader, AppRail } from "../components/site-chrome.tsx";
import { t } from "../i18n/index.ts";
import { tabBarVisible } from "../lib/nav.ts";

/**
 * Site chrome for every public page: the header, the rail under it, the footer and, on browsing
 * pages below md, the bottom tab bar. Creator tools use `_studio` and platform tools `_admin`, on
 * the same geometry; embeds and overlays have none.
 */
export const Route = createFileRoute("/_app")({
  component: AppLayout,
  errorComponent: AppError,
  notFoundComponent: AppNotFound,
});

/** The boundary replaced the layout, so the page brings the chrome back. */
function AppError({ error, reset }: ErrorComponentProps): React.JSX.Element {
  return (
    <ShellFallback wrap>
      <ErrorState error={error} reset={reset} />
    </ShellFallback>
  );
}

function AppNotFound(): React.JSX.Element {
  // In place of the layout (its own match is the one not found), or inside its outlet.
  const replaced = Route.useMatch({ select: (m) => m.status === "notFound" });
  return (
    <ShellFallback wrap={replaced}>
      <NotFoundState />
    </ShellFallback>
  );
}

function AppLayout(): React.JSX.Element {
  const pathname = useLocation({ select: (location) => location.pathname });
  const tabBar = tabBarVisible(pathname);
  return (
    <AppShell
      header={<AppHeader tabBar={tabBar} />}
      sidebar={<AppRail />}
      sidebarPlacement="below"
      footer={<AppFooter />}
      bottomBar={tabBar ? <AppTabBar /> : undefined}
      skipLabel={t("nav.skipToContent")}
    >
      <LegalPending />
      <Outlet />
    </AppShell>
  );
}
