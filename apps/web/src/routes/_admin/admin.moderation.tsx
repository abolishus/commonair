// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { isPlatformModerator } from "../../components/safety/access.ts";
import { ModQueue } from "../../components/safety/mod-queue.tsx";
import { t } from "../../i18n/index.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";

/** Moderators, admins and `legal`: the `_admin` layout's guard answered everyone else with not-found. */
export const Route = createFileRoute("/_admin/admin/moderation")({ component: ModerationPage });

function ModerationPage(): React.JSX.Element {
  const { me } = useBootstrap();
  return (
    <PageContainer width="wide" className="flex flex-col gap-6 py-8">
      <PageHeader title={t("safety.modq.title")} description={t("safety.modq.intro")} />
      <ModQueue canReports={isPlatformModerator(me)} />
    </PageContainer>
  );
}
