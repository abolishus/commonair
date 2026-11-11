// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { NotificationSettings } from "../../components/notifications/settings.tsx";
import { PortabilityGrants } from "../../components/portability/grants.tsx";
import { t } from "../../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { titleHead } from "../../lib/page-title.ts";

/** Signed in: the notifications grid, browser push and per-channel go-live choices (ADR 0028, D7.3). */
export const Route = createFileRoute("/_app/settings/notifications/")({
  head: () => titleHead(t("d7Settings.nav.notifications")),
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: NotificationSettingsPage,
});

function NotificationSettingsPage(): React.JSX.Element {
  const { me } = useBootstrap();
  if (!me) return <Navigate to="/signin" replace />;
  return (
    <div data-testid="notifications-page" className="flex min-w-0 flex-col gap-6">
      <PageHeader title={t("d7Settings.nav.notifications")} description={t("d7Notify.intro")} />
      <NotificationSettings />
      {/* F37: moved here from privacy; it is a per-channel notice, like the go-live ones above. */}
      <PortabilityGrants />
    </div>
  );
}
