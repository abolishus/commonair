// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AppShell } from "@commonair/ui/layouts";
import { Outlet, createFileRoute, type ErrorComponentProps } from "@tanstack/react-router";
import type * as React from "react";
import { LegalPending } from "../components/legal-pending.tsx";
import { ErrorState, NotFoundState, ShellFallback } from "../components/not-found.tsx";
import { AppFooter, AppHeader, AppRail } from "../components/site-chrome.tsx";
import { t } from "../i18n/index.ts";

/** Site chrome (header + footer) for every public page; creator tools use `_studio`, embeds none. */
export const Route = createFileRoute("/_app")({
  component: AppLayout,
  errorComponent: AppError,
  notFoundComponent: AppNotFound,
});

/** The boundary replaced the layout, so the page brings the chrome back. */
function AppError({ reset }: ErrorComponentProps): React.JSX.Element {
  return (
    <ShellFallback wrap>
      <ErrorState reset={reset} />
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
  return (
    <AppShell
      header={<AppHeader />}
      sidebar={<AppRail />}
      sidebarPlacement="below"
      footer={<AppFooter />}
      skipLabel={t("nav.skipToContent")}
    >
      <LegalPending />
      <Outlet />
    </AppShell>
  );
}
