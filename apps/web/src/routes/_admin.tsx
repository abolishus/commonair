// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AppShell, AdminShell, type NavItem } from "@commonair/ui/layouts";
import {
  BankIcon,
  JusticeScale01Icon,
  LegalDocument01Icon,
  Shield01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, Outlet, createFileRoute, useLocation } from "@tanstack/react-router";
import type * as React from "react";
import { NotFoundState } from "../components/money/not-found.tsx";
import {
  adminPageFor,
  isLegal,
  isPlatformModerator,
  isSafetyStaff,
  mayOpenAdminPage,
  requireAdminPage,
} from "../components/safety/access.ts";
import { AppFooter, AppHeader } from "../components/site-chrome.tsx";
import { t } from "../i18n/index.ts";
import { getSessionUser, useBootstrap } from "../lib/bootstrap.ts";
import { isTreasurer } from "../lib/money.ts";
import { isAdmin } from "../lib/coop.ts";
import { adminNav, type AdminEntry } from "../lib/nav.ts";

/**
 * Platform tools: the treasury (treasurers), the mod queue (moderators, admins, `legal`), the
 * appeals queue (moderators, admins), the legal queue (`legal` only) and co-op administration
 * (admins). Anyone without the page's
 * role, signed out included, gets the not-found page, decided in `beforeLoad` (on the server
 * during SSR) so neither the tools nor their sidebar ever render for them.
 */
export const Route = createFileRoute("/_admin")({
  beforeLoad: ({ location }) => requireAdminPage(location.pathname, () => getSessionUser()),
  component: AdminLayout,
  notFoundComponent: AdminNotFound,
});

function adminItem(entry: AdminEntry): NavItem {
  const icon = (glyph: typeof BankIcon) => <HugeiconsIcon icon={glyph} strokeWidth={2} aria-hidden />;
  switch (entry.id) {
    case "treasury":
      return {
        id: entry.id,
        label: t("nav.treasury"),
        current: entry.current,
        icon: icon(BankIcon),
        render: <Link to="/treasury" />,
      };
    case "moderation":
      return {
        id: entry.id,
        label: t("nav.moderation"),
        current: entry.current,
        icon: icon(Shield01Icon),
        render: <Link to="/admin/moderation" />,
      };
    case "appeals":
      return {
        id: entry.id,
        label: t("nav.appealQueue"),
        current: entry.current,
        icon: icon(JusticeScale01Icon),
        render: <Link to="/admin/appeals" />,
      };
    case "legal":
      return {
        id: entry.id,
        label: t("nav.legal"),
        current: entry.current,
        icon: icon(LegalDocument01Icon),
        render: <Link to="/admin/legal" />,
      };
    case "coop":
      return {
        id: entry.id,
        label: t("nav.adminCoop"),
        current: entry.current,
        icon: icon(UserGroupIcon),
        render: <Link to="/admin/coop" />,
      };
  }
}

function AdminLayout(): React.JSX.Element {
  const { me } = useBootstrap();
  const pathname = useLocation({ select: (location) => location.pathname });
  // Client fallback for a session that changed after the guard ran.
  if (!mayOpenAdminPage(adminPageFor(pathname), me)) return <AdminNotFound />;
  const items = adminNav(pathname, {
    treasurer: isTreasurer(me),
    safetyStaff: isSafetyStaff(me),
    platformModerator: isPlatformModerator(me),
    legal: isLegal(me),
    admin: isAdmin(me),
  }).map(adminItem);
  return (
    <AdminShell
      header={<AppHeader studio />}
      groups={[{ id: "admin", items }]}
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
