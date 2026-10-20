// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { StudioShell, type NavItem } from "@commonair/ui/layouts";
import { DashboardSquare01Icon, Money03Icon, ServerStack01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, Outlet, createFileRoute, useLocation } from "@tanstack/react-router";
import type * as React from "react";
import { AppFooter, AppHeader } from "../components/site-chrome.tsx";
import { t } from "../i18n/index.ts";
import { studioNav, type StudioEntry } from "../lib/nav.ts";

/** Creator tools (stream manager, revenue, relays) in the studio sidebar. Each page guards its own session. */
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
  }
}

function StudioLayout(): React.JSX.Element {
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <StudioShell
      header={<AppHeader studio />}
      groups={[{ id: "studio", items: studioNav(pathname).map(studioItem) }]}
      sidebarLabel={t("studio.nav")}
      skipLabel={t("nav.skipToContent")}
      footer={<AppFooter />}
    >
      <Outlet />
    </StudioShell>
  );
}
