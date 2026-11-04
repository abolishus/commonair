// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { PageContainer } from "@commonair/ui/layouts";
import { Link, Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { DashboardLabelNotices } from "../../components/safety/appeals.tsx";
import { ControlRoom } from "../../components/studio/control-room.tsx";
import { t } from "../../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { titleHead } from "../../lib/page-title.ts";

/**
 * `/dashboard`, the stream manager (F21): a control room, not a settings page. The preview plays
 * muted (the player autoplays muted), chat has its moderation actions, and the setup cards live on
 * `/dashboard/settings`. A board: `wide` (F26). Header actions that repeat the sidebar are gone;
 * "View channel" is the one place the sidebar does not go.
 */
export const Route = createFileRoute("/_studio/dashboard")({
  head: () => titleHead(t("pageTitle.studioDashboard")),
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: DashboardPage,
});

function DashboardPage(): React.JSX.Element {
  const { me } = useBootstrap();
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
      <ControlRoom key={slug} slug={slug} username={me.username} />
    </PageContainer>
  );
}
