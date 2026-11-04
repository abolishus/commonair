// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageContainer } from "@commonair/ui/layouts";
import { Outlet, createFileRoute, useLocation } from "@tanstack/react-router";
import type * as React from "react";
import { SettingsNav, settingsTabFor } from "../../components/settings/settings-nav.tsx";
import { t } from "../../i18n/index.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { titleHead } from "../../lib/page-title.ts";

/**
 * The settings layout (F27): one width (`default`) and the settings tab row above each of the seven
 * pages. Each page guards its own session and brings its own `PageHeader`; the email unsubscribe
 * page (signed out, no tab) renders as it is.
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
  return (
    <PageContainer data-testid="settings-layout" data-width="default" className="flex flex-col gap-6 py-8">
      <SettingsNav current={current} />
      <Outlet />
    </PageContainer>
  );
}
