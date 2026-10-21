// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { MyAppeals } from "../../components/safety/appeals.tsx";
import { t } from "../../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";

export const Route = createFileRoute("/_app/settings/appeals")({
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: AppealsPage,
});

function AppealsPage(): React.JSX.Element {
  const { me } = useBootstrap();
  if (!me) return <Navigate to="/signin" replace />;
  return (
    <PageContainer data-testid="appeals" className="flex flex-col gap-6 py-8">
      <PageHeader title={t("safety.appeals.title")} description={t("safety.appeals.intro")} />
      <MyAppeals />
    </PageContainer>
  );
}
