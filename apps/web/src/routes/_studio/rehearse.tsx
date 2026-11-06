// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { ownChannel } from "../../components/interact-studio/studio-access.tsx";
import { RehearsalWatchView, RehearsePage } from "../../components/rehearsal/page.tsx";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { channelSearch } from "../../lib/interact-studio.ts";
import { t } from "../../i18n/index.ts";
import { titleHead } from "../../lib/page-title.ts";

/**
 * `/rehearse`: arm a private rehearsal, invite up to five followers, read the checklist and the
 * report (batch 6 decisions (f), (g)). `?channel=` of another channel is an invitee's watch view.
 */
export const Route = createFileRoute("/_studio/rehearse")({
  head: () => titleHead(t("pageTitle.studioRehearse")),
  // Server-side guard (SSR and client navigation): invitees watch signed in too.
  beforeLoad: () => requireSession(() => getSessionUser()),
  validateSearch: channelSearch,
  component: RehearseRoute,
});

function RehearseRoute(): React.JSX.Element {
  const { me } = useBootstrap();
  const search = Route.useSearch();
  if (!me) return <Navigate to="/signin" replace />;
  const own = ownChannel(me);
  const channel = search.channel ?? own;
  return (
    <PageContainer className="flex flex-col gap-6 py-8">
      {channel === own ? (
        <>
          <PageHeader title={t("rehearsal.pageTitle")} description={t("rehearsal.pageIntro")} />
          <RehearsePage key={channel} channel={channel} />
        </>
      ) : (
        <>
          <PageHeader title={t("rehearsal.watch.title")} description={t("rehearsal.watch.intro", { channel })} />
          <RehearsalWatchView key={channel} channel={channel} />
        </>
      )}
    </PageContainer>
  );
}
