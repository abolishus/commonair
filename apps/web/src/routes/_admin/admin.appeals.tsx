// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { AppealQueue } from "../../components/safety/appeal-queue.tsx";
import { t } from "../../i18n/index.ts";

/** Platform moderators and admins: the `_admin` layout's guard answered everyone else with not-found. */
export const Route = createFileRoute("/_admin/admin/appeals")({ component: AppealsQueuePage });

function AppealsQueuePage(): React.JSX.Element {
  return (
    <PageContainer className="flex flex-col gap-6 py-8">
      <PageHeader title={t("safety.appealq.title")} description={t("safety.appealq.intro")} />
      <AppealQueue />
    </PageContainer>
  );
}
