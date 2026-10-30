// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { StudioShell, type NavItem } from "@commonair/ui/layouts";
import {
  BotIcon,
  BubbleChatSecureIcon,
  ChartBarLineIcon,
  DashboardSquare01Icon,
  Money03Icon,
  Notification03Icon,
  ServerStack01Icon,
  SourceCodeIcon,
  Video01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, Outlet, createFileRoute, useLocation } from "@tanstack/react-router";
import type * as React from "react";
import { AppFooter, AppHeader } from "../components/site-chrome.tsx";
import { t } from "../i18n/index.ts";
import { useBootstrap } from "../lib/bootstrap.ts";
import { studioNav, type StudioEntry } from "../lib/nav.ts";

/** Creator tools (stream manager, overlays, polls and raids, channel bot, chat safety, content, revenue, relays, developer) in the studio sidebar. Each page guards its own session. */
export const Route = createFileRoute("/_studio")({ component: StudioLayout });

function studioItem(entry: StudioEntry): NavItem {
  const base = { id: entry.id, current: entry.current };
  switch (entry.id) {
    case "streamManager":
      return {
        ...base,
        label: t("studio.streamManager"),
        icon: <HugeiconsIcon icon={DashboardSquare01Icon} strokeWidth={2} aria-hidden />,
        render: <Link to="/dashboard" />,
      };
    case "overlays":
      return {
        ...base,
        label: t("studio.overlays"),
        icon: <HugeiconsIcon icon={Notification03Icon} strokeWidth={2} aria-hidden />,
        render: <Link data-testid="studio-overlays-link" to="/overlays" />,
      };
    case "interact":
      return {
        ...base,
        label: t("studio.interact"),
        icon: <HugeiconsIcon icon={ChartBarLineIcon} strokeWidth={2} aria-hidden />,
        render: <Link data-testid="studio-interact-link" to="/interact" />,
      };
    case "bot":
      return {
        ...base,
        label: t("studio.bot"),
        icon: <HugeiconsIcon icon={BotIcon} strokeWidth={2} aria-hidden />,
        render: <Link data-testid="studio-bot-link" to="/bot" />,
      };
    case "chat":
      return {
        ...base,
        label: t("studio.chat"),
        icon: <HugeiconsIcon icon={BubbleChatSecureIcon} strokeWidth={2} aria-hidden />,
        render: <Link data-testid="studio-chat-link" to="/chat" />,
      };
    case "content":
      return {
        ...base,
        label: t("studio.content"),
        icon: <HugeiconsIcon icon={Video01Icon} strokeWidth={2} aria-hidden />,
        render: <Link data-testid="studio-content-link" to="/content" />,
      };
    case "revenue":
      return {
        ...base,
        label: t("studio.revenue"),
        icon: <HugeiconsIcon icon={Money03Icon} strokeWidth={2} aria-hidden />,
        render: <Link data-testid="revenue-link" to="/revenue" />,
      };
    case "relays":
      return {
        ...base,
        label: t("studio.relays"),
        icon: <HugeiconsIcon icon={ServerStack01Icon} strokeWidth={2} aria-hidden />,
        render: <Link to="/relays" />,
      };
    case "developer":
      return {
        ...base,
        label: t("studio.developer"),
        icon: <HugeiconsIcon icon={SourceCodeIcon} strokeWidth={2} aria-hidden />,
        render: <Link data-testid="studio-developer-link" to="/developer" />,
      };
  }
}

function StudioLayout(): React.JSX.Element {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { instance } = useBootstrap();
  return (
    <StudioShell
      header={<AppHeader studio />}
      groups={[{ id: "studio", items: studioNav(pathname, { chatSafety: instance.chatSafety }).map(studioItem) }]}
      sidebarLabel={t("studio.nav")}
      skipLabel={t("nav.skipToContent")}
      footer={<AppFooter />}
    >
      <Outlet />
    </StudioShell>
  );
}
