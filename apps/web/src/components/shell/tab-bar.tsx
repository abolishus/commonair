// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { BottomTabBar, type TabBarItem } from "@commonair/ui/layouts";
import { Compass01Icon, FavouriteIcon, Home01Icon, UserCircleIcon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useLocation } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { tabBarNav, type TabEntry } from "../../lib/nav.ts";
import { useAccountItems } from "./account-items.tsx";
import { useAuthRedirect } from "./auth-redirect.ts";
import { useKeyboardOpen } from "./use-keyboard-open.ts";
import { YouSheet } from "./you-sheet.tsx";

const icon = (glyph: typeof Home01Icon) => <HugeiconsIcon icon={glyph} size={22} strokeWidth={1.5} aria-hidden />;

/**
 * The phone's bottom tab bar for browsing pages (the `_app` layout renders it only where
 * `tabBarVisible` says so): Home, Browse, Following or Co-op, and You, which is Sign in for a
 * visitor and the account sheet for a member. Hidden while the on-screen keyboard is open.
 */
export function AppTabBar(): React.JSX.Element {
  const { me } = useBootstrap();
  const pathname = useLocation({ select: (location) => location.pathname });
  const keyboardOpen = useKeyboardOpen();
  const redirect = useAuthRedirect();
  const [youOpen, setYouOpen] = React.useState(false);
  const accountItems = useAccountItems();
  const items = tabBarNav(pathname, me !== null).map((entry): TabBarItem =>
    tabItem(entry, { redirect, youOpen, openYou: () => setYouOpen(true) }),
  );
  return (
    <>
      <BottomTabBar data-testid="tab-bar" label={t("shell.tabs.label")} items={items} hidden={keyboardOpen} />
      {me ? <YouSheet open={youOpen} onOpenChange={setYouOpen} items={accountItems} /> : null}
    </>
  );
}

function tabItem(
  entry: TabEntry,
  context: { redirect: string | undefined; youOpen: boolean; openYou: () => void },
): TabBarItem {
  const base = { id: entry.id, current: entry.current, testId: `tab-${entry.id}` };
  switch (entry.id) {
    case "home":
      return { ...base, label: t("shell.tab.home"), icon: icon(Home01Icon), render: <Link to="/" /> };
    case "browse":
      return { ...base, label: t("shell.tab.browse"), icon: icon(Compass01Icon), render: <Link to="/directory" /> };
    case "following":
      // Not a route yet (the discovery batch adds `/following`): a plain link until then.
      return { ...base, label: t("shell.tab.following"), icon: icon(FavouriteIcon), href: "/following" };
    case "coop":
      return { ...base, label: t("shell.tab.coop"), icon: icon(UserGroupIcon), render: <Link to="/coop" /> };
    case "you":
      return entry.to
        ? {
            ...base,
            label: t("shell.tab.signIn"),
            icon: icon(UserCircleIcon),
            render: <Link to="/signin" search={context.redirect ? { redirect: context.redirect } : {}} />,
          }
        : {
            ...base,
            label: t("shell.tab.you"),
            icon: icon(UserCircleIcon),
            expanded: context.youOpen,
            onSelect: context.openYou,
          };
  }
}
