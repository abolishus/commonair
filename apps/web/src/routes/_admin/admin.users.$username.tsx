// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { AdminPage } from "@commonair/ui/layouts";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { consoleClient } from "../../components/admin/console-client.ts";
import { AdminUserPage } from "../../components/admin/user-view.tsx";
import { t } from "../../i18n/index.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { titleHead } from "../../lib/page-title.ts";

/**
 * A person's standing for staff (D7.5): moderators, admins and `legal` (the `_admin` guard). T0
 * cases and holds are only in `legal`'s view (the API leaves them out for everyone else).
 */
export const Route = createFileRoute("/_admin/admin/users/$username")({
  head: ({ params }) => titleHead(t("d7Admin.user.pageTitle", { username: params.username })),
  component: AdminUserRoute,
});

function AdminUserRoute(): React.JSX.Element {
  const { me } = useBootstrap();
  const { username } = Route.useParams();
  const client = React.useMemo(() => consoleClient(), []);
  return (
    <AdminPage width="queue">
      <PageHeader title={`@${username}`} description={t("d7Admin.user.intro")} />
      <AdminUserPage key={username} username={username} client={client} me={me} />
    </AdminPage>
  );
}
