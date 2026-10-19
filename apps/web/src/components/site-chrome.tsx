// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ThemeToggle } from "@commonair/ui";
import { buttonVariants } from "@commonair/ui/components/button";
import { SidebarTrigger } from "@commonair/ui/components/sidebar";
import { SiteFooter, SiteHeader, UserMenu, type NavItem, type UserMenuItem } from "@commonair/ui/layouts";
import { toast } from "@commonair/ui/toast";
import {
  DashboardSquare01Icon,
  LiveStreaming02Icon,
  Logout03Icon,
  ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useLocation } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../i18n/index.ts";
import { signOut } from "../lib/auth.ts";
import { useBootstrap } from "../lib/bootstrap.ts";
import { accountMenu, siteNav, type AccountEntry } from "../lib/nav.ts";
import { ThemeContext } from "../lib/theme-context.ts";
import { safeHttpUrl } from "../lib/url.ts";

async function onSignOut(): Promise<void> {
  try {
    await signOut();
    // Full load: nothing rendered for the old session survives.
    window.location.assign("/");
  } catch {
    toast.error(t("auth.signOutFailed"));
  }
}

function accountItem(entry: AccountEntry): UserMenuItem {
  const icon = (glyph: typeof Logout03Icon) => <HugeiconsIcon icon={glyph} strokeWidth={2} aria-hidden />;
  switch (entry.id) {
    case "dashboard":
      return {
        id: entry.id,
        label: t("nav.dashboard"),
        icon: icon(DashboardSquare01Icon),
        render: <Link to="/dashboard" />,
      };
    case "relays":
      return { id: entry.id, label: t("nav.relays"), icon: icon(ServerStack01Icon), render: <Link to="/relays" /> };
    case "signOut":
      return {
        id: entry.id,
        label: t("nav.signOut"),
        icon: icon(Logout03Icon),
        onSelect: () => void onSignOut(),
        destructive: entry.destructive,
        separatorBefore: entry.separatorBefore,
      };
  }
}

/**
 * The site header for every page with chrome. `studio` adds the sidebar toggle; it must then be
 * rendered inside the StudioShell (the toggle needs its SidebarProvider).
 */
export function AppHeader({ studio = false }: { studio?: boolean }): React.JSX.Element {
  const { me, instance } = useBootstrap();
  const { theme, setTheme } = React.useContext(ThemeContext);
  const pathname = useLocation({ select: (location) => location.pathname });

  const nav: NavItem[] = siteNav(pathname).map((entry) => ({
    id: entry.id,
    label: t("nav.directory"),
    current: entry.current,
    render: <Link data-testid="nav-directory" to="/" />,
  }));

  const user = me ? (
    <UserMenu
      data-testid="nav-user"
      data-username={me.username}
      username={me.username}
      menuLabel={t("nav.accountMenu", { name: me.displayName })}
      items={accountMenu(true).map(accountItem)}
    />
  ) : (
    <nav aria-label={t("nav.account")} className="flex items-center gap-2">
      {accountMenu(false, pathname).map((entry) => (
        <Link
          key={entry.id}
          to={entry.to}
          aria-current={entry.current ? "page" : undefined}
          // At 320 px only sign-in fits next to the brand; sign-up is one tap away from there.
          className={buttonVariants({
            variant: entry.id === "signUp" ? "default" : "ghost",
            size: "sm",
            className: entry.id === "signUp" ? "hidden sm:inline-flex" : undefined,
          })}
        >
          {entry.id === "signIn" ? t("nav.signIn") : t("nav.signUp")}
        </Link>
      ))}
    </nav>
  );

  return (
    <SiteHeader
      brand={{
        name: instance.name,
        href: "/",
        mark: <HugeiconsIcon icon={LiveStreaming02Icon} strokeWidth={2} aria-hidden />,
      }}
      nav={nav}
      navLabel={t("nav.main")}
      menuLabel={t("nav.menu")}
      actions={
        <>
          {studio && <SidebarTrigger />}
          {/* E4a gap: SiteHeader needs a slot in its mobile sheet for the theme switch; below sm it is hidden. */}
          <ThemeToggle value={theme} onValueChange={setTheme} className="hidden sm:flex" />
        </>
      }
      user={user}
    />
  );
}

/** Instance name, license and the AGPL §13 source link (from `instance.info`). */
export function AppFooter(): React.JSX.Element {
  const { instance } = useBootstrap();
  const sourceUrl = safeHttpUrl(instance.sourceUrl);
  return (
    <SiteFooter
      instanceName={instance.name}
      links={[]}
      license={t("footer.license")}
      sourceLink={
        sourceUrl ? { label: t("footer.source"), href: sourceUrl, "data-testid": "footer-source-link" } : undefined
      }
    />
  );
}
