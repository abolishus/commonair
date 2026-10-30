// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ThemeToggle } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { SidebarTrigger } from "@commonair/ui/components/sidebar";
import { SiteFooter, SiteHeader, UserMenu, type NavItem, type UserMenuItem } from "@commonair/ui/layouts";
import { toast } from "@commonair/ui/toast";
import {
  BankIcon,
  CopyrightIcon,
  CreditCardIcon,
  UserGroupIcon,
  DashboardSquare01Icon,
  JusticeScale01Icon,
  LegalDocument01Icon,
  LiveStreaming02Icon,
  Logout03Icon,
  Notification03Icon,
  Plug01Icon,
  ServerStack01Icon,
  Shield01Icon,
  SquareLock01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useLocation } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../i18n/index.ts";
import { signOut } from "../lib/auth.ts";
import { useBootstrap } from "../lib/bootstrap.ts";
import { isAdmin } from "../lib/coop.ts";
import { isTreasurer } from "../lib/money.ts";
import {
  accountMenu,
  footerNav,
  siteNav,
  type AccountEntry,
  type FooterEntry,
  type SignedOutEntry,
} from "../lib/nav.ts";
import { ThemeContext } from "../lib/theme-context.ts";
import { safeHttpUrl } from "../lib/url.ts";
import { CookieSettingsButton } from "./consent/cookie-settings-button.tsx";
import { NotificationBell } from "./notifications/bell.tsx";
import { forgetPushSubscription } from "./pwa/push-client.ts";
import { isLegal, isSafetyStaff } from "./safety/access.ts";

async function onSignOut(): Promise<void> {
  try {
    // Sign-out removes this browser's push subscription (ADR 0028 decision 6).
    await forgetPushSubscription().catch(() => undefined);
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
    case "subscriptions":
      return {
        id: entry.id,
        label: t("nav.subscriptions"),
        icon: icon(CreditCardIcon),
        render: <Link data-testid="account-subscriptions-link" to="/settings/subscriptions" />,
      };
    case "notifications":
      return {
        id: entry.id,
        label: t("nav.notifications"),
        icon: icon(Notification03Icon),
        render: <Link data-testid="account-notifications-link" to="/settings/notifications" />,
      };
    case "appeals":
      return {
        id: entry.id,
        label: t("nav.appeals"),
        icon: icon(JusticeScale01Icon),
        render: <Link data-testid="account-appeals-link" to="/settings/appeals" />,
      };
    case "copyright":
      return {
        id: entry.id,
        label: t("nav.copyright"),
        icon: icon(CopyrightIcon),
        render: <Link data-testid="account-copyright-link" to="/settings/copyright" />,
      };
    case "privacy":
      return {
        id: entry.id,
        label: t("nav.privacy"),
        icon: icon(SquareLock01Icon),
        render: <Link data-testid="account-privacy-link" to="/settings/privacy" />,
      };
    case "connections":
      return {
        id: entry.id,
        label: t("nav.connections"),
        icon: icon(Plug01Icon),
        render: <Link data-testid="account-connections-link" to="/settings/connections" />,
      };
    case "coop":
      return {
        id: entry.id,
        label: t("nav.coopMembership"),
        icon: icon(UserGroupIcon),
        render: <Link data-testid="account-coop-link" to="/coop/membership" />,
      };
    case "adminCoop":
      return {
        id: entry.id,
        label: t("nav.adminCoop"),
        icon: icon(UserGroupIcon),
        render: <Link data-testid="account-admin-coop-link" to="/admin/coop" />,
      };
    case "treasury":
      return {
        id: entry.id,
        label: t("nav.treasury"),
        icon: icon(BankIcon),
        render: <Link data-testid="account-treasury-link" to="/treasury" />,
      };
    case "moderation":
      return {
        id: entry.id,
        label: t("nav.moderation"),
        icon: icon(Shield01Icon),
        render: <Link data-testid="account-moderation-link" to="/admin/moderation" />,
      };
    case "legal":
      return {
        id: entry.id,
        label: t("nav.legal"),
        icon: icon(LegalDocument01Icon),
        render: <Link data-testid="account-legal-link" to="/admin/legal" />,
      };
    case "signOut":
      return {
        id: entry.id,
        label: t("nav.signOut"),
        icon: icon(Logout03Icon),
        testId: "nav-signout",
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

  const nav: NavItem[] = siteNav(pathname).map((entry) =>
    entry.id === "coop"
      ? {
          id: entry.id,
          label: t("nav.coop"),
          current: entry.current,
          render: <Link data-testid="nav-coop" to="/coop" />,
        }
      : {
          id: entry.id,
          label: t("nav.directory"),
          current: entry.current,
          render: <Link data-testid="nav-directory" to="/" />,
        },
  );

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
          <>
            <NotificationBell />
            <UserMenu
              data-testid="nav-user"
              data-username={me.username}
              username={me.username}
              menuLabel={t("nav.accountMenu", { name: me.displayName })}
              items={accountMenu(true, {
                treasurer: isTreasurer(me),
                safetyStaff: isSafetyStaff(me),
                legal: isLegal(me),
                admin: isAdmin(me),
              }).map(accountItem)}
            />
          </>
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

function footerLink(entry: FooterEntry): { label: string; render: React.ReactElement } {
  switch (entry.id) {
    case "transparency":
      return {
        label: t("footer.transparency"),
        render: <Link data-testid="footer-transparency-link" to="/transparency" />,
      };
    case "takedown":
      return { label: t("footer.takedown"), render: <Link data-testid="footer-takedown-link" to="/takedown" /> };
    case "dmca":
      return { label: t("footer.dmca"), render: <Link data-testid="footer-dmca-link" to="/dmca" /> };
  }
}

export type Instance = ReturnType<typeof useBootstrap>["instance"];

/** Instance name, the public pages, license and the AGPL §13 source link (from `instance.info`). */
export function InstanceFooter({ instance }: { instance: Instance }): React.JSX.Element {
  const sourceUrl = safeHttpUrl(instance.sourceUrl);
  return (
    <SiteFooter
      instanceName={instance.name}
      links={[
        ...footerNav().map(footerLink),
        { label: t("consent.footer.settings"), render: <CookieSettingsButton /> },
      ]}
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
