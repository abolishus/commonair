// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The settings navigation (overhaul wave 4, D7.1; account-admin.md P1): four groups of links,
 * not panels, so each page keeps its URL and Back steps through them. From `lg` (1024 px) it is a
 * section nav on `--surface-sunken` beside the page; below that, the same choice as a grouped
 * `Select` that navigates on change. Both are rendered and CSS shows one, so the server render is
 * right at either width. The current item comes from the route by path prefix
 * (`/settings/notifications/…` is still Notifications). Following lives at `/following`, outside
 * the settings layout, so it is never the current item here.
 */
import { SECURITY_SETTINGS_PATH } from "@commonair/contracts/auth";
import { StatusBadge, formatNumber, useLocale } from "@commonair/ui";
import { NavGroups, type NavGroup } from "@commonair/ui/layouts";
import { Label } from "@commonair/ui/components/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@commonair/ui/components/select";
import { Sidebar, SidebarContent, SidebarProvider } from "@commonair/ui/components/sidebar";
import { Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";

export const SETTINGS_GROUPS = [
  { id: "account", items: ["account", "security", "preferences"] },
  { id: "activity", items: ["notifications", "following", "subscriptions"] },
  { id: "safety", items: ["privacy", "appeals", "copyright"] },
  { id: "apps", items: ["connections"] },
] as const;

export type SettingsGroupId = (typeof SETTINGS_GROUPS)[number]["id"];
export type SettingsItemId = (typeof SETTINGS_GROUPS)[number]["items"][number];

/** Where each item goes. Following is the `/following` page; every other item is a `/settings/*` page. */
export const SETTINGS_PATHS: Record<SettingsItemId, string> = {
  account: "/settings/account",
  security: SECURITY_SETTINGS_PATH,
  preferences: "/settings/preferences",
  notifications: "/settings/notifications",
  following: "/following",
  subscriptions: "/settings/subscriptions",
  privacy: "/settings/privacy",
  appeals: "/settings/appeals",
  copyright: "/settings/copyright",
  connections: "/settings/connections",
};

export const SETTINGS_ITEMS: readonly SettingsItemId[] = SETTINGS_GROUPS.flatMap((g) => [...g.items]);

/** Pages under `/settings` that are not settings: the email unsubscribe link works signed out. */
const OUTSIDE = ["/settings/notifications/unsubscribe"];

function normalize(pathname: string): string {
  const path = pathname.split(/[?#]/)[0] ?? "";
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** The item a path belongs to, or null (another page, or one under `/settings` with no item). */
export function settingsTabFor(pathname: string): SettingsItemId | null {
  const path = normalize(pathname);
  if (!path.startsWith("/settings/")) return null;
  if (OUTSIDE.some((p) => path === p || path.startsWith(`${p}/`))) return null;
  return SETTINGS_ITEMS.find((id) => path === SETTINGS_PATHS[id] || path.startsWith(`${SETTINGS_PATHS[id]}/`)) ?? null;
}

/** The nav label, which is also each page's h1 (P1: the h1 is the nav label). */
export function settingsTabLabel(id: SettingsItemId): string {
  switch (id) {
    case "account":
      return t("d7Settings.nav.account");
    case "security":
      return t("d7Settings.nav.security");
    case "preferences":
      return t("d7Settings.nav.preferences");
    case "notifications":
      return t("d7Settings.nav.notifications");
    case "following":
      return t("d7Settings.nav.following");
    case "subscriptions":
      return t("d7Settings.nav.subscriptions");
    case "privacy":
      return t("d7Settings.nav.privacy");
    case "appeals":
      return t("d7Settings.nav.appeals");
    case "copyright":
      return t("d7Settings.nav.copyright");
    case "connections":
      return t("d7Settings.nav.connections");
  }
}

export function settingsGroupLabel(id: SettingsGroupId): string {
  switch (id) {
    case "account":
      return t("d7Settings.group.account");
    case "activity":
      return t("d7Settings.group.activity");
    case "safety":
      return t("d7Settings.group.safety");
    case "apps":
      return t("d7Settings.group.apps");
  }
}

/**
 * The link element for an item: literal test ids (the selector policy and the harness read them).
 * Security is built by another unit in parallel, so it is a plain link until its route exists.
 */
function itemLink(id: SettingsItemId): React.ReactElement {
  switch (id) {
    case "account":
      return <Link data-testid="settings-tab-account" to="/settings/account" />;
    case "security":
      return <a data-testid="settings-tab-security" href={SECURITY_SETTINGS_PATH} aria-label={settingsTabLabel("security")} />;
    case "preferences":
      return <Link data-testid="settings-tab-preferences" to="/settings/preferences" />;
    case "notifications":
      return <Link data-testid="settings-tab-notifications" to="/settings/notifications" />;
    case "following":
      return <Link data-testid="settings-tab-following" to="/following" />;
    case "subscriptions":
      return <Link data-testid="settings-tab-subscriptions" to="/settings/subscriptions" />;
    case "privacy":
      return <Link data-testid="settings-tab-privacy" to="/settings/privacy" />;
    case "appeals":
      return <Link data-testid="settings-tab-appeals" to="/settings/appeals" />;
    case "copyright":
      return <Link data-testid="settings-tab-copyright" to="/settings/copyright" />;
    case "connections":
      return <Link data-testid="settings-tab-connections" to="/settings/connections" />;
  }
}

/** Open items per page (appeals waiting on a decision, copyright notices still in effect). */
export type SettingsCounts = Partial<Record<SettingsItemId, number>>;

export function SettingsNav({
  current,
  counts = {},
}: {
  current: SettingsItemId;
  counts?: SettingsCounts;
}): React.JSX.Element {
  const navigate = useNavigate();
  const { locale } = useLocale();
  const selectId = React.useId();
  const go = (id: SettingsItemId): void => {
    switch (id) {
      case "account":
        return void navigate({ to: "/settings/account" });
      case "security":
        // Not in this build's route tree yet (d7-security builds it): a full page load.
        return window.location.assign(SECURITY_SETTINGS_PATH);
      case "preferences":
        return void navigate({ to: "/settings/preferences" });
      case "notifications":
        return void navigate({ to: "/settings/notifications" });
      case "following":
        return void navigate({ to: "/following" });
      case "subscriptions":
        return void navigate({ to: "/settings/subscriptions" });
      case "privacy":
        return void navigate({ to: "/settings/privacy" });
      case "appeals":
        return void navigate({ to: "/settings/appeals" });
      case "copyright":
        return void navigate({ to: "/settings/copyright" });
      case "connections":
        return void navigate({ to: "/settings/connections" });
    }
  };
  const items = Object.fromEntries(SETTINGS_ITEMS.map((id) => [id, settingsTabLabel(id)]));
  const groups: NavGroup[] = SETTINGS_GROUPS.map((group) => ({
    id: group.id,
    label: settingsGroupLabel(group.id),
    items: group.items.map((id) => {
      const n = counts[id] ?? 0;
      return {
        id,
        label: settingsTabLabel(id),
        render: itemLink(id),
        current: id === current,
        ...(n > 0 ? { badge: { label: formatNumber(n, locale) } } : {}),
      };
    }),
  }));
  return (
    <div data-testid="settings-nav" data-current={current} className="min-w-0 lg:w-60 lg:shrink-0">
      {/* lg and up: the section nav, grouped, on the sunken surface. */}
      <div className="hidden bg-surface-sunken lg:block">
        <SidebarProvider className="min-h-0 w-full bg-transparent">
          <Sidebar collapsible="none" className="w-full bg-transparent">
            <SidebarContent>
              <NavGroups groups={groups} label={t("d7Settings.nav.label")} />
            </SidebarContent>
          </Sidebar>
        </SidebarProvider>
      </div>
      {/* Below lg: ten links do not fit beside the page, so the same choice as a select. */}
      <div className="flex flex-col gap-1 lg:hidden">
        <Label htmlFor={selectId} className="text-xs text-muted-foreground">
          {t("d7Settings.nav.select")}
        </Label>
        <Select<string>
          value={current}
          items={items}
          onValueChange={(next) => {
            const id = SETTINGS_ITEMS.find((x) => x === next);
            if (id && id !== current) go(id);
          }}
        >
          <SelectTrigger id={selectId} data-testid="settings-nav-select" data-value={current} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SETTINGS_GROUPS.map((group) => (
              <SelectGroup key={group.id}>
                <SelectLabel>{settingsGroupLabel(group.id)}</SelectLabel>
                {group.items.map((id) => (
                  <SelectItem key={id} value={id} data-testid={`settings-nav-option-${id}`}>
                    <span className="flex items-center gap-2">
                      {settingsTabLabel(id)}
                      {(counts[id] ?? 0) > 0 ? (
                        <StatusBadge tone="neutral">{formatNumber(counts[id] ?? 0, locale)}</StatusBadge>
                      ) : null}
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
