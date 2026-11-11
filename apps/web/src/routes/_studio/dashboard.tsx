// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { PageContainer } from "@commonair/ui/layouts";
import { Link, Navigate, createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { StreamRecap } from "../../components/recap/stream-recap.tsx";
import { DashboardLabelNotices } from "../../components/safety/appeals.tsx";
import { GoLiveChecklist } from "../../components/setup-checklist/checklist.tsx";
import { parseDashboardSearch } from "../../components/setup-checklist/model.ts";
import { ControlRoom } from "../../components/studio/control-room.tsx";
import { focusStreamInfoTitle } from "../../components/studio/stream-info.tsx";
import { t } from "../../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { titleHead } from "../../lib/page-title.ts";

/**
 * `/dashboard`, the stream manager (F21): a control room, not a settings page. Above the board, from
 * the same channel poll: the stream recap after a broadcast and the "Ready to go live" checklist
 * until setup is done (overhaul wave 3, D5.1 and D5.3; `?intent=stream|import` opens the right
 * step). The board puts the live numbers and the title editor first (D5.2). A board: `wide` (F26).
 * "View channel" is the one place the sidebar does not go. The sticky LiveStatusBar belongs to the
 * studio shell, not this page.
 */
export const Route = createFileRoute("/_studio/dashboard")({
  validateSearch: parseDashboardSearch,
  head: () => titleHead(t("pageTitle.studioDashboard")),
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: DashboardPage,
});

function DashboardPage(): React.JSX.Element {
  const { me, config } = useBootstrap();
  const { intent } = Route.useSearch();
  const [infoSaves, setInfoSaves] = React.useState(0);
  if (!me) return <Navigate to="/signin" replace />;
  const slug = me.channelSlug ?? me.username;
  return (
    <PageContainer width="wide" data-testid="dashboard-page" className="flex flex-col gap-6 py-8">
      <PageHeader
        title={t("studio.manager.title")}
        description={t("studio.manager.intro")}
        actions={
          <Button
            data-testid="channel-link"
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link to="/$channel" params={{ channel: slug }} />}
          >
            {t("dashboard.viewChannel")}
          </Button>
        }
      />
      <DashboardLabelNotices />
      <ControlRoom
        key={slug}
        slug={slug}
        username={me.username}
        onInfoSaved={() => setInfoSaves((n) => n + 1)}
        renderTop={(channel) => (
          <>
            {channel ? (
              <StreamRecap
                channel={slug}
                publicUrl={config.publicUrl}
                live={channel.live !== null}
                lastLiveAt={channel.lastLiveAt ?? null}
                vodEnabled={channel.vodEnabled ?? false}
                member={channel.ownerCoop?.member ?? false}
              />
            ) : null}
            <GoLiveChecklist
              channel={slug}
              publicUrl={config.publicUrl}
              intent={intent}
              // A save elsewhere on the page, or the stream starting, can tick a step.
              refreshKey={`${infoSaves}|${channel?.live?.startedAt ?? ""}`}
              onEditInfo={() => void focusStreamInfoTitle()}
            />
          </>
        )}
      />
    </PageContainer>
  );
}
