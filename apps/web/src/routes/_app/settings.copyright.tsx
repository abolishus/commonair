// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { MyCopyright } from "../../components/dmca/copyright.tsx";
import { t } from "../../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";

/** Signed in: copyright notices about your content and the counter-notice (E7-dmca). */
export const Route = createFileRoute("/_app/settings/copyright")({
  beforeLoad: () => requireSession(() => getSessionUser()),
  // `?notice=<id>` (the link in the `dmcaNoticeReceived` mail) scrolls to that notice.
  validateSearch: (search: Record<string, unknown>): { notice?: string } =>
    typeof search.notice === "string" && /^[0-9a-f-]{36}$/i.test(search.notice) ? { notice: search.notice } : {},
  component: CopyrightPage,
});

function CopyrightPage(): React.JSX.Element {
  const { me } = useBootstrap();
  const { notice } = Route.useSearch();
  if (!me) return <Navigate to="/signin" replace />;
  return (
    <PageContainer className="flex flex-col gap-6 py-8">
      <PageHeader title={t("copyright.title")} description={t("copyright.intro")} />
      <MyCopyright focusNoticeId={notice} />
    </PageContainer>
  );
}
