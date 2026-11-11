// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { AdminPage } from "@commonair/ui/layouts";
import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { IncidentsPage } from "../../components/admin/incidents.tsx";
import { NotFoundState } from "../../components/money/not-found.tsx";
import { mayOpenAdminPage } from "../../components/safety/access.ts";
import { t } from "../../i18n/index.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { titleHead } from "../../lib/page-title.ts";

/** Admins only (the `_admin` guard): open and update status-page incidents. */
export const Route = createFileRoute("/_admin/admin/incidents")({
  head: () => titleHead(t("pageTitle.adminIncidents")),
  component: IncidentsRoute,
});

function IncidentsRoute(): React.JSX.Element {
  const { me } = useBootstrap();
  // Client fallback for the layout guard.
  if (!mayOpenAdminPage("incidents", me)) return <NotFoundState />;
  return (
    <AdminPage width="queue">
      <PageHeader title={t("admin.incidents.title")} description={t("admin.incidents.intro")} />
      <IncidentsPage />
    </AdminPage>
  );
}
