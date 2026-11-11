// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { UserMenuItem } from "@commonair/ui/layouts";
import { toast } from "@commonair/ui/toast";
import {
  BankIcon,
  DashboardSquare01Icon,
  FavouriteIcon,
  LegalDocument01Icon,
  Logout03Icon,
  Settings02Icon,
  Shield01Icon,
  ShieldUserIcon,
  Tv01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import { t } from "../../i18n/index.ts";
import { signOut } from "../../lib/auth.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { isAdmin } from "../../lib/coop.ts";
import { isTreasurer } from "../../lib/money.ts";
import { accountMenu, type AccountEntry } from "../../lib/nav.ts";
import { forgetPushSubscription } from "../pwa/push-client.ts";
import { isLegal, isSafetyStaff } from "../safety/access.ts";
import { useModerates } from "../studio-shell/moderates.ts";

export async function onSignOut(): Promise<void> {
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

const icon = (glyph: typeof Logout03Icon) => <HugeiconsIcon icon={glyph} strokeWidth={2} aria-hidden />;

/**
 * An account entry as a menu item, for the header's account menu and the phone's You sheet alike.
 * `/following` is not a route yet (the discovery batch adds it), so it is a plain link until then.
 */
export function accountItem(entry: AccountEntry): UserMenuItem {
  switch (entry.id) {
    case "channel":
      return {
        id: entry.id,
        label: t("shell.menu.channel"),
        icon: icon(Tv01Icon),
        render: (
          <Link data-testid="account-channel-link" to="/$channel" params={{ channel: entry.params?.channel ?? "" }} />
        ),
      };
    case "studio":
      return {
        id: entry.id,
        label: t("studio.nav"),
        icon: icon(DashboardSquare01Icon),
        render: <Link data-testid="account-studio-link" to="/dashboard" />,
      };
    case "modView":
      return {
        id: entry.id,
        label: t("d5Shell.menu.modView"),
        icon: icon(ShieldUserIcon),
        render: (
          <Link
            data-testid="account-mod-view-link"
            to="/mod/$channel"
            params={{ channel: entry.params?.channel ?? "" }}
          />
        ),
      };
    case "following":
      return {
        id: entry.id,
        label: t("shell.menu.following"),
        icon: icon(FavouriteIcon),
        href: "/following",
        testId: "account-following-link",
      };
    case "settings":
      return {
        id: entry.id,
        label: t("shell.menu.settings"),
        icon: icon(Settings02Icon),
        render: <Link data-testid="account-settings-link" to="/settings" />,
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

/**
 * The signed-in member's account entries as menu items (none for a visitor). "Mod view" joins once
 * `me.moderates` answers with a channel (J5-a).
 */
export function useAccountItems(): UserMenuItem[] {
  const { me } = useBootstrap();
  const moderates = useModerates(me?.id ?? null);
  if (!me) return [];
  return accountMenu(true, {
    channel: me.channelSlug,
    treasurer: isTreasurer(me),
    safetyStaff: isSafetyStaff(me),
    legal: isLegal(me),
    admin: isAdmin(me),
    moderates: moderates.map((m) => m.channel.slug),
  }).map(accountItem);
}
