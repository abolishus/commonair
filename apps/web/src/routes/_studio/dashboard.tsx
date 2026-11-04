// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Skeleton, SkeletonGroup } from "@commonair/ui";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { PageContainer } from "@commonair/ui/layouts";
import { Link, Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { ChatPanel } from "../../chat/chat-panel.tsx";
import { CHAT_COLUMN_CLASS } from "../../chat/layout.ts";
import { FormError } from "../../components/form-error.tsx";
import { useLoad } from "../../components/money/use-load.ts";
import { DashboardLabelNotices } from "../../components/safety/appeals.tsx";
import { StreamManager } from "../../components/studio/stream-manager.tsx";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { titleHead } from "../../lib/page-title.ts";
import { Player } from "../../player/player.tsx";

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

function ControlRoom({ slug, username }: { slug: string; username: string }): React.JSX.Element {
  // The live state for the preview and the uptime; polled by the health card, not here.
  const channel = useLoad(`dashboard:${slug}`, () => api().channels.get({ channel: slug }));
  const live = channel.data?.live ?? null;
  const preview = channel.data ? (
    <Player
      channel={slug}
      live={live !== null}
      offline={<p className="text-sm text-muted-foreground">{t("studio.preview.offline")}</p>}
    />
  ) : channel.failed ? (
    <FormError>{t("studio.preview.loadFailed")}</FormError>
  ) : (
    <SkeletonGroup label={t("studio.preview.loading")}>
      <Skeleton className="aspect-video w-full" />
    </SkeletonGroup>
  );
  return (
    <StreamManager
      channel={slug}
      startedAt={live?.startedAt ?? null}
      preview={preview}
      chat={
        <ChatPanel
          channel={slug}
          stream={channel.data ? { id: channel.data.id, live: live !== null, slug } : undefined}
          channelName={channel.data?.displayName}
          signedIn
          selfUsername={username}
          className={CHAT_COLUMN_CLASS}
        />
      }
    />
  );
}
