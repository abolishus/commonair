// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { ownChannel } from "../../components/interact-studio/studio-access.tsx";
import { TwitchImportPage } from "../../components/twitch-import/import-page.tsx";
import { parseOutcome, type CallbackOutcome } from "../../components/twitch-import/lib.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { t } from "../../i18n/index.ts";
import { titleHead } from "../../lib/page-title.ts";

/**
 * `/import`: import a channel from Twitch (ADR 0031): connect, preview, choose, start, and the
 * panel paste-in helper; an unavailable state without the Twitch credentials or the flag. The
 * Twitch callback redirects here with `?twitch=<outcome>`.
 */
export const Route = createFileRoute("/_studio/import")({
  head: () => titleHead(t("pageTitle.studioImport")),
  // Server-side guard (SSR and client navigation).
  beforeLoad: () => requireSession(() => getSessionUser()),
  validateSearch: (search: Record<string, unknown>): { twitch?: CallbackOutcome } => {
    const twitch = parseOutcome(search.twitch);
    return twitch ? { twitch } : {};
  },
  component: ImportRoute,
});

function ImportRoute(): React.JSX.Element {
  const { me } = useBootstrap();
  const { twitch } = Route.useSearch();
  if (!me) return <Navigate to="/signin" replace />;
  const channel = ownChannel(me);
  return (
    <PageContainer className="flex flex-col gap-6 py-8">
      <PageHeader title={t("twitchImport.pageTitle")} description={t("twitchImport.pageIntro")} />
      <TwitchImportPage key={channel} channel={channel} outcome={twitch ?? null} />
    </PageContainer>
  );
}
