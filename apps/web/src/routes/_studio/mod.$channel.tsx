// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { ChatPanel } from "../../chat/chat-panel.tsx";
import { CHAT_COLUMN_CLASS } from "../../chat/layout.ts";
import { ModView } from "../../components/mod/mod-view.tsx";
import { t } from "../../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";
import { titleHead } from "../../lib/page-title.ts";

/**
 * `/mod/$channel` (F23): the mod view for the channel's broadcaster and moderators. The page guards
 * the session; whether the member may moderate the channel is the server's answer (`ModView`
 * asks for the held queue first and shows the not-found state when it is refused).
 */
export const Route = createFileRoute("/_studio/mod/$channel")({
  head: () => titleHead(t("pageTitle.studioModView")),
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: ModViewRoute,
});

function ModViewRoute(): React.JSX.Element {
  const { me } = useBootstrap();
  const { channel } = Route.useParams();
  if (!me) return <Navigate to="/signin" replace />;
  return (
    // A board (chat beside two panels): wide (F26).
    <PageContainer width="wide" className="flex flex-col gap-6 py-8">
      <ModView
        key={channel}
        channel={channel}
        header={<PageHeader title={t("studio.mod.title", { channel })} description={t("studio.mod.intro")} />}
        chat={<ChatPanel channel={channel} signedIn selfUsername={me.username} className={CHAT_COLUMN_CLASS} />}
      />
    </PageContainer>
  );
}
