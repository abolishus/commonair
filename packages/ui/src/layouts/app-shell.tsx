// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { Sidebar, SidebarContent, SidebarProvider } from "@commonair/ui/components/sidebar";
import { cn } from "@commonair/ui/lib/utils";

export interface AppShellProps extends React.ComponentProps<"div"> {
  header: React.ReactNode;
  /**
   * The left rail or section nav: collapsible to icons from `md`, a sheet below it. Rendered inside
   * the `SidebarProvider`, so it may call `useSidebar`; it brings its own landmark (a labelled `<nav>`).
   */
  sidebar?: React.ReactNode;
  /**
   * `below` (default, every area): the header spans the page and stays put, the sidebar starts
   * under it, so the logo sits in the same place on public, studio and admin pages. `beside` (the
   * sidebar the full height, the header to its right) is kept for embedders only.
   */
  sidebarPlacement?: "beside" | "below";
  footer?: React.ReactNode;
  /**
   * The phone's bottom tab bar (`BottomTabBar`), after the footer. Below `md` the page is padded by
   * its height (56 px) so the footer never hides under it.
   */
  bottomBar?: React.ReactNode;
  children: React.ReactNode;
  skipLabel: string;
  mainId?: string;
}

/**
 * The padding that keeps the page clear of a fixed bottom tab bar, below `md` only: its 56 px.
 * The safe-area inset joins it once the shell utilities land in globals.css (contract request).
 */
const BOTTOM_BAR_CLEARANCE = "max-md:pb-14";

export function AppShell({
  header,
  sidebar,
  sidebarPlacement = "below",
  footer,
  bottomBar,
  children,
  skipLabel,
  mainId = "main-content",
  className,
  ...props
}: AppShellProps): React.JSX.Element {
  // First in the tab order in every variant (WCAG 2.4.1): before the sidebar and the header.
  const skip = (
    <a
      href={`#${mainId}`}
      data-testid="skip-link"
      className="sr-only z-50 bg-background p-2 text-foreground focus:not-sr-only focus:fixed focus:top-2 focus:start-2 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background"
    >
      {skipLabel}
    </a>
  );
  const main = (
    <main id={mainId} tabIndex={-1} className="min-w-0 flex-1 outline-none">
      {children}
    </main>
  );
  const shellProps = { "data-bottom-bar": bottomBar ? "" : undefined, ...props };
  const clearance = bottomBar ? BOTTOM_BAR_CLEARANCE : undefined;
  if (sidebar && sidebarPlacement === "beside")
    return (
      <SidebarProvider>
        <div className={cn("flex min-h-svh w-full", clearance, className)} {...shellProps}>
          {skip}
          <Sidebar collapsible="icon">
            <SidebarContent>{sidebar}</SidebarContent>
          </Sidebar>
          <div className="flex min-h-svh min-w-0 flex-1 flex-col">
            {header}
            {main}
            {footer}
          </div>
        </div>
        {bottomBar}
      </SidebarProvider>
    );
  const top = (
    <div data-slot="app-shell-header" className="sticky top-0 z-20 w-full">
      {header}
    </div>
  );
  if (sidebar)
    return (
      <SidebarProvider className={cn("flex-col", clearance, className)} {...shellProps}>
        {skip}
        {top}
        <div className="flex min-w-0 flex-1">
          {/* Starts under the 56 px header, which stays put above it. */}
          <Sidebar collapsible="icon" className="top-14 h-auto">
            <SidebarContent>{sidebar}</SidebarContent>
          </Sidebar>
          <div className="flex min-w-0 flex-1 flex-col">
            {main}
            {footer}
          </div>
        </div>
        {bottomBar}
      </SidebarProvider>
    );
  return (
    <div className={cn("flex min-h-svh w-full flex-col", clearance, className)} {...shellProps}>
      {skip}
      {top}
      {main}
      {footer}
      {bottomBar}
    </div>
  );
}
