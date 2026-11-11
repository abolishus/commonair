// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { AdminPage } from "@commonair/ui/layouts";
import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { AppealQueue } from "../../components/safety/appeal-queue.tsx";
import { t } from "../../i18n/index.ts";
import { titleHead } from "../../lib/page-title.ts";

/** Platform moderators and admins: the `_admin` layout's guard answered everyone else with not-found. */
export const Route = createFileRoute("/_admin/admin/appeals")({
  head: () => titleHead(t("pageTitle.adminAppeals")),
  component: AppealsQueuePage,
});

function AppealsQueuePage(): React.JSX.Element {
  return (
    <AdminPage width="queue">
      <PageHeader title={t("safety.appealq.title")} description={t("appeals.account.queueIntro")} />
      <AppealQueue />
    </AdminPage>
  );
}
