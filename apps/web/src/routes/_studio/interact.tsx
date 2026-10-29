// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { InteractStudio } from "../../components/interact-studio/interact-studio.tsx";
import { ownChannel } from "../../components/interact-studio/studio-access.tsx";
import { t } from "../../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { channelSearch } from "../../lib/interact-studio.ts";

/** Studio: polls, predictions, raids (and the raid policy) and goals (E8-studio). `?channel=` opens a channel the member moderates or edits. */
export const Route = createFileRoute("/_studio/interact")({
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  validateSearch: channelSearch,
  component: InteractPage,
});

function InteractPage(): React.JSX.Element {
  const { me, config } = useBootstrap();
  const search = Route.useSearch();
  if (!me) return <Navigate to="/signin" replace />;
  const own = ownChannel(me);
  const channel = search.channel ?? own;
  return (
    <PageContainer width="wide" data-testid="interact" className="flex flex-col gap-6 py-8">
      <PageHeader
        title={t("interact.pageTitle")}
        description={channel === own ? t("interact.pageIntro") : t("interact.pageIntroOther", { channel })}
      />
      <InteractStudio key={channel} me={me} channel={channel} currency={config.currency} />
    </PageContainer>
  );
}
