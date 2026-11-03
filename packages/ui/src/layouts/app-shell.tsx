// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { Sidebar, SidebarContent, SidebarProvider } from "@commonair/ui/components/sidebar";
import { cn } from "@commonair/ui/lib/utils";

export interface AppShellProps extends React.ComponentProps<"div"> {
  header: React.ReactNode;
  sidebar?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  skipLabel: string;
  mainId?: string;
}
export function AppShell({
  header,
  sidebar,
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
