// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { BlockedUsers } from "../../components/blocks/blocked-users.tsx";
import { ExportSection, useExports } from "../../components/privacy-panels.tsx";
import { DeleteAccountSection } from "../../components/settings/delete-account.tsx";
import { t } from "../../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { titleHead } from "../../lib/page-title.ts";

/**
 * Settings → Privacy & data (D7.4, account-admin.md P6), in lifecycle order: download your data,
 * who can see you, then the danger zone. Sharing bandwidth (P2P) moved to Preferences › Playback.
 */
export const Route = createFileRoute("/_app/settings/privacy")({
  head: () => titleHead(t("d7Settings.nav.privacy")),
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: PrivacyPage,
});

function PrivacyPage(): React.JSX.Element {
  const { me } = useBootstrap();
  if (!me) return <Navigate to="/signin" replace />;
  return <PrivacyData username={me.username} hasChannel={me.channelSlug !== null} />;
}

function PrivacyData({ username, hasChannel }: { username: string; hasChannel: boolean }): React.JSX.Element {
  // One export state for the page: the delete dialog's Download now shows in the section too.
  const exports = useExports();
  return (
    <div data-testid="privacy-page" className="flex flex-col gap-6">
      <PageHeader title={t("d7Settings.nav.privacy")} description={t("d7Settings.privacy.intro")} />
      <ExportSection hasChannel={hasChannel} state={exports} />
      <BlockedUsers />
      <DeleteAccountSection username={username} exports={exports} />
    </div>
  );
}
