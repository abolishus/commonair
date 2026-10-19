// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@commonair/ui/components/sidebar";
import { cn } from "@commonair/ui/lib/utils";

export interface NavItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  href?: string;
  render?: React.ReactElement;
  current?: boolean;
  badge?: { label: string; tone?: "default" | "muted" | "destructive" };
  disabled?: boolean;
}

export interface NavGroup {
  id: string;
  label?: string;
  items: NavItem[];
}

export function NavGroups({ groups, label }: { groups: NavGroup[]; label: string }): React.JSX.Element {
  return (
    <nav aria-label={label} className="min-w-0">
      {groups.map((group) => (
        <SidebarGroup key={group.id}>
          {group.label ? <SidebarGroupLabel>{group.label}</SidebarGroupLabel> : null}
          <SidebarMenu>
            {group.items.map((item) => (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  render={item.render ?? (item.href ? <a href={item.href}>{item.label}</a> : undefined)}
                  isActive={item.current}
                  disabled={item.disabled}
                  aria-current={item.current ? "page" : undefined}
                >
                  {item.icon}
                  <span>{item.label}</span>
                  {item.badge ? <SidebarMenuBadge>{item.badge.label}</SidebarMenuBadge> : null}
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      ))}
    </nav>
  );
}

export function NavLink({ item, className }: { item: NavItem; className?: string }): React.JSX.Element {
  return (
    <a
      href={item.href}
      aria-current={item.current ? "page" : undefined}
      aria-disabled={item.disabled || undefined}
      className={cn("inline-flex items-center gap-2", className)}
    >
      {item.icon}
      {item.label}
      {item.badge ? <span>{item.badge.label}</span> : null}
    </a>
  );
}
