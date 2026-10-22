// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { DeletionSection, ExportSection } from "../../components/privacy-panels.tsx";
import { t } from "../../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";

export const Route = createFileRoute("/_app/settings/privacy")({
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: PrivacyPage,
});

function PrivacyPage(): React.JSX.Element {
  const { me } = useBootstrap();
  if (!me) return <Navigate to="/signin" replace />;
  return (
    <PageContainer width="narrow" data-testid="privacy-page" className="flex flex-col gap-6 py-8">
      <PageHeader title={t("privacy.title")} description={t("privacy.intro")} />
      <ExportSection hasChannel={me.channelSlug !== null} />
      <DeletionSection username={me.username} />
    </PageContainer>
  );
}
