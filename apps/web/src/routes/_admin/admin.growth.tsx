// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { GrowthPage } from "../../components/admin/growth.tsx";
import { NotFoundState } from "../../components/money/not-found.tsx";
import { t } from "../../i18n/index.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { isAdmin } from "../../lib/coop.ts";
import { titleHead } from "../../lib/page-title.ts";

/** Admins only (the `_admin` guard; the API checks again): growth funnels and UI counters, aggregates only. */
export const Route = createFileRoute("/_admin/admin/growth")({
  head: () => titleHead(t("d2Metrics.pageTitle")),
  component: GrowthRoute,
});

function GrowthRoute(): React.JSX.Element {
  const { me } = useBootstrap();
  // Client fallback for the layout guard.
  if (!isAdmin(me)) return <NotFoundState />;
  return (
    <PageContainer width="wide" data-testid="admin-growth" className="flex flex-col gap-6 py-8">
      <PageHeader title={t("d2Metrics.title")} description={t("d2Metrics.intro")} />
      <GrowthPage />
    </PageContainer>
  );
}
