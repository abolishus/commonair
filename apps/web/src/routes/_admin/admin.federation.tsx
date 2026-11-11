// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { AdminPage } from "@commonair/ui/layouts";
import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { FederationAdminPage } from "../../components/federation/blocks.tsx";
import { NotFoundState } from "../../components/money/not-found.tsx";
import { mayOpenAdminPage } from "../../components/safety/access.ts";
import { t } from "../../i18n/index.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { titleHead } from "../../lib/page-title.ts";

/**
 * `/admin/federation`: the instance's ActivityPub domain blocks and key rotation (ADR 0030),
 * admins only (the `_admin` guard). While the instance does not federate it explains how to turn
 * federation on.
 */
export const Route = createFileRoute("/_admin/admin/federation")({
  head: () => titleHead(t("pageTitle.adminFederation")),
  component: FederationRoute,
});

function FederationRoute(): React.JSX.Element {
  const { me, instance } = useBootstrap();
  // Client fallback for the layout guard.
  if (!mayOpenAdminPage("federation", me)) return <NotFoundState />;
  return (
    <AdminPage width="form">
      <PageHeader title={t("federation.admin.title")} description={t("federation.admin.intro")} />
      <FederationAdminPage instanceEnabled={instance.federation === true} />
    </AdminPage>
  );
}
