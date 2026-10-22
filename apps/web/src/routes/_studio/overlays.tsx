// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { OverlaysStudio } from "../../components/overlays-studio.tsx";
import { t } from "../../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";

export const Route = createFileRoute("/_studio/overlays")({
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: OverlaysPage,
});

function OverlaysPage(): React.JSX.Element {
  const { me, config } = useBootstrap();
  if (!me) return <Navigate to="/signin" replace />;
  const channel = me.channelSlug ?? me.username;
  return (
    <PageContainer width="wide" data-testid="overlays-page" className="flex flex-col gap-6 py-8">
      <PageHeader title={t("overlays.title")} description={t("overlays.intro")} />
      <OverlaysStudio key={channel} channel={channel} currency={config.currency} />
    </PageContainer>
  );
}
