// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { Connections } from "../../components/oauth/connections.tsx";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { titleHead } from "../../lib/page-title.ts";

/** Settings: apps you authorized, their scopes, revoke (E9-consent). */
export const Route = createFileRoute("/_app/settings/connections")({
  beforeLoad: () => requireSession(() => getSessionUser()),
  head: () => titleHead(t("d7Settings.nav.connections")),
  component: ConnectionsPage,
});

function ConnectionsPage(): React.JSX.Element {
  const { me } = useBootstrap();
  const client = React.useMemo(() => api().developer, []);
  // Client fallback for a session that ended after the guard ran.
  if (!me) return <Navigate to="/signin" replace />;
  return (
    <div data-testid="connections-page" className="flex flex-col gap-6">
      {/* D7.1: the h1 is the nav label. */}
      <PageHeader title={t("d7Settings.nav.connections")} description={t("d7Settings.connections.intro")} />
      <Connections client={client} />
    </div>
  );
}
