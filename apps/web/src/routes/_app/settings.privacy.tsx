// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader, Section } from "@commonair/ui/blocks/headers";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { BlockedUsers } from "../../components/blocks/blocked-users.tsx";
import { DeletionSection, ExportSection } from "../../components/privacy-panels.tsx";
import { t } from "../../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { titleHead } from "../../lib/page-title.ts";
import { P2PSettingsSection } from "../../player/p2p/p2p-ui.tsx";

export const Route = createFileRoute("/_app/settings/privacy")({
  head: () => titleHead(t("pageTitle.settingsPrivacy")),
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: PrivacyPage,
});

function PrivacyPage(): React.JSX.Element {
  const { me } = useBootstrap();
  if (!me) return <Navigate to="/signin" replace />;
  return (
    <div data-testid="privacy-page" className="flex flex-col gap-6">
      <PageHeader title={t("privacy.title")} description={t("privacy.intro")} />
      {/*
        F37: downloading and deleting are what the page title promises, so they come first, in a
        section of their own. The per-channel move notices live on Notifications now.
      */}
      <Section
        data-testid="privacy-account"
        heading={t("settings.privacy.accountTitle")}
        description={t("settings.privacy.accountIntro")}
        className="flex flex-col gap-4 space-y-0"
      >
        <div className="grid min-w-0 gap-4 lg:grid-cols-2 lg:items-start">
          <ExportSection hasChannel={me.channelSlug !== null} />
          <DeletionSection username={me.username} />
        </div>
      </Section>
      <P2PSettingsSection />
      <BlockedUsers />
    </div>
  );
}
