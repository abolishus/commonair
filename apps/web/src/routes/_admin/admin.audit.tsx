// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { AdminPage } from "@commonair/ui/layouts";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { AuditLog } from "../../components/admin/audit-log.tsx";
import { consoleClient } from "../../components/admin/console-client.ts";
import { t } from "../../i18n/index.ts";
import { titleHead } from "../../lib/page-title.ts";

/** Admins only (the `_admin` guard; `safety.auditLog` is the admin role's): every staff action (D7.5). */
export const Route = createFileRoute("/_admin/admin/audit")({
  head: () => titleHead(t("d7Admin.audit.title")),
  component: AdminAuditRoute,
});

function AdminAuditRoute(): React.JSX.Element {
  const client = React.useMemo(() => consoleClient(), []);
  return (
    <AdminPage width="queue">
      <PageHeader title={t("d7Admin.audit.title")} description={t("d7Admin.audit.intro")} />
      <AuditLog client={client} />
    </AdminPage>
  );
}
