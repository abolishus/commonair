// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The page stories' shared chrome: the site header and footer, the creator studio and admin
 * navigation, and the story globals every board exports. One place, so every board shows the
 * same shell. Strings are fixture English (apps/web passes `t()`).
 */
import type * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Analytics01Icon,
  BubbleChatIcon,
  CodeIcon,
  Dollar01Icon,
  Layers01Icon,
  Notification01Icon,
  Radio02Icon,
  Settings02Icon,
  Shield01Icon,
  Video01Icon,
  VideoReplayIcon,
} from "@hugeicons/core-free-icons";
import { IconButton, LiveBadge } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { StatusBadge } from "@commonair/ui";
import {
  AdminShell,
  AppShell,
  HeaderSearch,
  SiteFooter,
  SiteHeader,
  StudioShell,
  UserMenu,
  type Brand,
  type FooterLink,
  type NavGroup,
  type NavItem,
} from "@commonair/ui/layouts";

/** Story globals each board exports (`.storybook/preview.tsx` defines the viewports). */
export const light = { globals: { theme: "light" } };
export const mobile320 = { globals: { viewport: { value: "mobile320", isRotated: false } } };
export const phone390 = { globals: { viewport: { value: "mobile390", isRotated: false } } };
export const pageParameters = { layout: "fullscreen" } as const;

const brand: Brand = { mark: <HugeiconsIcon icon={Radio02Icon} aria-hidden="true" />, name: "CommonAir", href: "#home" };

export type ViewerSection = "home" | "following" | "browse" | "coop" | undefined;

function viewerNav(current: ViewerSection): NavItem[] {
  return [
    { id: "home", label: "Home", href: "#home", current: current === "home" },
    { id: "following", label: "Following", href: "#following", current: current === "following" },
    { id: "browse", label: "Browse", href: "#browse", current: current === "browse" },
    { id: "coop", label: "Co-op", href: "#coop", current: current === "coop" },
  ];
}

const accountMenu = (
  <UserMenu
    username="mira"
    menuLabel="Account menu for mira"
    items={[
      { id: "channel", label: "Your channel", href: "#channel" },
      { id: "studio", label: "Creator studio", href: "#studio" },
      { id: "settings", label: "Settings", href: "#settings" },
      { id: "signout", label: "Sign out", separatorBefore: true, destructive: true },
    ]}
  />
);

/** The viewer header: brand, main navigation, search, notifications, Go live and the account menu. */
export function ViewerHeader({ current, goLive = true }: { current?: ViewerSection; goLive?: boolean }): React.JSX.Element {
  return (
    <SiteHeader
      brand={brand}
      nav={viewerNav(current)}
      navLabel="Main"
      menuLabel="Open navigation"
      searchLabel="Search"
      onOpenPalette={() => undefined}
      search={<HeaderSearch label="Search" placeholder="Search channels, categories, tags" shortcut="⌘K" />}
      actions={
        <>
          <IconButton label="Notifications" icon={Notification01Icon} />
          {goLive ? (
            <Button variant="outline" size="sm" render={<a href="#studio" />} nativeButton={false}>
              <HugeiconsIcon icon={Video01Icon} aria-hidden="true" />
              Go live
            </Button>
          ) : null}
        </>
      }
      user={accountMenu}
    />
  );
}

export type FooterVariant = "default" | "coop";

/** The site footer; the co-op boards link the bylaws instead of the developer docs. */
export function Footer({ variant = "default" }: { variant?: FooterVariant }): React.JSX.Element {
  const links: FooterLink[] =
    variant === "coop"
      ? [
          { label: "Transparency", href: "#transparency" },
          { label: "Bylaws", href: "#bylaws" },
          { label: "Status", href: "#status" },
        ]
      : [
          { label: "Transparency", href: "#transparency" },
          { label: "Status", href: "#status" },
          { label: "Developers", href: "#developers" },
        ];
  return (
    <SiteFooter
      instanceName="CommonAir"
      links={links}
      sourceLink={variant === "default" ? { label: "Source", href: "#source" } : undefined}
      license="AGPL-3.0-or-later"
    />
  );
}

export interface ViewerPageProps {
  current?: ViewerSection;
  sidebar?: React.ReactNode;
  footer?: FooterVariant | false;
  children: React.ReactNode;
}

/** AppShell + SiteHeader (+ ChannelSidebar on Main) + SiteFooter: every viewer, channel and co-op board. */
export function ViewerPage({ current, sidebar, footer = "default", children }: ViewerPageProps): React.JSX.Element {
  return (
    <AppShell
      header={<ViewerHeader current={current} />}
      sidebar={sidebar}
      footer={footer ? <Footer variant={footer} /> : null}
      skipLabel="Skip to content"
    >
      {children}
    </AppShell>
  );
}

