// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { BotStudio } from "../../components/bot-studio/bot-studio.tsx";
import { ownChannel } from "../../components/interact-studio/studio-access.tsx";
import { t } from "../../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { channelSearch } from "../../lib/interact-studio.ts";

/** Studio: the channel bot (settings, filters, points, song requests, commands, timers and variables) (E8-studio). `?channel=` opens a channel the member moderates or edits. */
export const Route = createFileRoute("/_studio/bot")({
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  validateSearch: channelSearch,
  component: BotPage,
});

function BotPage(): React.JSX.Element {
  const { me } = useBootstrap();
  const search = Route.useSearch();
  if (!me) return <Navigate to="/signin" replace />;
  const own = ownChannel(me);
  const channel = search.channel ?? own;
  return (
    <PageContainer width="wide" data-testid="bot" className="flex flex-col gap-6 py-8">
      <PageHeader
        title={t("bot.pageTitle")}
        description={channel === own ? t("bot.pageIntro") : t("bot.pageIntroOther", { channel })}
      />
      <BotStudio key={channel} me={me} channel={channel} />
    </PageContainer>
  );
}
