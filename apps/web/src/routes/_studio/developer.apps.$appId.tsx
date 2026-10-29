// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { DeveloperAppPage } from "../../components/developer/app-page.tsx";
import { developerClient } from "../../components/developer/client.ts";
import { t } from "../../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";

/** Studio: one OAuth app, its credentials, subscriptions and deliveries (E9-console). */
export const Route = createFileRoute("/_studio/developer/apps/$appId")({
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: DeveloperAppRoute,
});

function DeveloperAppRoute(): React.JSX.Element {
  const { me } = useBootstrap();
  const { appId } = Route.useParams();
  const navigate = useNavigate();
  const client = React.useMemo(() => developerClient(), []);
  if (!me) return <Navigate to="/signin" replace />;
  return (
    <PageContainer className="flex flex-col gap-6 py-8">
      <PageHeader title={t("developer.app.pageTitle")} description={t("developer.app.pageIntro")} />
      <DeveloperAppPage
        key={appId}
        appId={appId}
        client={client}
        onDeleted={() => void navigate({ to: "/developer" })}
      />
    </PageContainer>
  );
}
