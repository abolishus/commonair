// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { ownChannel } from "../../components/interact-studio/studio-access.tsx";
import { MovePage } from "../../components/portability/move-page.tsx";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { t } from "../../i18n/index.ts";
import { titleHead } from "../../lib/page-title.ts";

/**
 * `/move`: channel portability (ADR 0037): move links and their conversions, "moved to", and the
 * bundle export and import, for the signed-in member's own channel.
 */
export const Route = createFileRoute("/_studio/move")({
  head: () => titleHead(t("pageTitle.studioMove")),
  // Server-side guard (SSR and client navigation).
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: MoveRoute,
});

function MoveRoute(): React.JSX.Element {
  const { me } = useBootstrap();
  if (!me) return <Navigate to="/signin" replace />;
  const channel = ownChannel(me);
  return (
    <PageContainer className="flex flex-col gap-6 py-8">
      <PageHeader title={t("portability.pageTitle")} description={t("portability.pageIntro")} />
      <MovePage key={channel} channel={channel} />
    </PageContainer>
  );
}
