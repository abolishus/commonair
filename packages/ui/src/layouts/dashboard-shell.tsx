// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { Sidebar, SidebarContent, SidebarInset, SidebarProvider } from "@commonair/ui/components/sidebar";
import { NavGroups, type NavGroup } from "./nav.tsx";

export interface DashboardShellProps {
  header: React.ReactNode;
  groups: NavGroup[];
  sidebarLabel: string;
  children: React.ReactNode;
  /** Site footer under the content (the AGPL source link must be on every page). */
  footer?: React.ReactNode;
}
export function DashboardShell({
  header,
  groups,
  sidebarLabel,
  children,
  footer,
}: DashboardShellProps): React.JSX.Element {
  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarContent>
          <NavGroups groups={groups} label={sidebarLabel} />
        </SidebarContent>
      </Sidebar>
      <div className="flex min-h-svh min-w-0 flex-1 flex-col">
        {header}
        <SidebarInset className="min-w-0 flex-1">{children}</SidebarInset>
        {footer}
      </div>
    </SidebarProvider>
  );
}
