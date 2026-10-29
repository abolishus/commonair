// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Navigate, createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { Connections } from "../../components/oauth/connections.tsx";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";

/** Settings: apps you authorized, their scopes, revoke (E9-consent). */
export const Route = createFileRoute("/_app/settings/connections")({
  beforeLoad: () => requireSession(() => getSessionUser()),
  head: () => ({ meta: [{ title: t("oauth.connections.pageTitle") }] }),
  component: ConnectionsPage,
});

function ConnectionsPage(): React.JSX.Element {
  const { me } = useBootstrap();
  const client = React.useMemo(() => api().developer, []);
  // Client fallback for a session that ended after the guard ran.
  if (!me) return <Navigate to="/signin" replace />;
  return <Connections client={client} />;
}
