// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PageHeader } from "@commonair/ui/blocks/headers";
import { PageContainer } from "@commonair/ui/layouts";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { ChatGateStudio } from "../../components/chat-gate/chat-gate-settings.tsx";
import { NotFoundState } from "../../components/money/not-found.tsx";
import { t } from "../../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../../lib/bootstrap.ts";
import { requireSession } from "../../lib/guard.ts";

/** `/chat`: the verified-watch gate and surge-guard settings (ADR 0015), shown while the instance runs either. */
export const Route = createFileRoute("/_studio/chat")({
  // Server-side guard (SSR and client navigation); the component keeps a client fallback.
  beforeLoad: () => requireSession(() => getSessionUser()),
  component: ChatSafetyPage,
});

function ChatSafetyPage(): React.JSX.Element {
  const { me, instance } = useBootstrap();
  if (!me) return <Navigate to="/signin" replace />;
  // The studio nav hides the page while the instance runs neither feature (docs/testing/w1-selectors.md).
  if (!instance.chatSafety) return <NotFoundState />;
  const channel = me.channelSlug ?? me.username;
  return (
    <PageContainer width="wide" data-testid="chat-gate-page" className="flex flex-col gap-6 py-8">
      <PageHeader title={t("chatGate.pageTitle")} description={t("chatGate.pageIntro")} />
      <ChatGateStudio key={channel} channel={channel} />
    </PageContainer>
  );
}
