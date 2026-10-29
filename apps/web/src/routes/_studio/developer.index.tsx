// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { PageContainer } from "@commonair/ui/layouts";
import { RoboticIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, Navigate, createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { DeveloperAppsPage } from "../../components/developer/apps-page.tsx";
import { developerClient } from "../../components/developer/client.ts";
import { t } from "../../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";

/** Studio: your OAuth apps, register one (E9-console). */
export const Route = createFileRoute("/_studio/developer/")({
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: DeveloperRoute,
});

function DeveloperRoute(): React.JSX.Element {
  const { me } = useBootstrap();
  const client = React.useMemo(() => developerClient(), []);
  if (!me) return <Navigate to="/signin" replace />;
  return (
    <PageContainer className="flex flex-col gap-6 py-8">
      <PageHeader
        title={t("developer.pageTitle")}
        description={t("developer.pageIntro")}
        actions={
          <Button variant="outline" size="sm" render={<Link to="/developer/bots" />} nativeButton={false}>
            <HugeiconsIcon icon={RoboticIcon} strokeWidth={2} aria-hidden data-icon="inline-start" />
            {t("developer.bots.link")}
          </Button>
        }
      />
      <DeveloperAppsPage client={client} />
    </PageContainer>
  );
}
