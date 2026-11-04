// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { Sidebar, SidebarContent, SidebarProvider } from "@commonair/ui/components/sidebar";
import { cn } from "@commonair/ui/lib/utils";

export interface AppShellProps extends React.ComponentProps<"div"> {
  header: React.ReactNode;
  /**
   * The left rail (F7): collapsible to icons from `md`, hidden below it (put its content in the
   * header's mobile sheet instead). Rendered inside the `SidebarProvider`, so it may call `useSidebar`;
   * it brings its own landmark (a labelled `<nav>`).
   */
  sidebar?: React.ReactNode;
  /**
   * `beside` (default; the studio and admin shells): the sidebar runs the full height, the header
   * sits to its right. `below` (the public rail): the header spans the page and stays put, and the
   * rail starts under it, as on Twitch.
   */
  sidebarPlacement?: "beside" | "below";
  footer?: React.ReactNode;
  children: React.ReactNode;
  skipLabel: string;
  mainId?: string;
}
export function AppShell({
  header,
  sidebar,
  sidebarPlacement = "beside",
  footer,
  children,
  skipLabel,
  mainId = "main-content",
  className,
  ...props
}: AppShellProps): React.JSX.Element {
  // First in the tab order in both variants (WCAG 2.4.1): before the sidebar and the header.
  const skip = (
    <a
      href={`#${mainId}`}
      data-testid="skip-link"
      className="sr-only z-50 bg-background p-2 text-foreground focus:not-sr-only focus:fixed focus:top-2 focus:start-2 focus:ring-2 focus:ring-ring"
    >
      {skipLabel}
    </a>
  );
  if (sidebar && sidebarPlacement === "below")
    return (
      <SidebarProvider className={cn("flex-col", className)} {...props}>
        {skip}
        <div className="sticky top-0 z-20 w-full">{header}</div>
        <div className="flex min-w-0 flex-1">
          <Sidebar collapsible="icon" className="top-14 h-auto">
            <SidebarContent>{sidebar}</SidebarContent>
          </Sidebar>
          <div className="flex min-w-0 flex-1 flex-col">
            <main id={mainId} tabIndex={-1} className="min-w-0 flex-1 outline-none">
              {children}
            </main>
            {footer}
          </div>
        </div>
      </SidebarProvider>
    );
  return sidebar ? (
    <SidebarProvider>
      <div className={cn("flex min-h-svh w-full", className)} {...props}>
        {skip}
        <Sidebar collapsible="icon">
          <SidebarContent>{sidebar}</SidebarContent>
        </Sidebar>
        <div className="flex min-h-svh min-w-0 flex-1 flex-col">
          {header}
          <main id={mainId} tabIndex={-1} className="min-w-0 flex-1 outline-none">
            {children}
          </main>
          {footer}
        </div>
      </div>
    </SidebarProvider>
  ) : (
    <div className={cn("flex min-h-svh w-full flex-col", className)} {...props}>
      {skip}
      {header}
      <main id={mainId} tabIndex={-1} className="min-w-0 flex-1 outline-none">
        {children}
      </main>
      {footer}
    </div>
  );
}
