// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { DashboardShell } from "./dashboard-shell.tsx";
import type { NavGroup } from "./nav.tsx";
export interface StudioShellProps {
  header: React.ReactNode;
  groups: NavGroup[];
  sidebarLabel: string;
  skipLabel: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /**
   * The LiveStatusBar (overhaul D5.2), first in `main` on every studio page. It brings its own
   * stickiness (under the 56 px header), so the page scrolls beneath it.
   */
  statusBar?: React.ReactNode;
}
export function StudioShell({ statusBar, children, ...props }: StudioShellProps): React.JSX.Element {
  return (
    <DashboardShell {...props}>
      {statusBar}
      {children}
    </DashboardShell>
  );
}
