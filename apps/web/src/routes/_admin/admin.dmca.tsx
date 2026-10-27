// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { DmcaQueue } from "../../components/dmca/dmca-queue.tsx";
import { t } from "../../i18n/index.ts";

/** Platform moderators (the `_admin` guard answers everyone else with not-found): the DMCA queue (E7-dmca). */
export const Route = createFileRoute("/_admin/admin/dmca")({ component: DmcaQueuePage });

function DmcaQueuePage(): React.JSX.Element {
  return (
    <PageContainer className="flex flex-col gap-6 py-8">
      <PageHeader title={t("dmcaq.title")} description={t("dmcaq.intro")} />
      <DmcaQueue />
    </PageContainer>
  );
}
