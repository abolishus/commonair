// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { ownChannel } from "../../components/interact-studio/studio-access.tsx";
import { ScheduleEditor } from "../../components/schedule/schedule-editor.tsx";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { t } from "../../i18n/index.ts";
import { titleHead } from "../../lib/page-title.ts";

/**
 * `/schedule` (overhaul wave 5): the signed-in member's own channel schedule: weekly streams in
 * the channel's time zone, one-off streams, and skipping one occurrence.
 */
export const Route = createFileRoute("/_studio/schedule")({
  head: () => titleHead(t("w5Schedule.pageTitle")),
  // Server-side guard (SSR and client navigation).
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: ScheduleRoute,
});

function ScheduleRoute(): React.JSX.Element {
  const { me } = useBootstrap();
  if (!me) return <Navigate to="/signin" replace />;
  const channel = ownChannel(me);
  return (
    <PageContainer className="flex flex-col gap-6 py-8">
      <PageHeader title={t("w5Schedule.pageTitle")} description={t("w5Schedule.pageIntro")} />
      <ScheduleEditor key={channel} channel={channel} />
    </PageContainer>
  );
}
