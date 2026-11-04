// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { ChannelAppearanceCard } from "../../components/channel-appearance.tsx";
import { DiscordWebhookSection } from "../../components/discord-webhook-section.tsx";
import { DvrSettings } from "../../components/dvr-settings.tsx";
import { FederationSettings } from "../../components/federation/settings.tsx";
import { SimulcastSection } from "../../components/simulcast-section.tsx";
import { StreamSetup } from "../../components/studio/stream-setup.tsx";
import { t } from "../../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { titleHead } from "../../lib/page-title.ts";

/**
 * `/dashboard/settings`, "Stream settings" (F21): the setup cards that used to fill the stream
 * manager (the stream key, rewind and recording, simulcast, the Discord webhook, appearance and the
 * fediverse), so the stream manager can be a control room. A form page: `default` width (F26).
 */
export const Route = createFileRoute("/_studio/dashboard_/settings")({
  head: () => titleHead(t("pageTitle.studioStreamSettings")),
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: StreamSettingsPage,
});

function StreamSettingsPage(): React.JSX.Element {
  const { me } = useBootstrap();
  if (!me) return <Navigate to="/signin" replace />;
  const channel = me.channelSlug ?? me.username;
  return (
    <PageContainer data-testid="stream-settings-page" className="flex flex-col gap-6 py-8">
      <PageHeader title={t("studio.settings.title")} description={t("studio.settings.intro")} />
      {/* Forms stay readable: one column at most this wide, inside the default page width (F26). */}
      <div className="flex max-w-3xl flex-col gap-6">
        <StreamSetup channel={channel} />
        <DvrSettings key={`dvr:${channel}`} channel={channel} />
        <SimulcastSection key={`simulcast-${channel}`} channel={channel} />
        <DiscordWebhookSection key={`discord-${channel}`} channel={channel} />
        <ChannelAppearanceCard key={`appearance-${channel}`} channel={channel} />
        <FederationSettings key={`fed:${channel}`} channel={channel} />
      </div>
    </PageContainer>
  );
}
