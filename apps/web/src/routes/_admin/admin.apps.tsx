// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { AdminAppsPage } from "../../components/developer/admin-apps.tsx";
import { adminAppsClient } from "../../components/developer/client.ts";
import { NotFoundState } from "../../components/money/not-found.tsx";
import { mayOpenAdminPage } from "../../components/safety/access.ts";
import { t } from "../../i18n/index.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";

/** Admins only (the `_admin` guard): every OAuth app, suspend and unsuspend (E9-console; ADR 0027 §4). */
export const Route = createFileRoute("/_admin/admin/apps")({ component: AdminAppsRoute });

function AdminAppsRoute(): React.JSX.Element {
  const { me } = useBootstrap();
  const client = React.useMemo(() => adminAppsClient(), []);
  // Client fallback for the layout guard.
  if (!mayOpenAdminPage("apps", me)) return <NotFoundState />;
  return (
    <PageContainer className="flex flex-col gap-6 py-8">
      <PageHeader title={t("developer.admin.title")} description={t("developer.admin.intro")} />
      <AdminAppsPage client={client} />
    </PageContainer>
  );
}
