// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { AppShell } from "./app-shell.tsx";
import { NavGroups, type NavGroup } from "./nav.tsx";

export interface DashboardShellProps {
  header: React.ReactNode;
  groups: NavGroup[];
  sidebarLabel: string;
  /** Skip link text (every shell has one). */
  skipLabel: string;
  children: React.ReactNode;
  /** Site footer, outside `main` (the AGPL source link must be on every page). */
  footer?: React.ReactNode;
}

/** Studio and admin chrome: the AppShell with a nav sidebar, so all shells share one structure. */
export function DashboardShell({
  header,
  groups,
  sidebarLabel,
  skipLabel,
  children,
  footer,
}: DashboardShellProps): React.JSX.Element {
  return (
    <AppShell
      header={header}
      sidebar={<NavGroups groups={groups} label={sidebarLabel} />}
      footer={footer}
      skipLabel={skipLabel}
    >
      {children}
    </AppShell>
  );
}
