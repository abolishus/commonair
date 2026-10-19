// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ThemeToggle } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
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
import { accountMenu, siteNav, type AccountEntry, type SignedOutEntry } from "../lib/nav.ts";
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

function AccountLink({ entry }: { entry: SignedOutEntry }): React.JSX.Element {
  return (
    <Button
      variant={entry.id === "signUp" ? "default" : "ghost"}
      size="sm"
      nativeButton={false}
      render={<Link to={entry.to} aria-current={entry.current ? "page" : undefined} />}
    >
      {entry.id === "signIn" ? t("nav.signIn") : t("nav.signUp")}
    </Button>
  );
}

/**
 * The site header for every page with chrome. `studio` adds the sidebar toggle; it must then be
 * rendered inside the StudioShell (the toggle needs its SidebarProvider).
 *
 * Width at a 288 px content box (320 px minus the 16 px gutters), below md where the nav and the
 * desktop group collapse into the sheet: menu button 32 + two 12 px gaps, plus
 * - signed out: Sign in 65 → the brand keeps ~167 px;
 * - signed in: avatar-only UserMenu ~36 → ~196 px;
 * - studio: sidebar toggle 28 + 8 + UserMenu ~36 → ~160 px.
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

  const signedOut = me ? [] : accountMenu(false, pathname);
  const signIn = signedOut.filter((entry) => entry.id === "signIn");
  const signUp = signedOut.filter((entry) => entry.id === "signUp");
  const themeToggle = <ThemeToggle value={theme} onValueChange={setTheme} />;

  return (
    <SiteHeader
      brand={{
        name: instance.name,
        href: "/",
        render: <Link to="/" />,
        mark: <HugeiconsIcon icon={LiveStreaming02Icon} strokeWidth={2} aria-hidden />,
      }}
      nav={nav}
      navLabel={t("nav.main")}
      menuLabel={t("nav.menu")}
      actions={studio ? <SidebarTrigger /> : undefined}
      // The theme switch (84) and Sign up (65) do not fit next to the brand at 288 px: from md they
      // sit in the bar, below md in the phone sheet.
      desktopActions={
        <>
          {themeToggle}
          {signUp.map((entry) => (
            <AccountLink key={entry.id} entry={entry} />
          ))}
        </>
      }
      user={
        me ? (
          <UserMenu
            data-testid="nav-user"
            data-username={me.username}
            username={me.username}
            menuLabel={t("nav.accountMenu", { name: me.displayName })}
            items={accountMenu(true).map(accountItem)}
          />
        ) : (
          signIn.map((entry) => <AccountLink key={entry.id} entry={entry} />)
        )
      }
      mobileActions={
        <>
          {themeToggle}
          {signUp.map((entry) => (
            <AccountLink key={entry.id} entry={entry} />
          ))}
        </>
      }
    />
  );
}

export type Instance = ReturnType<typeof useBootstrap>["instance"];

/** Instance name, license and the AGPL §13 source link (from `instance.info`). */
export function InstanceFooter({ instance }: { instance: Instance }): React.JSX.Element {
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

export function AppFooter(): React.JSX.Element {
  const { instance } = useBootstrap();
  return <InstanceFooter instance={instance} />;
}
