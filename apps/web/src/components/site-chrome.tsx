// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ThemeToggle } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { SidebarTrigger } from "@commonair/ui/components/sidebar";
import { SiteFooter, SiteHeader, type FooterLink, type NavItem } from "@commonair/ui/layouts";
import { Link, useLocation } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../i18n/index.ts";
import { useBootstrap } from "../lib/bootstrap.ts";
import {
  accountMenu,
  footerColumns,
  siteNav,
  type FooterColumnEntry,
  type FooterEntry,
  type SignedOutEntry,
} from "../lib/nav.ts";
import { ThemeContext } from "../lib/theme-context.ts";
import { safeHttpUrl } from "../lib/url.ts";
import { CookieSettingsButton } from "./consent/cookie-settings-button.tsx";
import { AccountMenu } from "./discovery/account-menu.tsx";
import { DiscoveryPalette, HeaderSearchField, MobileSearchSheet } from "./discovery/header-search.tsx";
import { SheetDiscovery, SideRail } from "./discovery/rail.tsx";
import { FooterLocaleSwitcher } from "./locale/footer-locale-switcher.tsx";
import { NotificationBell } from "./notifications/bell.tsx";
import { useAccountItems } from "./shell/account-items.tsx";
import { useAuthRedirect } from "./shell/auth-redirect.ts";
import { BrandMark } from "./shell/brand-mark.tsx";
import { useFilledCtaInView } from "./shell/use-filled-cta.ts";

/**
 * Sign in and Sign up for visitors, at every width (decisions log): compact, both carrying
 * `?redirect`. Sign up is the zinc fill, or an outline while another filled CTA is on screen;
 * never the brand colour. Below md on pages with the bottom tab bar, Sign in moves into its You tab.
 */
function SignedOutActions({
  entries,
  signInInTabBar,
  outline,
}: {
  entries: SignedOutEntry[];
  signInInTabBar: boolean;
  outline: boolean;
}): React.JSX.Element {
  const redirect = useAuthRedirect();
  return (
    <>
      {entries.map((entry) => {
        const signUp = entry.id === "signUp";
        return (
          <Button
            key={entry.id}
            variant={signUp ? (outline ? "outline" : "default") : "ghost"}
            size="sm"
            nativeButton={false}
            data-auth-link={entry.id}
            data-cta-style={signUp ? (outline ? "outline" : "fill") : undefined}
            // 40 px tall below md, a comfortable tap target in the 56 px bar.
            className={signUp ? "max-md:h-10" : signInInTabBar ? "max-md:hidden" : "max-md:h-10"}
            render={
              <Link
                to={entry.to}
                search={redirect ? { redirect } : {}}
                aria-current={entry.current ? "page" : undefined}
              />
            }
          >
            {signUp ? t("nav.signUp") : t("nav.signIn")}
          </Button>
        );
      })}
    </>
  );
}

/**
 * The site header for every page with chrome (F14, F18): the mark and name, Browse and Co-op,
 * search and the account controls; the same in every area, so the logo never moves. `studio`
 * adds the sidebar toggle; it must then be rendered inside a shell with a sidebar (the toggle
 * needs its SidebarProvider). `tabBar`: the layout renders the bottom tab bar on this page (only
 * the layout knows; a fallback shell without one leaves it off).
 *
 * Below md: the mark (the name too while it fits and no signed-in cluster is shown), the search
 * button, then Sign in + Sign up, or the bell and avatar. On browsing pages the bottom tab bar
 * carries the sections and Sign in, so there is no menu button; elsewhere (watch, auth, studio)
 * the phone sheet keeps the nav, the rail's lists and, for visitors, the theme and language.
 */
export function AppHeader({
  studio = false,
  tabBar = false,
}: {
  studio?: boolean;
  tabBar?: boolean;
}): React.JSX.Element {
  const { me, instance } = useBootstrap();
  const { theme, setTheme } = React.useContext(ThemeContext);
  const pathname = useLocation({ select: (location) => location.pathname });
  // The whole href, so a new search submitted on /search also closes the phone sheet.
  const locationKey = useLocation({ select: (location) => location.href });
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const filledCtaInView = useFilledCtaInView(me === null);
  const accountItems = useAccountItems();

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
          render: <Link data-testid="nav-directory" to="/directory" />,
        },
  );

  return (
    <>
      <SiteHeader
        brand={{
          name: instance.name,
          label: t("shell.brand.home", { name: instance.name }),
          href: "/",
          render: <Link to="/" />,
          mark: <BrandMark />,
        }}
        compactBrand={me !== null}
        mobileMenu={!tabBar}
        nav={nav}
        navLabel={t("nav.main")}
        menuLabel={t("nav.menu")}
        locationKey={locationKey}
        search={<HeaderSearchField />}
        searchLabel={t("discovery.search.open")}
        onOpenPalette={() => setSearchOpen(true)}
        // A 44 px hit area below md, as for every icon button in the bar.
        actions={studio ? <SidebarTrigger className="max-md:size-11" /> : undefined}
        user={
          me ? (
            <>
              <NotificationBell />
              <AccountMenu
                data-testid="nav-user"
                data-username={me.username}
                username={me.username}
                displayName={me.displayName}
                menuLabel={t("nav.accountMenu", { name: me.displayName })}
                theme={theme}
                onThemeChange={setTheme}
                items={accountItems}
              />
            </>
          ) : (
            <SignedOutActions
              entries={accountMenu(false, pathname)}
              signInInTabBar={tabBar}
              outline={filledCtaInView}
            />
          )
        }
        mobileActions={
          <>
            <SheetDiscovery />
            <div className="flex w-full flex-wrap items-center gap-2 border-t pt-4">
              {!me && (
                <span data-testid="sheet-theme-switcher">
                  <ThemeToggle value={theme} onValueChange={setTheme} />
                </span>
              )}
              <FooterLocaleSwitcher>{t("preferences.footerLanguage")}</FooterLocaleSwitcher>
            </div>
          </>
        }
      />
      <MobileSearchSheet open={searchOpen} onOpenChange={setSearchOpen} />
      <DiscoveryPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </>
  );
}

