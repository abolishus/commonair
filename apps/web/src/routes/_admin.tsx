// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AppShell, AdminShell, type NavItem } from "@commonair/ui/layouts";
import { BankIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, Outlet, createFileRoute, notFound, useLocation } from "@tanstack/react-router";
import type * as React from "react";
import { NotFoundState } from "../components/money/not-found.tsx";
import { AppFooter, AppHeader } from "../components/site-chrome.tsx";
import { t } from "../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../lib/bootstrap.ts";
import { isTreasurer } from "../lib/money.ts";

/**
 * Platform tools (today: the treasury, for treasurers only). Anyone else, signed out included,
 * gets the not-found page, decided in `beforeLoad` (on the server during SSR) so neither the
 * tools nor their sidebar ever render for them.
 */
export const Route = createFileRoute("/_admin")({
  beforeLoad: async () => {
    const me = await getSessionUser();
    if (!isTreasurer(me)) throw notFound();
    return { me };
  },
  component: AdminLayout,
  notFoundComponent: AdminNotFound,
});

function AdminLayout(): React.JSX.Element {
  const { me } = useBootstrap();
  const pathname = useLocation({ select: (location) => location.pathname });
  // Client fallback for a session that changed after the guard ran.
  if (!isTreasurer(me)) return <AdminNotFound />;
  const treasury: NavItem = {
    id: "treasury",
    label: t("nav.treasury"),
    current: pathname.replace(/\/+$/, "") === "/treasury",
    icon: <HugeiconsIcon icon={BankIcon} strokeWidth={2} aria-hidden />,
    render: <Link to="/treasury" />,
  };
  return (
    <AdminShell
      header={<AppHeader studio />}
      groups={[{ id: "admin", items: [treasury] }]}
      sidebarLabel={t("admin.nav")}
      skipLabel={t("nav.skipToContent")}
      footer={<AppFooter />}
    >
      <Outlet />
    </AdminShell>
  );
}

function AdminNotFound(): React.JSX.Element {
  return (
    <AppShell header={<AppHeader />} footer={<AppFooter />} skipLabel={t("nav.skipToContent")}>
      <NotFoundState />
    </AppShell>
  );
}