export type StudioSection =
  | "manager"
  | "setup"
  | "analytics"
  | "revenue"
  | "moderation"
  | "chat"
  | "content"
  | "overlays"
  | "developer";

const icon = (svg: typeof Video01Icon): React.ReactNode => <HugeiconsIcon icon={svg} aria-hidden="true" />;

function studioGroups(current: StudioSection): NavGroup[] {
  const item = (id: StudioSection, label: string, svg: typeof Video01Icon, extra: Partial<NavItem> = {}): NavItem => ({
    id,
    label,
    href: `#${id}`,
    icon: icon(svg),
    current: current === id,
    ...extra,
  });
  return [
    {
      id: "studio",
      items: [
        item("manager", "Stream manager", Radio02Icon),
        item("setup", "Stream setup", Settings02Icon),
        item("analytics", "Analytics", Analytics01Icon),
        item("revenue", "Revenue", Dollar01Icon),
        item("moderation", "Moderation", Shield01Icon, { badge: { label: "3", tone: "destructive" } }),
        item("chat", "Chat & bot", BubbleChatIcon),
        item("content", "Videos & clips", VideoReplayIcon),
        item("overlays", "Alerts & overlays", Layers01Icon),
      ],
    },
    { id: "platform", items: [item("developer", "Developer", CodeIcon)] },
  ];
}

/** The studio header: brand, "Creator studio", live state, End stream and View channel. */
export function StudioHeader(): React.JSX.Element {
  return (
    <SiteHeader
      brand={brand}
      nav={[{ id: "studio", label: "Creator studio", href: "#studio", current: true }]}
      navLabel="Creator studio"
      menuLabel="Open navigation"
      actions={
        <>
          <LiveBadge />
          <StatusBadge tone="neutral">1:12:08</StatusBadge>
          <Button variant="destructive" size="sm">
            End stream
          </Button>
          <Button variant="ghost" size="sm" render={<a href="#channel" />} nativeButton={false}>
            View channel
          </Button>
        </>
      }
      user={accountMenu}
    />
  );
}

/** StudioShell for the eight creator studio boards. */
export function StudioPage({ current, children }: { current: StudioSection; children: React.ReactNode }): React.JSX.Element {
  return (
    <div data-accent="violet">
      <StudioShell header={<StudioHeader />} groups={studioGroups(current)} sidebarLabel="Creator studio">
        {children}
      </StudioShell>
    </div>
  );
}

const adminGroups: NavGroup[] = [
  {
    id: "admin",
    items: [
      { id: "reports", label: "Report queue", href: "#reports", current: true, badge: { label: "27", tone: "destructive" } },
      { id: "appeals", label: "Appeals", href: "#appeals", badge: { label: "6" } },
      { id: "dmca", label: "DMCA notices", href: "#dmca", badge: { label: "2" } },
      { id: "integrity", label: "Integrity signals", href: "#integrity" },
      { id: "relays", label: "Relays", href: "#relays" },
      { id: "users", label: "Users & channels", href: "#users" },
      { id: "legal", label: "Legal documents", href: "#legal" },
      { id: "audit", label: "Audit log", href: "#audit" },
    ],
  },
];

/** AdminShell for Trust & safety: brand, "Admin", the audit notice and the signed-in staff member. */
export function AdminPage({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <AdminShell
      header={
        <SiteHeader
          brand={brand}
          nav={[{ id: "admin", label: "Admin", href: "#admin", current: true }]}
          navLabel="Admin"
          menuLabel="Open navigation"
          actions={<StatusBadge tone="warning">Every action is audited</StatusBadge>}
          user={
            <UserMenu
              username="jo (T&S)"
              menuLabel="Account menu for jo"
              items={[{ id: "signout", label: "Sign out", destructive: true }]}
            />
          }
        />
      }
      groups={adminGroups}
      sidebarLabel="Admin"
    >
      {children}
    </AdminShell>
  );
}

/** The phone header: brand mark, search, notifications and the account menu (Mobile board). */
export function PhoneHeader(): React.JSX.Element {
  return (
    <SiteHeader
      brand={brand}
      nav={viewerNav(undefined)}
      navLabel="Main"
      menuLabel="Open navigation"
      searchLabel="Search"
      onOpenPalette={() => undefined}
      actions={<IconButton label="Notifications" icon={Notification01Icon} size="icon-lg" />}
      user={accountMenu}
    />
  );
}
