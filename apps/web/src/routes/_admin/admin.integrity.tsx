// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { IntegrityPage } from "../../components/admin/integrity.tsx";
import { NotFoundState } from "../../components/money/not-found.tsx";
import { mayOpenAdminPage } from "../../components/safety/access.ts";
import { t } from "../../i18n/index.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";

/** Admins only (the `_admin` guard): integrity flags, filtered, each decidable in place. */
export const Route = createFileRoute("/_admin/admin/integrity")({ component: IntegrityRoute });

function IntegrityRoute(): React.JSX.Element {
  const { me } = useBootstrap();
  // Client fallback for the layout guard.
  if (!mayOpenAdminPage("integrity", me)) return <NotFoundState />;
  return (
    <PageContainer className="flex flex-col gap-6 py-8">
      <PageHeader title={t("admin.integrity.title")} description={t("admin.integrity.intro")} />
      <IntegrityPage />
    </PageContainer>
  );
}
