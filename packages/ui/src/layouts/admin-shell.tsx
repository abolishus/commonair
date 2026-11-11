// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { cn } from "@commonair/ui/lib/utils";
import { DashboardShell } from "./dashboard-shell.tsx";
import type { NavGroup, NavItem } from "./nav.tsx";
export interface AdminShellProps {
  header: React.ReactNode;
  groups: NavGroup[];
  /** Overhaul wave 4 (D7.5): the `/admin` home, at the top of every role's nav, above the groups. */
  overview?: NavItem;
  sidebarLabel: string;
  skipLabel: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}
export function AdminShell({ overview, groups, ...props }: AdminShellProps): React.JSX.Element {
  return <DashboardShell {...props} groups={overview ? [{ id: "overview", items: [overview] }, ...groups] : groups} />;
}

export interface AdminPageProps extends React.ComponentProps<"div"> {
  /**
   * The admin width rule (overhaul wave 4, D7.5, as in the studio): `queue` for queues and tables
   * (1120 px), `form` for forms (768 px), `full` for full-bleed boards (1600 px). Every admin page
   * uses one.
   */
  width: "queue" | "form" | "full";
}
/** An admin page's container, so every page follows the width rule. */
export function AdminPage({ width, className, ...props }: AdminPageProps): React.JSX.Element {
  const widths = { queue: "max-w-form-page", form: "max-w-form", full: "max-w-page" };
  return (
    <div
      data-slot="admin-page"
      data-width={width}
      className={cn("mx-auto flex w-full min-w-0 flex-col gap-6 px-4 py-8", widths[width], className)}
      {...props}
    />
  );
}
