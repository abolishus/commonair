// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The settings navigation (F27): one row of tabs for the seven `/settings/*` pages, links rather
 * than panels, so each page keeps its URL and Back steps through them. The current tab comes from
 * the route by path prefix (`/settings/notifications/…` is still Notifications). Below `sm` the row
 * becomes a `Select` that navigates on change; both are rendered and CSS shows one, so the server
 * render is already right at either width.
 */
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@commonair/ui/components/select";
import { PageTabs } from "@commonair/ui/blocks/headers";
import { Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";

export const SETTINGS_TABS = [
  { id: "subscriptions", to: "/settings/subscriptions" },
  { id: "notifications", to: "/settings/notifications" },
  { id: "appeals", to: "/settings/appeals" },
  { id: "copyright", to: "/settings/copyright" },
  { id: "privacy", to: "/settings/privacy" },
  { id: "connections", to: "/settings/connections" },
  { id: "preferences", to: "/settings/preferences" },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];
export type SettingsTabId = SettingsTab["id"];

/** Pages under `/settings` that are not settings: the email unsubscribe link works signed out. */
const OUTSIDE_TABS = ["/settings/notifications/unsubscribe"];

function normalize(pathname: string): string {
  const path = pathname.split(/[?#]/)[0] ?? "";
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** The tab a path belongs to, or null (another page, or one under `/settings` that has no tab). */
export function settingsTabFor(pathname: string): SettingsTabId | null {
  const path = normalize(pathname);
  if (OUTSIDE_TABS.some((p) => path === p || path.startsWith(`${p}/`))) return null;
  return SETTINGS_TABS.find((tab) => path === tab.to || path.startsWith(`${tab.to}/`))?.id ?? null;
}

export function settingsTabLabel(id: SettingsTabId): string {
  switch (id) {
    case "subscriptions":
      return t("nav.subscriptions");
    case "notifications":
      return t("nav.notifications");
    case "appeals":
      return t("nav.appeals");
    case "copyright":
      return t("nav.copyright");
    case "privacy":
      return t("nav.privacy");
    case "connections":
      return t("nav.connections");
    case "preferences":
      return t("nav.preferences");
  }
}

function tabLink(id: SettingsTabId): React.ReactElement {
  switch (id) {
    case "subscriptions":
      return <Link to="/settings/subscriptions" />;
    case "notifications":
      return <Link to="/settings/notifications" />;
    case "appeals":
      return <Link to="/settings/appeals" />;
    case "copyright":
      return <Link to="/settings/copyright" />;
    case "privacy":
      return <Link to="/settings/privacy" />;
    case "connections":
      return <Link to="/settings/connections" />;
    case "preferences":
      return <Link to="/settings/preferences" />;
  }
}

export function SettingsNav({ current }: { current: SettingsTabId }): React.JSX.Element {
  const navigate = useNavigate();
  const selectId = React.useId();
  const items = Object.fromEntries(SETTINGS_TABS.map((tab) => [tab.id, settingsTabLabel(tab.id)]));
  return (
    <nav aria-label={t("settings.nav.label")} data-testid="settings-nav" data-current={current} className="min-w-0">
      {/* sm and up: the shared tab row in link mode; the current tab follows the route (F30). */}
      <PageTabs
        className="hidden sm:flex"
        items={SETTINGS_TABS.map((tab) => ({
          id: tab.id,
          label: settingsTabLabel(tab.id),
          render: tabLink(tab.id),
          current: tab.id === current,
          "data-testid": `settings-tab-${tab.id}`,
        }))}
      />
      {/* Below sm: seven tabs do not fit 320 px, so the same choice as a select. */}
      <div className="flex flex-col gap-1 sm:hidden">
        <label htmlFor={selectId} className="text-xs text-muted-foreground">
          {t("settings.nav.select")}
        </label>
        <Select<string>
          value={current}
          items={items}
          onValueChange={(next) => {
            const tab = SETTINGS_TABS.find((x) => x.id === next);
            if (tab && tab.id !== current) void navigate({ to: tab.to });
          }}
        >
          <SelectTrigger id={selectId} data-testid="settings-nav-select" data-value={current} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SETTINGS_TABS.map((tab) => (
              <SelectItem key={tab.id} value={tab.id} data-testid={`settings-nav-option-${tab.id}`}>
                {settingsTabLabel(tab.id)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </nav>
  );
}