/** The public pages' left rail (F7), for AppShell's `sidebar`. */
export function AppRail(): React.JSX.Element {
  return <SideRail />;
}

const FOOTER_HEADING: Record<
  FooterColumnEntry["id"],
  "shell.footer.create" | "shell.footer.coop" | "shell.footer.legal"
> = {
  create: "shell.footer.create",
  coop: "shell.footer.coop",
  legal: "shell.footer.legal",
};

/** `/creators` is not a route yet (the acquisition batch adds it): a plain link until then. */
function footerLink(entry: FooterEntry, instanceName: string): FooterLink {
  switch (entry.id) {
    case "creators":
      return { label: t("shell.footer.creators", { name: instanceName }), href: "/creators" };
    case "studio":
      return { label: t("studio.nav"), render: <Link data-testid="footer-studio-link" to="/dashboard" /> };
    case "import":
      return { label: t("shell.footer.import"), render: <Link data-testid="footer-import-link" to="/import" /> };
    case "coopOverview":
      return { label: t("shell.footer.coopOverview"), render: <Link data-testid="footer-coop-link" to="/coop" /> };
    case "membership":
      return {
        label: t("shell.footer.membership"),
        render: <Link data-testid="footer-membership-link" to="/coop/membership" />,
      };
    case "proposals":
      return {
        label: t("shell.footer.proposals"),
        render: <Link data-testid="footer-proposals-link" to="/coop/proposals" />,
      };
    case "transparency":
      return {
        label: t("footer.transparency"),
        render: <Link data-testid="footer-transparency-link" to="/transparency" />,
      };
    case "attestations":
      return {
        label: t("footer.attestations"),
        render: <Link data-testid="footer-attestations-link" to="/attestations/verify" />,
      };
    case "takedown":
      return { label: t("footer.takedown"), render: <Link data-testid="footer-takedown-link" to="/takedown" /> };
    case "dmca":
      return { label: t("footer.dmca"), render: <Link data-testid="footer-dmca-link" to="/dmca" /> };
  }
}

export type Instance = ReturnType<typeof useBootstrap>["instance"];

/**
 * The footer: the instance and its one-line promise, the Create, Co-op and Legal columns, then
 * the AGPL §13 source link (from `instance.info`), the license, cookie settings, the language
 * and, for visitors (members have it in the account menu), the theme.
 */
export function InstanceFooter({ instance, signedIn = false }: { instance: Instance; signedIn?: boolean }) {
  const sourceUrl = safeHttpUrl(instance.sourceUrl);
  const { theme, setTheme } = React.useContext(ThemeContext);
  return (
    <SiteFooter
      instanceName={instance.name}
      mark={<BrandMark className="size-5" />}
      tagline={t("shell.footer.tagline")}
      columns={footerColumns({ twitchImport: instance.twitchImport }).map((column) => ({
        id: column.id,
        heading: t(FOOTER_HEADING[column.id]),
        links: column.links.map((entry) => footerLink(entry, instance.name)),
      }))}
      baseLabel={t("shell.footer.base")}
      links={[
        { label: t("consent.footer.settings"), render: <CookieSettingsButton /> },
        { label: t("preferences.footerLanguage"), render: <FooterLocaleSwitcher /> },
      ]}
      extra={
        signedIn ? undefined : (
          <span data-testid="footer-theme-switcher">
            <ThemeToggle value={theme} onValueChange={setTheme} />
          </span>
        )
      }
      license={t("footer.license")}
      sourceLink={
        sourceUrl ? { label: t("footer.source"), href: sourceUrl, "data-testid": "footer-source-link" } : undefined
      }
    />
  );
}

export function AppFooter(): React.JSX.Element {
  const { instance, me } = useBootstrap();
  return <InstanceFooter instance={instance} signedIn={me !== null} />;
}
