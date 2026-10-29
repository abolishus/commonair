// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { DeveloperBotsPage } from "../../components/developer/bots-page.tsx";
import { developerClient } from "../../components/developer/client.ts";
import { t } from "../../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";

/** Studio: bot accounts you own and their tokens; tokens authorized on your account (E9-console). */
export const Route = createFileRoute("/_studio/developer/bots")({
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: DeveloperBotsRoute,
});

function DeveloperBotsRoute(): React.JSX.Element {
  const { me } = useBootstrap();
  const client = React.useMemo(() => developerClient(), []);
  if (!me) return <Navigate to="/signin" replace />;
  return (
    <PageContainer className="flex flex-col gap-6 py-8">
      <PageHeader title={t("developer.bots.pageTitle")} description={t("developer.bots.pageIntro")} />
      <DeveloperBotsPage client={client} />
    </PageContainer>
  );
}
