// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { AdminPage } from "@commonair/ui/layouts";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { consoleClient } from "../../components/admin/console-client.ts";
import { AdminHome } from "../../components/admin/overview.tsx";
import { t } from "../../i18n/index.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { titleHead } from "../../lib/page-title.ts";

/**
 * The admin home (overhaul wave 4, D7.5): every staff role (the `_admin` guard answered everyone
 * else with not-found) sees its own queues' counts; admins also see the latest staff actions.
 */
export const Route = createFileRoute("/_admin/admin/")({
  head: () => titleHead(t("d7Admin.home.title")),
  component: AdminHomeRoute,
});

function AdminHomeRoute(): React.JSX.Element {
  const { me } = useBootstrap();
  const client = React.useMemo(() => consoleClient(), []);
  return (
    <AdminPage width="queue">
      <PageHeader title={t("d7Admin.home.title")} description={t("d7Admin.home.intro")} />
      <AdminHome client={client} me={me} />
    </AdminPage>
  );
}
