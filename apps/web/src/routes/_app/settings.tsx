// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageContainer } from "@commonair/ui/layouts";
import { Outlet, createFileRoute, useLocation } from "@tanstack/react-router";
import type * as React from "react";
import { DeletionBanner } from "../../components/settings/deletion-banner.tsx";
import { DeletionProvider, summaryRequest } from "../../components/settings/deletion-state.tsx";
import { settingsCounts } from "../../components/settings/nav-counts.ts";
import { SettingsNav, settingsTabFor, type SettingsItemId } from "../../components/settings/settings-nav.tsx";
import { t } from "../../i18n/index.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import type { SessionUser } from "../../lib/bootstrap-types.ts";
import { titleHead } from "../../lib/page-title.ts";

/**
 * The settings shell (overhaul wave 4, D7.1): the grouped section nav beside the page from `lg`
 * (a select above it below that), one width, and the scheduled-deletion banner above every page
 * (D7.4). Each page guards its own session and brings its own `PageHeader`, whose h1 is the nav
 * label; the email unsubscribe page (signed out, no nav item) renders as it is.
 */
export const Route = createFileRoute("/_app/settings")({
  // A fallback only: every page below sets its own title.
  head: () => titleHead(t("settings.title")),
  component: SettingsLayout,
});

function SettingsLayout(): React.JSX.Element {
  const { me } = useBootstrap();
  const pathname = useLocation({ select: (location) => location.pathname });
  const current = settingsTabFor(pathname);
  if (!me || current === null) return <Outlet />;
  return <SettingsShell current={current} summary={me.settingsSummary} />;
}

type Summary = SessionUser["settingsSummary"];

function SettingsShell({ current, summary }: { current: SettingsItemId; summary: Summary }): React.JSX.Element {
  // The badges and the banner come with the bootstrap's `/me`: no extra requests per page load.
  const counts = settingsCounts(summary);
  return (
    <PageContainer
      data-testid="settings-layout"
      data-width="default"
      className="flex flex-col gap-6 py-8 lg:flex-row lg:items-start"
    >
      <SettingsNav current={current} counts={counts} />
      <DeletionProvider initial={summaryRequest(summary?.deletionScheduledFor)}>
        <div data-testid="settings-main" className="flex min-w-0 max-w-3xl flex-1 flex-col gap-6">
          <DeletionBanner />
          <Outlet />
        </div>
      </DeletionProvider>
    </PageContainer>
  );
}
